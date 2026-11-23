'use strict'
/* MAP
 * §1 imports & cache-uri                L12-L38
 * §2 Item din antete + meta             L39-L65
 * §3 lista (cautare, filtre)            L66-L127
 * §4 mesaj parsat (LRU)                 L128-L175
 * §5 HTML: curatare, cid, imagini       L176-L219
 * §6 rute mesaj/atasament/sursa         L220-L283
 * §7 export                             L284-L288
 */

// §1 imports & cache-uri
const store = require('./store')
const localStore = require('./local-store')
const pool = require('./pool')
const detect = require('./detect')
const common = require('./api-common')
const apiSearch = require('./api-search')
const { httpError, requireAccount, requireFolder, toUid, intIn, str, metaKey } = common

const MAX_RAW = 30 * 1024 * 1024
const LIST_MS = 10 * 1000
const LRU_MAX = 50
const ATTACH_SCAN = 2000 // filtrul „cu atasamente” cauta in ultimele N mesaje
const FILTERS = ['all', 'unread', 'flagged', 'attachments', 'task']

const listCache = new Map() // `${user}|${acc}|${folder}|...` → { at, uids }
const lru = new Map() // user → Map(cheie → parsed)

common.onInvalidate((user, acc, folder) => {
  const prefix = acc ? `${user}|${acc}|${folder ? folder + '|' : ''}` : `${user}|`
  for (const k of listCache.keys()) if (k.startsWith(prefix)) listCache.delete(k)
  // Cache-ul de mesaje parsate e imuabil per uid; se goleste doar la cont sters/modificat.
  if (acc && !folder && lru.has(user)) {
    for (const k of lru.get(user).keys()) if (k.startsWith(acc + '|')) lru.get(user).delete(k)
  }
})

// §2 Item din antete + meta
function addr(a) {
  return { name: (a && a.name) || '', address: (a && a.address) || '' }
}

function toItem(h, meta, accountId, folder) {
  const env = h.envelope || {}
  const flags = h.flags || []
  const m = meta[metaKey(accountId, env.messageId, folder, h.uid)] || null
  return {
    uid: h.uid,
    messageId: env.messageId || null,
    subject: env.subject || '',
    from: addr((env.from || [])[0]),
    to: (env.to || []).map(addr),
    date: env.date || h.internalDate || null,
    seen: flags.includes('\\Seen'),
    flagged: flags.includes('\\Flagged'),
    answered: flags.includes('\\Answered'),
    hasAttachments: !!h.hasAttachments,
    size: h.size || 0,
    preview: h.preview || '',
    categories: (m && m.categories) || [],
    task: m && m.task ? { due: m.task.due || null, done: !!m.task.done } : null,
  }
}

// §3 lista (cautare, filtre)
function taskUids(user, accountId, folder) {
  const out = new Set()
  for (const [k, m] of Object.entries(store.read(user, 'meta.json'))) {
    if (k.startsWith(accountId + '|') && m.task && !m.task.done && m.folder === folder && m.uid) out.add(m.uid)
  }
  return out
}

async function computeUids(c, user, accountId, folder, filter, q, inBody) {
  const base = {}
  if (filter === 'unread') base.unseen = true
  if (filter === 'flagged') base.flagged = true
  let uids
  if (q) {
    uids = await c.search({ ...base, text: q })
    if (inBody) uids = [...new Set([...uids, ...(await c.search({ ...base, body: q }))])]
  } else {
    uids = await c.search(Object.keys(base).length ? base : 'ALL')
  }
  if (filter === 'task') {
    const set = taskUids(user, accountId, folder)
    uids = uids.filter((u) => set.has(u))
  }
  uids = uids.slice().sort((a, b) => b - a)
  if (filter === 'attachments') {
    const scan = uids.slice(0, ATTACH_SCAN)
    const keep = new Set()
    for (let i = 0; i < scan.length; i += 500) {
      for (const h of await c.fetchHeaders(scan.slice(i, i + 500), { preview: false })) if (h.hasAttachments) keep.add(h.uid)
    }
    uids = scan.filter((u) => keep.has(u))
  }
  return uids
}

