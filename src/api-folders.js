'use strict'
/* MAP
 * §1 imports & cache                    L10-L24
 * §2 listare + status + ordine          L25-L81
 * §3 creare, redenumire, mutare         L82-L160
 * §4 stergere, golire                   L161-L186
 * §5 rute                               L187-L199
 */

// §1 imports & cache
const pool = require('./pool')
const common = require('./api-common')
const { httpError, requireAccount, requireFolder, str } = common

const CACHE_MS = 30 * 1000
const cache = new Map() // `${user}|${account}` → { at, value }

common.onInvalidate((user, accountId) => {
  if (accountId) cache.delete(`${user}|${accountId}`)
  else for (const k of cache.keys()) if (k.startsWith(user + '|')) cache.delete(k)
})

const ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash']

// §2 listare + status + ordine
function rank(f) {
  if (f.path.toUpperCase() === 'INBOX') return 0
  const i = ORDER.indexOf(f.specialUse)
  return i >= 0 ? i : ORDER.length
}

function sortFolders(list) {
  return list.slice().sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, 'ro', { sensitivity: 'base' }))
}

/** Specialele ghicite dupa nume (cand serverul nu are SPECIAL-USE) raman marcate. */
function withGuessedSpecial(list) {
  const out = list.map((f) => ({ ...f }))
  for (const use of ORDER.slice(1)) {
    if (out.some((f) => f.specialUse === use)) continue
    const hit = common.findSpecialIn(out, use)
    if (hit && !hit.specialUse) hit.specialUse = use
  }
  for (const f of out) if (f.path.toUpperCase() === 'INBOX') f.specialUse = '\\Inbox'
  return out
}

async function loadFolders(user, accountId, fresh) {
  const key = `${user}|${accountId}`
  if (!fresh) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
  }
  const value = await pool.run(user, accountId, async (c) => {
    const list = withGuessedSpecial(await c.list())
    const folders = []
    // Serial pe aceeasi conexiune: STATUS-urile in paralel s-ar amesteca in coada.
    for (const f of list) {
      let st = { unseen: 0, messages: 0 }
      if (!f.noselect) {
        try {
          st = await c.status(f.path)
        } catch (err) {
          if (pool.isNetworkError(err, c)) throw err
          console.error('[mail] status folder esuat:', err.code || 'eroare')
        }
      }
      folders.push({ path: f.path, name: f.name, delimiter: f.delimiter, specialUse: f.specialUse || null, unseen: st.unseen || 0, total: st.messages || 0, noselect: !!f.noselect })
    }
    const delimiter = (list.find((f) => f.delimiter) || {}).delimiter || '/'
    return { delimiter, folders: sortFolders(folders) }
  })
  cache.set(key, { at: Date.now(), value })
  return value
}

async function getFolders({ user, query }) {
  requireAccount(user, query.account)
  return loadFolders(user, query.account, query.fresh === '1')
}

// §3 creare, redenumire, mutare
function cleanName(name, delimiter) {
  const n = str(name, 200).trim()
  if (!n || /[\r\n\0*%]/.test(n) || (delimiter && n.includes(delimiter))) throw httpError(400, 'Nume de folder invalid')
  return n
}

function parentOf(path, d) {
  const i = path.lastIndexOf(d)
  return i >= 0 ? path.slice(0, i) : ''
}

function leafOf(path, d) {
  const i = path.lastIndexOf(d)
  return i >= 0 ? path.slice(i + d.length) : path
}

/** Folderele pe care nu le redenumim/stergem: INBOX si specialele (reale sau ghicite). */
function assertMutable(info, path) {
  const f = info.folders.find((x) => x.path === path)
  if (!f) throw httpError(404, 'Folderul nu exista')
  if (path.toUpperCase() === 'INBOX' || f.specialUse) throw httpError(400, 'Folderele de sistem nu pot fi redenumite, mutate sau sterse')
  return f
}

async function mutate(user, accountId, fn) {
  try {
    return await pool.run(user, accountId, fn)
  } finally {
    pool.invalidateSelection(user, accountId)
    common.invalidate(user, accountId)
  }
}

async function createFolder({ user, body }) {
  requireAccount(user, body.account)
  const info = await loadFolders(user, body.account)
  const d = info.delimiter
  const parent = body.parent ? requireFolder(body.parent) : ''
  if (parent && !info.folders.some((f) => f.path === parent)) throw httpError(404, 'Folderul parinte nu exista')
  const path = (parent ? parent + d : '') + cleanName(body.name, d)
  if (info.folders.some((f) => f.path === path)) throw httpError(409, 'Exista deja un folder cu acest nume')
  await mutate(user, body.account, async (c) => {
    await c.create(path)
    await c.subscribe(path).catch((err) => console.error('[mail] subscribe esuat:', err.code || 'eroare'))
  })
  return { ok: true, path }
}

async function renameFolder({ user, body }) {
  requireAccount(user, body.account)
  const info = await loadFolders(user, body.account)
  const d = info.delimiter
  const old = requireFolder(body.path)
  assertMutable(info, old)
  const parent = parentOf(old, d)
  const path = (parent ? parent + d : '') + cleanName(body.name, d)
  if (path === old) return { ok: true, path }
  if (info.folders.some((f) => f.path === path)) throw httpError(409, 'Exista deja un folder cu acest nume')
  await mutate(user, body.account, (c) => c.rename(old, path))
  return { ok: true, path }
}

async function moveFolder({ user, body }) {
  requireAccount(user, body.account)
  const info = await loadFolders(user, body.account)
  const d = info.delimiter
  const old = requireFolder(body.path)
  assertMutable(info, old)
  const parent = body.parent ? requireFolder(body.parent) : ''
  if (parent && !info.folders.some((f) => f.path === parent)) throw httpError(404, 'Folderul parinte nu exista')
  if (parent === old || parent.startsWith(old + d)) throw httpError(400, 'Un folder nu poate fi mutat in el insusi')
  const path = (parent ? parent + d : '') + leafOf(old, d)
  if (path === old) return { ok: true, path }
  if (info.folders.some((f) => f.path === path)) throw httpError(409, 'Exista deja un folder cu acest nume la destinatie')
  await mutate(user, body.account, (c) => c.rename(old, path))
  return { ok: true, path }
}

// §4 stergere, golire
async function deleteFolder({ user, body }) {
  requireAccount(user, body.account)
  const info = await loadFolders(user, body.account)
  const path = requireFolder(body.path)
  assertMutable(info, path)
  await mutate(user, body.account, (c) => c.delete(path))
  return { ok: true }
}

async function emptyFolder({ user, body }) {
  requireAccount(user, body.account)
  const info = await loadFolders(user, body.account)
  const path = requireFolder(body.path)
  const f = info.folders.find((x) => x.path === path)
  if (!f) throw httpError(404, 'Folderul nu exista')
  if (f.specialUse !== '\\Trash' && f.specialUse !== '\\Junk') throw httpError(400, 'Doar Cosul si Nedoritele se pot goli')
  const removed = await pool.withFolder(user, body.account, path, async (c) => {
    const uids = await c.search('ALL')
    if (uids.length) await c.expunge(uids)
    return uids.length
  })
  common.invalidate(user, body.account, path)
  return { ok: true, removed }
}

// §5 rute
module.exports = {
  loadFolders,
  sortFolders,
  routes: {
    'GET folders': getFolders,
    'POST folders/create': createFolder,
    'POST folders/rename': renameFolder,
    'POST folders/move': moveFolder,
    'POST folders/delete': deleteFolder,
    'POST folders/empty': emptyFolder,
  },
}
