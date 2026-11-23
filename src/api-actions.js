'use strict'
/* MAP
 * §1 imports & constante                L11-L20
 * §2 flaguri, mutare, metadate          L21-L134
 * §3 stergere, arhivare                 L135-L178
 * §4 categorii si taskuri (meta)        L179-L242
 * §5 liste: taskuri, contacte           L243-L265
 * §6 rute                               L266-L278
 */

// §1 imports & constante
const store = require('./store')
const localStore = require('./local-store')
const pool = require('./pool')
const detect = require('./detect')
const common = require('./api-common')
const { httpError, requireAccount, requireFolder, toUids, str, metaKey, normId } = common

const FLAGS = ['\\Seen', '\\Flagged', '\\Answered', '\\Deleted', '\\Draft']

// §2 flaguri, mutare, metadate
function cleanFlags(list) {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list) || list.some((f) => !FLAGS.includes(f))) throw httpError(400, 'Flag invalid')
  return list
}

async function postFlags({ user, body }) {
  const folder = requireFolder(body.folder)
  const uids = toUids(body.uids)
  const add = cleanFlags(body.add)
  const remove = cleanFlags(body.remove)
  if (body.account === localStore.LOCAL_ACC) {
    const seen = add.includes('\\Seen') ? true : remove.includes('\\Seen') ? false : undefined
    const flagged = add.includes('\\Flagged') ? true : remove.includes('\\Flagged') ? false : undefined
    await localStore.setFlags(user, folder, uids, { seen, flagged })
    common.invalidate(user)
    return { ok: true }
  }
  const acc = requireAccount(user, body.account)
  await pool.withFolder(user, acc.id, folder, async (c) => {
    if (add.length) await c.addFlags(uids, add)
    if (remove.length) await c.removeFlags(uids, remove)
  })
  common.invalidate(user, acc.id, folder)
  return { ok: true }
}

