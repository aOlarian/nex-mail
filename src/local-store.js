'use strict'
/* MAP
 * §1 imports & validare                 L11-L35
 * §2 index atomic & coada               L36-L80
 * §3 foldere globale de filtrare        L81-L130
 * §4 CRUD mesaje locale                 L131-L221
 * §5 actiuni batch (flag/meta/del/move) L222-L282
 * §6 export                             L283-L288
 */

// §1 imports & validare
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const store = require('./store')

const LOCAL_ACC = '__local__'
const FOLDER_ID_RE = /^[a-z0-9_-]{1,48}$/i
const queues = new Map()

function cleanId(id) {
  const s = String(id || '').trim()
  if (!FOLDER_ID_RE.test(s)) throw Object.assign(new Error('Invalid local folder id'), { status: 400 })
  return s
}

function folderDir(user, folderId) {
  return path.join(store.userDir(user), 'filtered', cleanId(folderId))
}

function emlPath(user, folderId, uid) {
  return path.join(folderDir(user, folderId), `${Number(uid)}.eml`)
}

// §2 index atomic & coada
function readIndexSync(user, folderId) {
  const file = path.join(folderDir(user, folderId), 'index.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw && Array.isArray(raw.items)) return { nextUid: Number(raw.nextUid) || 1, items: raw.items }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[mail] local filtered index error:', err.code || err.name)
  }
  return { nextUid: 1, items: [] }
}

async function writeAtomicFile(file, buf) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  await fsp.writeFile(tmp, buf, { mode: 0o600 })
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(tmp, file)
      return
    } catch (err) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        await fsp.unlink(tmp).catch(() => null)
        throw err
      }
      await new Promise((r) => setTimeout(r, 30 * (i + 1)))
    }
  }
}

function queueFolder(user, folderId, fn) {
  const id = cleanId(folderId)
  const key = `${user}|${id}`
  const prev = queues.get(key) || Promise.resolve()
  const next = prev.catch(() => null).then(async () => {
    const idx = readIndexSync(user, id)
    const out = await fn(idx, id)
    await writeAtomicFile(path.join(folderDir(user, id), 'index.json'), JSON.stringify(idx, null, 1))
    return out
  })
  queues.set(key, next)
  next.finally(() => queues.get(key) === next && queues.delete(key)).catch(() => null)
  return next
}

// §3 foldere globale de filtrare
function getFolders(user) {
  const list = store.getProfile(user).filteredFolders
  return list.map((f) => {
    const idx = readIndexSync(user, f.id)
    const unread = idx.items.reduce((n, m) => n + (m.seen ? 0 : 1), 0)
    return { ...f, total: idx.items.length, unread }
  })
}

function requireFolderDef(user, folderId) {
  const id = cleanId(folderId)
  const f = store.getProfile(user).filteredFolders.find((x) => x.id === id)
  if (!f) throw Object.assign(new Error('Filtered folder not found'), { status: 404 })
  return f
}

