'use strict'
/* MAP
 * §1 imports & cache                    L10-L59
 * §2 optiuni & filtre                   L60-L117
 * §3 foldere tinta pe scope             L118-L176
 * §4 cautare multi-scope & flagged      L177-L241
 * §5 rute                               L242-L249
 */

// §1 imports & cache
const store = require('./store')
const localStore = require('./local-store')
const pool = require('./pool')
const common = require('./api-common')
const apiFolders = require('./api-folders')
const { requireAccount, requireFolder, intIn, str, metaKey } = common

const ALL_INBOXES_ACC = '__all_inboxes__'
const INBOX_EXCLUDE_SPECIAL = new Set(['\\Trash', '\\Junk', '\\Drafts', '\\Sent', '\\Archive'])
const SORTS = ['date', 'subject', 'from', 'to']
const CACHE_MS = 10 * 1000
const PER_FOLDER_MAX = 150
const SINGLE_SCAN_MAX = 1000
const SCAN_CONCURRENCY = 8
const searchCache = new Map()

common.onInvalidate((user) => {
  const prefix = `${user}|`
  for (const k of searchCache.keys()) if (k.startsWith(prefix)) searchCache.delete(k)
})

function addr(a) {
  return { name: (a && a.name) || '', address: (a && a.address) || '' }
}

function toSearchItem(h, meta, accountId, folder) {
  const env = h.envelope || {}
  const flags = h.flags || []
  const m = meta[metaKey(accountId, env.messageId, folder, h.uid)] || null
  return {
    uid: h.uid,
    account: accountId,
    folder,
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

// §2 optiuni & filtre
function parseOpts(user, query) {
  const isAllInboxes = query.account === ALL_INBOXES_ACC
  let scope = ['folder', 'mailbox', 'inboxes', 'sent', 'everywhere'].includes(query.scope) ? query.scope : 'folder'
  const q = str(query.q, 300).trim()
  if (isAllInboxes && (!q || scope === 'folder' || scope === 'mailbox')) scope = 'inboxes'
  const inboxesSubfolders = isAllInboxes ? (query.subfolders !== '0' && query.subfolders !== 'false') : (query.subfolders === '1' || query.subfolders === 'true')
  const filters = new Set(String(query.filters || '').split(',').map((s) => s.trim()).filter(Boolean))
  if (query.filter && query.filter !== 'all') filters.add(query.filter)
  const categories = String(query.categories || '').split(',').map((s) => s.trim()).filter(Boolean)
  const sortBy = SORTS.includes(query.sortBy) ? query.sortBy : 'date'
  const sortDir = query.sortDir === 'asc' ? 'asc' : 'desc'
  return {
    isAllInboxes,
    scope,
    inboxesSubfolders,
    sentName: str(query.sentName, 120).trim() || 'Sent',
    q,
    inBody: query.inBody === '1' || query.inBody === 'true',
    filters,
    categories,
    sortBy,
    sortDir,
    page: intIn(query.page, 0, 0, 1000000),
    size: intIn(query.size, store.getProfile(user).settings.pageSize, 1, 200),
  }
}

function itemMatches(it, opts) {
  if (opts.filters.has('unread') && it.seen) return false
  if (opts.filters.has('flagged') && !it.flagged) return false
  if (opts.filters.has('attachments') && !it.hasAttachments) return false
  if (opts.filters.has('task') && (!it.task || it.task.done)) return false
  if (opts.categories.length && !opts.categories.some((c) => it.categories.includes(c))) return false
  return true
}

function isSelectable(f) {
  return !(f.flags || []).some((x) => String(x).toLowerCase() === '\\noselect')
}

function matchSentFolder(f, sentName, sentPrefixes) {
  const target = sentName.toLowerCase()
  const p = String(f.path || '').toLowerCase()
  const name = String(f.name || '').toLowerCase()
  const delim = f.delimiter || '/'
  if (sentName.toLowerCase() === 'sent' && (f.specialUse === '\\Sent' || (f.flags || []).some((x) => String(x).toLowerCase() === '\\sent'))) {
    sentPrefixes.push(p + delim.toLowerCase())
    return true
  }
  const segs = p.split(delim.toLowerCase())
  if (name === target || segs.includes(target) || sentPrefixes.some((pref) => p.startsWith(pref))) {
    if (!sentPrefixes.includes(p + delim.toLowerCase())) sentPrefixes.push(p + delim.toLowerCase())
    return true
  }
  return false
}

// §3 foldere tinta pe scope
async function targetFolders(user, acc, opts) {
  if (opts.scope === 'inboxes') {
    if (!opts.inboxesSubfolders) return ['INBOX']
    const info = await apiFolders.loadFolders(user, acc.id)
    const delim = info.delimiter || '/'
    const pref = 'INBOX' + delim.toUpperCase()
    const matched = (info.folders || [])
      .filter((f) => !f.noselect && !INBOX_EXCLUDE_SPECIAL.has(f.specialUse) && (f.path.toUpperCase() === 'INBOX' || f.specialUse === '\\Inbox' || f.path.toUpperCase().startsWith(pref)))
      .map((f) => f.path)
    return matched.length ? matched : ['INBOX']
  }
  const list = await pool.run(user, acc.id, (c) => c.list())
  const selectable = list.filter(isSelectable)
  if (opts.scope === 'sent') {
    const prefixes = []
    const matched = []
    for (const f of selectable.sort((a, b) => a.path.length - b.path.length)) {
      if (matchSentFolder(f, opts.sentName, prefixes)) matched.push(f.path)
    }
    return matched
  }
  return selectable.map((f) => f.path)
}

async function scanImapFolder(user, accId, folder, opts, cap, meta) {
  return pool.withFolder(user, accId, folder, async (c) => {
    const base = {}
    if (opts.filters.has('unread')) base.unseen = true
    if (opts.filters.has('flagged')) base.flagged = true
    let uids
    if (opts.q) {
      uids = await c.search({ ...base, text: opts.q })
      if (opts.inBody) uids = [...new Set([...uids, ...(await c.search({ ...base, body: opts.q }))])]
    } else {
      uids = await c.search(Object.keys(base).length ? base : 'ALL')
    }
    const sliced = uids.slice().sort((a, b) => b - a).slice(0, cap)
    if (!sliced.length) return []
    const out = []
    for (let i = 0; i < sliced.length; i += 200) {
      const headers = await c.fetchHeaders(sliced.slice(i, i + 200))
      for (const h of headers) {
        const it = toSearchItem(h, meta, accId, folder)
        if (itemMatches(it, opts)) out.push(it)
      }
    }
    return out
  })
}

async function mapPool(list, limit, fn) {
  let idx = 0
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (idx < list.length) await fn(list[idx++])
  })
  await Promise.all(workers)
}

