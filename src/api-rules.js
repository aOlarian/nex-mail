'use strict'
/* MAP
 * §1 imports & constante                L10-L20
 * §2 mesaj pentru reguli                L21-L55
 * §3 lista, salvare, quick              L56-L127
 * §4 rules/run (folder sau global)      L128-L210
 * §5 rute                               L211-L221
 */

// §1 imports & constante
const store = require('./store')
const localStore = require('./local-store')
const pool = require('./pool')
const rules = require('./rules')
const detect = require('./detect')
const common = require('./api-common')
const { httpError, requireAccount, requireFolder, intIn, str } = common

const BODY_MAX = 2 * 1024 * 1024

// §2 mesaj pentru reguli
/** Mesajul in forma asteptata de motor; corpul doar daca a fost descarcat. */
function ruleMsg(h, parsed) {
  const env = h.envelope || {}
  const flags = h.flags || []
  let body = ''
  if (parsed) body = parsed.text || detect.htmlToText(parsed.html || '')
  return {
    uid: h.uid,
    messageId: env.messageId || (parsed && parsed.messageId) || null,
    subject: env.subject || (parsed && parsed.subject) || '',
    from: env.from || (parsed && parsed.from) || [],
    to: env.to || [],
    cc: env.cc || [],
    date: env.date || h.internalDate || null,
    seen: flags.includes('\\Seen'),
    flagged: flags.includes('\\Flagged'),
    hasAttachments: !!h.hasAttachments,
    preview: h.preview || '',
    body,
  }
}

/** Corpul unui mesaj (max 2 MB) pentru conditiile body/any; mesaj ilizibil = corp gol, nu oprim lotul. */
async function fetchParsed(c, uid) {
  try {
    const raw = await c.fetchRaw(uid, BODY_MAX)
    return raw && raw.length ? common.proto('mime').parse(raw) : null
  } catch (err) {
    if (err.status || err.code) throw err
    console.error('[mail] parsare esuata pentru reguli:', err.name)
    return null
  }
}

// §3 lista, salvare, quick
function getRules({ user }) {
  return { rules: store.getProfile(user).rules }
}

async function postRules({ user, body }) {
  return store.setProfile(user, 'rules', rules.cleanRules(body.rules))
}

async function postQuick({ user, body }) {
  const value = str(body.value, 500).trim()
  if (!value) throw httpError(400, 'Missing filter value')
  const action = ['move', 'moveLocal', 'delete', 'deleteForever'].includes(body.action) ? body.action : null
  if (!action) throw httpError(400, 'Invalid action')
  let dest = body.dest ? str(body.dest, 1000) : null
  if (action === 'moveLocal' && body.createFolderName) {
    const f = await localStore.createFolder(user, str(body.createFolderName, 60))
    dest = f.id
  }
  if ((action === 'move' || action === 'moveLocal') && !dest) throw httpError(400, 'Choose destination folder')
  let condition
  let name
  if (body.kind === 'custom') {
    if (body.field === 'domain') {
      const domain = value.replace(/^.*@/, '').trim().toLowerCase()
      if (!domain) throw httpError(400, 'Missing domain')
      condition = { field: 'fromEmail', op: 'wildcard', value: '*@' + domain }
      name = str(body.name, 120).trim() || `Domain: *@${domain}`
    } else {
      const field = ['from', 'fromName', 'fromEmail', 'subject', 'body', 'to', 'any'].includes(body.field) ? body.field : 'subject'
      const op = ['contains', 'equals', 'startsWith', 'endsWith', 'wildcard'].includes(body.op) ? body.op : 'wildcard'
      condition = { field, op, value }
      name = str(body.name, 120).trim() || `Filter ${field}: ${value.slice(0, 40)}`
    }
  } else if (body.kind === 'blockSender' || body.kind === 'quickSender') {
    condition = { field: body.field === 'fromEmail' ? 'fromEmail' : 'from', op: 'contains', value }
    name = `Sender: ${value}`
  } else if (body.kind === 'blockDomain' || body.kind === 'quickDomain') {
    const domain = value.replace(/^.*@/, '').trim().toLowerCase()
    if (!domain) throw httpError(400, 'Missing domain')
    condition = body.kind === 'quickDomain'
      ? { field: 'fromEmail', op: 'wildcard', value: '*@' + domain }
      : { field: 'from', op: 'contains', value: '@' + domain }
    name = body.kind === 'blockDomain' ? `Block domain ${domain}` : `Domain: *@${domain}`
  } else if (body.kind === 'subjectContains' || body.kind === 'quickSubject') {
    condition = { field: 'subject', op: 'contains', value }
    name = `Subject: ${value}`
  } else {
    throw httpError(400, 'Invalid quick rule type')
  }
  const rule = rules.cleanRule({
    name,
    enabled: true,
    account: '*',
    match: 'all',
    conditions: [condition],
    actions: [{ type: action, value: action === 'move' || action === 'moveLocal' ? dest : null }],
    stop: true,
  })
  const list = store.getProfile(user).rules
  const key = rules.ruleKey(rule)
  const dup = list.find((r) => rules.ruleKey(r) === key)
  if (dup) {
    if (!dup.enabled) {
      await store.setProfile(user, 'rules', list.map((r) => (r.id === dup.id ? { ...r, enabled: true } : r)))
    }
    return { ...dup, enabled: true, duplicate: true }
  }
  await store.setProfile(user, 'rules', [...list, rule])
  return rule
}