async function listMessages({ user, query }) {
  const needsSearch = query.account === localStore.LOCAL_ACC || query.account === apiSearch.ALL_INBOXES_ACC || (query.scope && query.scope !== 'folder') || query.filters || query.categories || (query.sortBy && query.sortBy !== 'date') || query.sortDir === 'asc'
  if (needsSearch) return apiSearch.searchMessages({ user, query })
  const acc = requireAccount(user, query.account)
  const folder = requireFolder(query.folder)
  const filter = FILTERS.includes(query.filter) ? query.filter : 'all'
  const q = str(query.q, 300).trim()
  const inBody = query.inBody === '1' || query.inBody === 'true'
  const page = intIn(query.page, 0, 0, 1000000)
  const size = intIn(query.size, store.getProfile(user).settings.pageSize, 1, 200)
  return pool.withFolder(user, acc.id, folder, async (c, info) => {
    const key = `${user}|${acc.id}|${folder}|${info.uidvalidity || ''}|${filter}|${inBody ? 1 : 0}|${q}`
    let hit = listCache.get(key)
    // Lista de uid-uri e reutilizata 10 s (paginare rapida); expira mai devreme la orice modificare.
    if (!hit || Date.now() - hit.at > LIST_MS) {
      hit = { at: Date.now(), uids: await computeUids(c, user, acc.id, folder, filter, q, inBody) }
      listCache.set(key, hit)
    }
    const pageUids = hit.uids.slice(page * size, (page + 1) * size)
    const headers = pageUids.length ? await c.fetchHeaders(pageUids) : []
    const meta = store.read(user, 'meta.json')
    const items = headers.sort((a, b) => b.uid - a.uid).map((h) => toItem(h, meta, acc.id, folder))
    return { total: hit.uids.length, page, size, items }
  })
}

// §4 mesaj parsat (LRU)
function lruFor(user) {
  if (!lru.has(user)) lru.set(user, new Map())
  return lru.get(user)
}

/** { header, parsed } pentru un uid; parsarea ramane in cache (mesajul nu se schimba sub acelasi uid). */
async function loadMessage(user, accountId, folder, uid, opts = {}) {
  if (accountId === localStore.LOCAL_ACC) {
    const raw = await localStore.loadRaw(user, folder, uid)
    return { header: opts.header === false ? null : localStore.getItem(user, folder, uid), parsed: common.proto('mime').parse(raw) }
  }
  return pool.withFolder(user, accountId, folder, async (c, info) => {
    let header = null
    if (opts.header !== false) {
      header = (await c.fetchHeaders([uid])).find((h) => h.uid === uid)
      if (!header) throw httpError(404, 'Mesajul nu mai exista (poate a fost mutat)')
    }
    const cache = lruFor(user)
    const key = `${accountId}|${folder}|${info.uidvalidity || ''}|${uid}`
    let parsed = cache.get(key)
    if (parsed) {
      cache.delete(key)
    } else {
      const raw = await c.fetchRaw(uid, MAX_RAW)
      if (!raw || !raw.length) throw httpError(404, 'Mesajul nu mai exista (poate a fost mutat)')
      parsed = common.proto('mime').parse(raw)
    }
    cache.set(key, parsed)
    while (cache.size > LRU_MAX) cache.delete(cache.keys().next().value)
    return { header, parsed }
  })
}

function icsEvents(parsed) {
  const out = []
  for (const text of parsed.calendar || []) {
    try {
      const ics = common.proto('ics').parseIcs(text)
      for (const ev of ics.events || []) out.push({ ...ev, method: ics.method || null })
    } catch (err) {
      if (err.status) throw err
      console.error('[mail] ICS ilizibil:', err.name)
    }
  }
  return out
}

// §5 HTML: curatare, cid, imagini
/** Strat suplimentar (UI-ul il pune oricum in iframe sandbox): fara <script>, on*=, javascript:. Liniar. */
function sanitizeHtml(html) {
  const noScript = String(html).replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<\/?script\b[^>]*>/gi, '')
  let out = ''
  let i = 0
  while (i < noScript.length) {
    const lt = noScript.indexOf('<', i)
    if (lt < 0) break
    const gt = noScript.indexOf('>', lt)
    if (gt < 0) break
    out += noScript.slice(i, lt)
    const tag = noScript.slice(lt, gt + 1)
    out += tag.replace(/\s+on[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, 'blocked:')
    i = gt + 1
  }
  return out + noScript.slice(i)
}

function attachmentUrl(accountId, folder, uid, part, inline) {
  const q = [`account=${encodeURIComponent(accountId)}`, `folder=${encodeURIComponent(folder)}`, `uid=${uid}`, `part=${encodeURIComponent(part)}`]
  if (inline) q.push('inline=1')
  return '/api/mail/attachment?' + q.join('&')
}