async function saveFolders(user, list) {
  if (!Array.isArray(list)) throw Object.assign(new Error('Invalid folder list'), { status: 400 })
  const seen = new Set()
  const clean = list.map((f) => {
    const name = String((f && f.name) || '').trim().slice(0, 60)
    if (!name) throw Object.assign(new Error('Folder name required'), { status: 400 })
    let id = f.id && FOLDER_ID_RE.test(f.id) ? f.id : store.newId('ff')
    if (seen.has(id)) id = store.newId('ff')
    seen.add(id)
    const out = { id, name, system: !!f.system }
    if (f.color && /^#[0-9a-f]{6}$/i.test(f.color)) out.color = f.color.toLowerCase()
    return out
  })
  await store.setProfile(user, 'filteredFolders', clean)
  return getFolders(user)
}

async function createFolder(user, name, color) {
  const n = String(name || '').trim().slice(0, 60)
  if (!n) throw Object.assign(new Error('Folder name required'), { status: 400 })
  const cur = store.getProfile(user).filteredFolders
  const exist = cur.find((f) => f.name.toLowerCase() === n.toLowerCase())
  if (exist) return exist
  const item = { id: store.newId('ff'), name: n, system: false }
  if (color && /^#[0-9a-f]{6}$/i.test(color)) item.color = color.toLowerCase()
  await store.setProfile(user, 'filteredFolders', [...cur, item])
  return item
}

async function removeFolderData(user, folderId) {
  await fsp.rm(folderDir(user, folderId), { recursive: true, force: true })
}

// §4 CRUD mesaje locale
function normItem(m, folderId) {
  return {
    uid: Number(m.uid), account: LOCAL_ACC, folder: folderId, local: true, messageId: m.messageId || null,
    subject: m.subject || '', from: m.from || { name: '', address: '' }, to: Array.isArray(m.to) ? m.to : [],
    date: m.date || m.filteredAt || new Date().toISOString(), seen: !!m.seen, flagged: !!m.flagged,
    answered: !!m.answered, hasAttachments: !!m.hasAttachments, size: Number(m.size) || 0, preview: m.preview || '',
    categories: Array.isArray(m.categories) ? m.categories : [], task: m.task || null,
    sourceAccount: m.sourceAccount || null, sourceFolder: m.sourceFolder || null, filteredAt: m.filteredAt || null,
  }
}

async function saveMessage(user, folderId, meta, rawBuffer) {
  requireFolderDef(user, folderId)
  const raw = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(String(rawBuffer || ''), 'utf8')
  return queueFolder(user, folderId, async (idx, id) => {
    if (meta.messageId) {
      const dup = idx.items.find((x) => x.messageId === meta.messageId && x.sourceAccount === (meta.sourceAccount || null))
      if (dup) return normItem(dup, id)
    }
    const uid = idx.nextUid++
    await writeAtomicFile(emlPath(user, id, uid), raw)
    const entry = normItem({ ...meta, uid, size: meta.size || raw.length, filteredAt: new Date().toISOString() }, id)
    idx.items.unshift(entry)
    return entry
  })
}

function matchFilters(it, opts) {
  const f = opts.filters || new Set()
  if ((opts.filter === 'unread' || f.has('unread')) && it.seen) return false
  if ((opts.filter === 'flagged' || f.has('flagged')) && !it.flagged) return false
  if ((opts.filter === 'attachments' || f.has('attachments')) && !it.hasAttachments) return false
  if ((opts.filter === 'task' || f.has('task')) && (!it.task || it.task.done)) return false
  if (opts.categories && opts.categories.length && !opts.categories.some((c) => it.categories.includes(c))) return false
  if (opts.q) {
    const q = opts.q.toLowerCase()
    const hay = [it.subject, it.from && it.from.name, it.from && it.from.address, it.preview].join('\n').toLowerCase()
    if (!hay.includes(q)) return false
  }
  return true
}

function compareItems(a, b, sortBy, sortDir) {
  const dir = sortDir === 'asc' ? 1 : -1
  let cmp = 0
  if (sortBy === 'subject') cmp = (a.subject || '').localeCompare(b.subject || '')
  else if (sortBy === 'from') cmp = ((a.from && (a.from.name || a.from.address)) || '').localeCompare((b.from && (b.from.name || b.from.address)) || '')
  else if (sortBy === 'to') cmp = ((a.to[0] && (a.to[0].name || a.to[0].address)) || '').localeCompare((b.to[0] && (b.to[0].name || b.to[0].address)) || '')
  else cmp = new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()
  return (cmp || (a.uid - b.uid)) * dir
}

function queryItems(user, folderId, opts = {}) {
  const ids = folderId === '*' ? getFolders(user).map((f) => f.id) : [requireFolderDef(user, folderId).id]
  const all = []
  for (const id of ids) {
    const idx = readIndexSync(user, id)
    for (const m of idx.items) {
      const it = normItem(m, id)
      if (matchFilters(it, opts)) all.push(it)
    }
  }
  all.sort((a, b) => compareItems(a, b, opts.sortBy || 'date', opts.sortDir || 'desc'))
  return all
}

function listMessages(user, folderId, opts = {}) {
  const all = queryItems(user, folderId, opts)
  const page = Number(opts.page) || 0
  const size = Number(opts.size) || 50
  return { total: all.length, page, size, items: all.slice(page * size, (page + 1) * size) }
}

async function loadRaw(user, folderId, uid) {
  requireFolderDef(user, folderId)
  try {
    return await fsp.readFile(emlPath(user, folderId, uid))
  } catch (err) {
    if (err.code === 'ENOENT') throw Object.assign(new Error('Message not found'), { status: 404 })
    throw err
  }
}

function getItem(user, folderId, uid) {
  const id = requireFolderDef(user, folderId).id
  const hit = readIndexSync(user, id).items.find((x) => Number(x.uid) === Number(uid))
  if (!hit) throw Object.assign(new Error('Message not found'), { status: 404 })
  return normItem(hit, id)
}

// §5 actiuni batch (flag/meta/del/move)
async function setFlags(user, folderId, uids, { seen, flagged }) {
  requireFolderDef(user, folderId)
  const set = new Set(uids.map(Number))
  return queueFolder(user, folderId, (idx) => {
    let n = 0
    for (const m of idx.items) {
      if (!set.has(Number(m.uid))) continue
      if (seen !== undefined) m.seen = !!seen
      if (flagged !== undefined) m.flagged = !!flagged
      n++
    }
    return n
  })
}

async function setMeta(user, folderId, uids, patch) {
  requireFolderDef(user, folderId)
  const set = new Set(uids.map(Number))
  return queueFolder(user, folderId, (idx) => {
    const out = []
    for (const m of idx.items) {
      if (!set.has(Number(m.uid))) continue
      if (patch.categories !== undefined) m.categories = patch.categories
      if (patch.task !== undefined) m.task = patch.task
      if (patch.flagged !== undefined) m.flagged = !!patch.flagged
      out.push(normItem(m, folderId))
    }
    return out
  })
}

async function deleteMessages(user, folderId, uids) {
  requireFolderDef(user, folderId)
  const set = new Set(uids.map(Number))
  const removed = await queueFolder(user, folderId, (idx) => {
    const keep = []
    const drop = []
    for (const m of idx.items) (set.has(Number(m.uid)) ? drop : keep).push(m)
    idx.items = keep
    return drop
  })
  for (const m of removed) await fsp.unlink(emlPath(user, folderId, m.uid)).catch(() => null)
  return removed.length
}

async function moveMessages(user, srcFolderId, destFolderId, uids) {
  requireFolderDef(user, srcFolderId)
  requireFolderDef(user, destFolderId)
  if (srcFolderId === destFolderId) return 0
  let moved = 0
  for (const uid of uids) {
    const item = getItem(user, srcFolderId, uid)
    const raw = await loadRaw(user, srcFolderId, uid)
    await saveMessage(user, destFolderId, item, raw)
    await deleteMessages(user, srcFolderId, [uid])
    moved++
  }
  return moved
}

// §6 export
module.exports = {
  LOCAL_ACC, getFolders, requireFolderDef, saveFolders, createFolder, removeFolderData,
  saveMessage, queryItems, listMessages, loadRaw, getItem, setFlags, setMeta, deleteMessages,
  moveMessages, compareItems,
}