// §4 rules/run (folder sau global)
async function runFolder(user, accountId, folder, active, limit, withBody) {
  return pool.withFolder(user, accountId, folder, async (c) => {
    const uids = (await c.search('ALL')).sort((a, b) => b - a).slice(0, limit)
    const batch = rules.newBatch()
    let checked = 0
    let matched = 0
    for (let i = 0; i < uids.length; i += 100) {
      const headers = await c.fetchHeaders(uids.slice(i, i + 100), { preview: false })
      for (const h of headers) {
        const parsed = withBody ? await fetchParsed(c, h.uid) : null
        const msg = ruleMsg(h, parsed)
        const plan = rules.evaluate(active, msg, accountId)
        checked++
        if (!plan.matched.length) continue
        matched++
        rules.addToBatch(batch, plan, { ...msg, body: '' })
      }
    }
    await rules.executeBatch(c, batch, { user, accountId, folder })
    return { checked, matched, actions: batch.count }
  })
}

async function mapPool(list, limit, fn) {
  let idx = 0
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (idx < list.length) await fn(list[idx++])
  }))
}

async function postRun({ user, body }) {
  const b = body || {}
  const limit = intIn(b.limit, 500, 1, 5000)
  let active = store.getProfile(user).rules
  if (b.ruleId) {
    const one = active.find((r) => r.id === b.ruleId)
    if (!one) throw httpError(404, 'Rule not found')
    active = [{ ...one, enabled: true }]
  } else if (Array.isArray(b.ruleIds) && b.ruleIds.length) {
    const set = new Set(b.ruleIds.map((x) => str(x, 60)))
    active = active.filter((r) => set.has(r.id)).map((r) => ({ ...r, enabled: true }))
    if (!active.length) throw httpError(404, 'Rule not found')
  } else {
    active = active.filter((r) => r.enabled)
  }
  const withBody = rules.needsBody(active)
  if (!b.all && b.account && b.account !== '*' && b.folder) {
    const acc = requireAccount(user, b.account)
    const folder = requireFolder(b.folder)
    if (!active.length) return { checked: 0, matched: 0, actions: 0 }
    const res = await runFolder(user, acc.id, folder, active, limit, withBody)
    common.invalidate(user, acc.id)
    return res
  }
  if (!active.length) return { checked: 0, matched: 0, actions: 0, foldersScanned: 0, errors: [] }
  const accounts = store.read(user, 'accounts.json').accounts.filter((a) => a.password)
  const totals = { checked: 0, matched: 0, actions: 0, foldersScanned: 0, errors: [] }
  await mapPool(accounts, 8, async (acc) => {
    let folders
    try {
      folders = await pool.run(user, acc.id, (c) => c.list())
    } catch (err) {
      totals.errors.push({ account: acc.id, email: acc.email, error: common.humanError(err) })
      return
    }
    const selectable = folders.filter((f) => !(f.flags || []).some((x) => String(x).toLowerCase() === '\\noselect'))
    for (const f of selectable) {
      try {
        const res = await runFolder(user, acc.id, f.path, active, limit, withBody)
        totals.checked += res.checked
        totals.matched += res.matched
        totals.actions += res.actions
        totals.foldersScanned++
      } catch (err) {
        totals.errors.push({ account: acc.id, folder: f.path, error: common.humanError(err) })
      }
    }
    common.invalidate(user, acc.id)
  })
  return totals
}

// §5 rute
module.exports = {
  ruleMsg,
  fetchParsed,
  routes: {
    'GET rules': getRules,
    'POST rules': postRules,
    'POST rules/run': postRun,
    'POST rules/quick': postQuick,
  },
}