/** Dupa mutare uid-urile se schimba: taskurile isi cauta mesajul in destinatie dupa Message-ID. */
async function relocateMeta(user, accountId, folder, uids, dest) {
  const set = new Set(uids)
  const moved = Object.entries(store.read(user, 'meta.json')).filter(([k, m]) => k.startsWith(accountId + '|') && m.folder === folder && set.has(m.uid))
  if (!moved.length) return
  const found = {}
  try {
    await pool.withFolder(user, accountId, dest, async (c) => {
      for (const [k, m] of moved) {
        const id = normId(m.messageId)
        if (!id || /["\\\r\n]/.test(id)) continue
        const hit = await c.search(`HEADER Message-ID "<${id}>"`)
        if (hit.length) found[k] = Math.max(...hit)
      }
    })
  } catch (err) {
    console.error('[mail] relocare meta esuata:', err.code || err.name)
  }
  await store.update(user, 'meta.json', (meta) => {
    for (const [k] of moved) {
      if (!meta[k]) continue
      // Intrarile fara Message-ID erau legate de uid-ul vechi; nu le mai putem regasi.
      if (k.includes('|uid:')) delete meta[k]
      else Object.assign(meta[k], { folder: dest, uid: found[k] || null })
    }
  })
}

async function moveUids(user, accountId, folder, uids, dest) {
  if (dest === folder) return
  await pool.withFolder(user, accountId, folder, (c) => c.move(uids, dest))
  common.invalidate(user, accountId, folder)
  common.invalidate(user, accountId, dest)
  common.invalidate(user, accountId) // numaratorii de foldere
  await relocateMeta(user, accountId, folder, uids, dest)
}

async function postMove({ user, body }) {
  const folder = requireFolder(body.folder)
  const dest = requireFolder(body.dest)
  const uids = toUids(body.uids)
  if (body.account === localStore.LOCAL_ACC && body.destAccount === localStore.LOCAL_ACC) {
    await localStore.moveMessages(user, folder, dest, uids)
    common.invalidate(user)
    return { ok: true }
  }
  if (body.account === localStore.LOCAL_ACC) {
    const destAcc = requireAccount(user, body.destAccount || body.account)
    for (const uid of uids) {
      const it = localStore.getItem(user, folder, uid)
      const raw = await localStore.loadRaw(user, folder, uid)
      const flags = it.seen ? ['\\Seen'] : []
      if (it.flagged) flags.push('\\Flagged')
      await pool.run(user, destAcc.id, (c) => c.append(dest, raw, flags))
    }
    await localStore.deleteMessages(user, folder, uids)
    common.invalidate(user, destAcc.id, dest)
    common.invalidate(user)
    return { ok: true }
  }
  const acc = requireAccount(user, body.account)
  if (body.destAccount === localStore.LOCAL_ACC) {
    await pool.withFolder(user, acc.id, folder, async (c) => {
      const headers = await c.fetchHeaders(uids)
      for (const h of headers) {
        const raw = await c.fetchRaw(h.uid, 30 * 1024 * 1024)
        const env = h.envelope || {}
        const flags = h.flags || []
        await localStore.saveMessage(user, dest, {
          messageId: env.messageId || null, subject: env.subject || '', from: (env.from || [])[0] || { name: '', address: '' },
          to: env.to || [], date: env.date || h.internalDate || null, seen: flags.includes('\\Seen'),
          flagged: flags.includes('\\Flagged'), hasAttachments: !!h.hasAttachments, preview: h.preview || '',
          sourceAccount: acc.id, sourceFolder: folder,
        }, raw)
      }
      await c.expunge(uids)
    })
    await dropMeta(user, acc.id, folder, uids)
    common.invalidate(user, acc.id)
    common.invalidate(user)
    return { ok: true }
  }
  await moveUids(user, acc.id, folder, uids, dest)
  return { ok: true }
}

// §3 stergere, arhivare
async function dropMeta(user, accountId, folder, uids) {
  const set = new Set(uids)
  await store.update(user, 'meta.json', (meta) => {
    for (const [k, m] of Object.entries(meta)) if (k.startsWith(accountId + '|') && m.folder === folder && set.has(m.uid)) delete meta[k]
  })
}

async function postDelete({ user, body }) {
  const folder = requireFolder(body.folder)
  const uids = toUids(body.uids)
  if (body.account === localStore.LOCAL_ACC) {
    await localStore.deleteMessages(user, folder, uids)
    common.invalidate(user)
    return { ok: true, permanent: true }
  }
  const acc = requireAccount(user, body.account)
  const res = await pool.withFolder(user, acc.id, folder, async (c) => {
    const trash = common.findSpecialIn(await c.list(), '\\Trash')
    if (body.permanent === true || (trash && trash.path === folder)) {
      await c.expunge(uids)
      return { permanent: true }
    }
    return { dest: trash ? trash.path : await common.findSpecialOn(c, '\\Trash', 'Trash', user, acc.id) }
  })
  if (res.permanent) {
    common.invalidate(user, acc.id)
    await dropMeta(user, acc.id, folder, uids)
    return { ok: true, permanent: true }
  }
  await moveUids(user, acc.id, folder, uids, res.dest)
  return { ok: true, dest: res.dest }
}

async function postArchive({ user, body }) {
  const acc = requireAccount(user, body.account)
  const folder = requireFolder(body.folder)
  const uids = toUids(body.uids)
  const dest = await pool.run(user, acc.id, (c) => common.findSpecialOn(c, '\\Archive', 'Archive', user, acc.id))
  if (dest === folder) throw httpError(400, 'Mesajele sunt deja in Arhiva')
  await moveUids(user, acc.id, folder, uids, dest)
  return { ok: true, dest }
}

// §4 categorii si taskuri (meta)
function cleanTask(t, prev) {
  if (t === null) return null
  if (typeof t !== 'object') throw httpError(400, 'Task invalid')
  const due = t.due ? new Date(t.due) : null
  if (due && isNaN(due)) throw httpError(400, 'Termen invalid')
  return { due: due ? due.toISOString() : null, done: !!t.done, created: (prev && prev.created) || new Date().toISOString() }
}

function applyMeta(m, body, validCats) {
  let cats = Array.isArray(m.categories) ? m.categories.slice() : []
  if (Array.isArray(body.categories)) cats = body.categories.slice()
  if (body.addCategory && !cats.includes(body.addCategory)) cats.push(body.addCategory)
  if (body.removeCategory) cats = cats.filter((id) => id !== body.removeCategory)
  m.categories = cats.filter((id) => validCats.has(id))
  if ('task' in body) m.task = cleanTask(body.task, m.task)
}

async function postMeta({ user, body }) {
  const folder = requireFolder(body.folder)
  const uids = toUids(body.uids)
  const validCats = new Set(store.getProfile(user).categories.map((c) => c.id))
  for (const id of [body.addCategory, ...(Array.isArray(body.categories) ? body.categories : [])]) {
    if (id && !validCats.has(id)) throw httpError(400, 'Unknown category')
  }
  if ('task' in body) cleanTask(body.task, null)
  if (body.account === localStore.LOCAL_ACC) {
    for (const uid of uids) {
      const m = { categories: localStore.getItem(user, folder, uid).categories, task: localStore.getItem(user, folder, uid).task }
      applyMeta(m, body, validCats)
      await localStore.setMeta(user, folder, [uid], { categories: m.categories, task: m.task, ...('task' in body ? { flagged: !!body.task } : {}) })
    }
    common.invalidate(user)
    return { ok: true }
  }
  const acc = requireAccount(user, body.account)
  const headers = await pool.withFolder(user, acc.id, folder, async (c) => {
    const hs = await c.fetchHeaders(uids, { preview: false })
    // Task setat → steag pe server (vizibil si in alti clienti); task scos → steag scos.
    if ('task' in body) {
      if (body.task) await c.addFlags(uids, ['\\Flagged'])
      else await c.removeFlags(uids, ['\\Flagged'])
    }
    return hs
  })
  await store.update(user, 'meta.json', (meta) => {
    for (const h of headers) {
      const env = h.envelope || {}
      const key = metaKey(acc.id, env.messageId, folder, h.uid)
      const m = meta[key] || { categories: [], task: null }
      applyMeta(m, body, validCats)
      if (!m.categories.length && !m.task) {
        delete meta[key]
        continue
      }
      const from = (env.from || [])[0] || {}
      Object.assign(m, { messageId: env.messageId || null, folder, uid: h.uid, subject: env.subject || '', from: { name: from.name || '', address: from.address || '' }, date: env.date || h.internalDate || null })
      meta[key] = m
    }
  })
  common.invalidate(user, acc.id, folder)
  return { ok: true }
}

// §5 liste: taskuri, contacte
function getTasks({ user, query }) {
  const wantDone = query.done === '1' || query.done === 'true'
  const items = []
  for (const [k, m] of Object.entries(store.read(user, 'meta.json'))) {
    if (!m.task || !!m.task.done !== wantDone) continue
    items.push({ account: k.slice(0, k.indexOf('|')), folder: m.folder || null, uid: m.uid || null, messageId: m.messageId || null, subject: m.subject || '', from: m.from || { name: '', address: '' }, date: m.date || null, due: m.task.due || null, done: !!m.task.done, categories: m.categories || [] })
  }
  // Cu termen intai (cel mai apropiat), apoi cele mai noi.
  items.sort((a, b) => (a.due ? 0 : 1) - (b.due ? 0 : 1) || String(a.due).localeCompare(String(b.due)) || String(b.date).localeCompare(String(a.date)))
  return { items }
}

function getContacts({ user, query }) {
  const q = detect.norm(str(query.q, 100).trim())
  const items = store.read(user, 'contacts.json').items
    .filter((c) => !q || detect.norm(c.address).includes(q) || detect.norm(c.name).includes(q))
    .sort((a, b) => b.count - a.count || String(b.last).localeCompare(String(a.last)))
    .slice(0, 10)
    .map((c) => ({ name: c.name || '', address: c.address }))
  return { items }
}

// §6 rute
module.exports = {
  moveUids,
  routes: {
    'POST flags': postFlags,
    'POST move': postMove,
    'POST delete': postDelete,
    'POST archive': postArchive,
    'POST meta': postMeta,
    'GET tasks': getTasks,
    'GET contacts': getContacts,
  },
}