// §4 cautare multi-scope & flagged
async function collectScope(user, query, opts) {
  const meta = store.read(user, 'meta.json')
  const items = []
  const errors = []
  if (opts.scope === 'folder') {
    if (query.account === localStore.LOCAL_ACC) {
      return { items: localStore.queryItems(user, requireFolder(query.folder), opts), errors }
    }
    const acc = requireAccount(user, query.account)
    const folder = requireFolder(query.folder)
    items.push(...(await scanImapFolder(user, acc.id, folder, opts, SINGLE_SCAN_MAX, meta)))
    return { items, errors }
  }
  const excluded = opts.isAllInboxes ? new Set(store.getProfile(user).settings?.allInboxes?.excluded || []) : null
  const accounts = opts.scope === 'mailbox'
    ? [requireAccount(user, query.account)]
    : store.read(user, 'accounts.json').accounts.filter((a) => a.password && (!excluded || !excluded.has(a.id)))
  const cap = opts.scope === 'mailbox' ? 300 : PER_FOLDER_MAX
  await mapPool(accounts, SCAN_CONCURRENCY, async (acc) => {
    let folders
    try {
      folders = await targetFolders(user, acc, opts)
    } catch (err) {
      errors.push({ account: acc.id, error: common.humanError(err) })
      return
    }
    for (const folder of folders) {
      try {
        items.push(...(await scanImapFolder(user, acc.id, folder, opts, cap, meta)))
      } catch (err) {
        errors.push({ account: acc.id, folder, error: common.humanError(err) })
      }
    }
  })
  if (opts.scope === 'everywhere') {
    items.push(...localStore.queryItems(user, '*', opts))
  }
  return { items, errors }
}

async function searchMessages({ user, query }) {
  const opts = parseOpts(user, query)
  const exSig = opts.isAllInboxes ? (store.getProfile(user).settings?.allInboxes?.excluded || []).join(',') : ''
  const key = `${user}|search|${opts.scope}|${opts.inboxesSubfolders ? 1 : 0}|${exSig}|${query.account || ''}|${query.folder || ''}|${opts.sentName}|${[...opts.filters].sort().join(',')}|${opts.categories.join(',')}|${opts.inBody ? 1 : 0}|${opts.q}`
  let hit = searchCache.get(key)
  if (!hit || Date.now() - hit.at > CACHE_MS) {
    const res = await collectScope(user, query, opts)
    hit = { at: Date.now(), items: res.items, errors: res.errors }
    searchCache.set(key, hit)
  }
  const sorted = hit.items.slice().sort((a, b) => localStore.compareItems(a, b, opts.sortBy, opts.sortDir))
  const total = sorted.length
  const pageItems = sorted.slice(opts.page * opts.size, (opts.page + 1) * opts.size)
  return { total, page: opts.page, size: opts.size, scope: opts.scope, items: pageItems, errors: hit.errors }
}

async function getFlagged({ user, query }) {
  const res = await searchMessages({
    user,
    query: { scope: 'everywhere', filters: 'flagged', sortBy: 'date', sortDir: 'desc', page: '0', size: str(query && query.size, 10) || '100' },
  })
  return { items: res.items, total: res.total }
}

// §5 rute
module.exports = {
  ALL_INBOXES_ACC,
  searchMessages,
  routes: {
    'GET flagged': getFlagged,
  },
}