function rewriteCid(html, attachments, accountId, folder, uid) {
  const byCid = new Map()
  for (const a of attachments || []) if (a.contentId) byCid.set(common.normId(a.contentId).toLowerCase(), a)
  return html.replace(/cid:([^"'\s)>]+)/gi, (m, id) => {
    let key = id
    try {
      key = decodeURIComponent(id)
    } catch (err) {
      key = id // cid cu % invalid: il cautam asa cum e
    }
    const a = byCid.get(common.normId(key).toLowerCase())
    return a ? attachmentUrl(accountId, folder, uid, a.id, true).replace(/&/g, '&amp;') : m
  })
}

function hasRemoteImages(html) {
  return /\b(src|srcset|background|poster)\s*=\s*["']?\s*(https?:)?\/\//i.test(html) || /url\(\s*["']?\s*(https?:)?\/\//i.test(html)
}

// §6 rute mesaj/atasament/sursa
function params(user, query) {
  const isLocal = query.account === localStore.LOCAL_ACC
  return { acc: isLocal ? { id: localStore.LOCAL_ACC } : requireAccount(user, query.account), folder: requireFolder(query.folder), uid: toUid(query.uid), isLocal }
}

async function loadAny(user, { acc, folder, uid, isLocal }, opts = {}) {
  if (!isLocal) return loadMessage(user, acc.id, folder, uid, opts)
  const item = opts.header === false ? null : localStore.getItem(user, folder, uid)
  const raw = await localStore.loadRaw(user, folder, uid)
  return { header: null, item, parsed: common.proto('mime').parse(raw) }
}

async function getMessage({ user, query }) {
  const p = params(user, query)
  const { header, item: localItem, parsed } = await loadAny(user, p)
  const item = localItem || toItem(header, store.read(user, 'meta.json'), p.acc.id, p.folder)
  const env = (header && header.envelope) || {}
  const html = parsed.html ? rewriteCid(sanitizeHtml(parsed.html), parsed.attachments, p.acc.id, p.folder, p.uid) : null
  return {
    ...item,
    messageId: item.messageId || parsed.messageId || null,
    cc: (parsed.cc || env.cc || []).map(addr),
    replyTo: (parsed.replyTo || env.replyTo || []).map(addr),
    references: parsed.references || [],
    inReplyTo: parsed.inReplyTo || env.inReplyTo || null,
    html,
    text: parsed.text || null,
    attachments: (parsed.attachments || []).map((a) => ({ id: a.id, filename: a.filename || 'attachment', contentType: a.contentType || 'application/octet-stream', size: a.size || (a.content ? a.content.length : 0), inline: !!a.inline, contentId: a.contentId || null })),
    events: icsEvents(parsed),
    suggestions: detect.detect({ subject: parsed.subject || item.subject, text: parsed.text, html: parsed.html, headers: parsed.headers }),
    hasRemoteImages: html ? hasRemoteImages(html) : false,
  }
}

function contentDisposition(kind, filename) {
  const name = String(filename || 'attachment').replace(/[\r\n"\\]/g, '_')
  const ascii = name.normalize('NFD').replace(/[^\x20-\x7e]/g, '_')
  const star = encodeURIComponent(name).replace(/['()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase())
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${star}`
}

async function getAttachment({ user, query, res }) {
  const p = params(user, query)
  const part = str(query.part, 50)
  const { parsed } = await loadAny(user, p, { header: false })
  const a = (parsed.attachments || []).find((x) => String(x.id) === part)
  if (!a || !a.content) throw httpError(404, 'Attachment not found')
  const type = String(a.contentType || 'application/octet-stream').split(';')[0].trim().toLowerCase() || 'application/octet-stream'
  const active = /html|svg|xml|javascript/.test(type)
  const headers = { 'content-type': type, 'content-length': a.content.length, 'content-disposition': contentDisposition(query.inline === '1' && !active ? 'inline' : 'attachment', a.filename), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  if (active) headers['content-security-policy'] = "sandbox; default-src 'none'"
  res.writeHead(200, headers)
  res.end(a.content)
}

async function getSource({ user, query, res }) {
  const { acc, folder, uid, isLocal } = params(user, query)
  const raw = isLocal ? await localStore.loadRaw(user, folder, uid) : await pool.withFolder(user, acc.id, folder, (c) => c.fetchRaw(uid, MAX_RAW))
  if (!raw || !raw.length) throw httpError(404, 'Message not found')
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': raw.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(raw)
}

// §7 export
module.exports = {
  toItem, loadMessage, icsEvents, sanitizeHtml, rewriteCid, hasRemoteImages, attachmentUrl,
  routes: { 'GET messages': listMessages, 'GET message': getMessage, 'GET attachment': getAttachment, 'GET source': getSource },
}
