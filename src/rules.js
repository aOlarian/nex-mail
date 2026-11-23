'use strict'
/* MAP
 * §1 imports & constante                L11-L23
 * §2 validare reguli                    L24-L77
 * §3 evaluare                           L78-L161
 * §4 lot de actiuni                     L162-L188
 * §5 executie pe IMAP                   L189-L249
 * §6 export                             L250-L251
 */

// §1 imports & constante
const store = require('./store')
const localStore = require('./local-store')
const common = require('./api-common')
const { norm } = require('./detect')

const FIELDS = ['from', 'fromName', 'fromEmail', 'to', 'subject', 'body', 'any']
const OPS = ['contains', 'notContains', 'equals', 'startsWith', 'endsWith', 'wildcard']
const ACTIONS = ['delete', 'deleteForever', 'move', 'moveLocal', 'markRead', 'flag', 'category']
const TERMINAL = ['move', 'moveLocal', 'delete', 'deleteForever']
const MAX_RULES = 500
const BODY_RAW_MAX = 30 * 1024 * 1024

// §2 validare reguli
function cleanRule(r) {
  if (!r || typeof r !== 'object') throw common.httpError(400, 'Regula invalida')
  const conditions = (Array.isArray(r.conditions) ? r.conditions : [])
    .filter((c) => c && FIELDS.includes(c.field) && OPS.includes(c.op))
    .map((c) => ({ field: c.field, op: c.op, value: common.str(c.value, 500) }))
  const actions = (Array.isArray(r.actions) ? r.actions : [])
    .filter((a) => a && ACTIONS.includes(a.type))
    .map((a) => ({ type: a.type, value: a.value === undefined || a.value === null ? null : common.str(String(a.value), 1000) }))
  for (const a of actions) {
    if ((a.type === 'move' || a.type === 'moveLocal' || a.type === 'category') && !a.value) throw common.httpError(400, `Action "${a.type}" requires a value`)
  }
  return {
    id: typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(r.id) ? r.id : store.newId('r'),
    name: common.str(r.name, 120).trim() || 'Rule',
    enabled: r.enabled !== false,
    account: typeof r.account === 'string' && r.account ? r.account.slice(0, 40) : '*',
    match: r.match === 'any' ? 'any' : 'all',
    conditions,
    actions,
    stop: !!r.stop,
  }
}

function ruleKey(r) {
  const normWild = (c) => norm(String(c.value || '').replace(/\^\=/g, '*')).trim()
  const conds = (r.conditions || []).map((c) => `${c.field}|${c.op}|${normWild(c)}`).sort().join('&&')
  const acts = (r.actions || []).map((a) => `${a.type}|${a.value == null ? '' : String(a.value).trim()}`).join('&&')
  return `${r.account || '*'}::${r.match === 'any' ? 'any' : 'all'}::${conds}::${acts}`
}

function cleanRules(list) {
  if (!Array.isArray(list)) throw common.httpError(400, 'Lipseste lista de reguli')
  if (list.length > MAX_RULES) throw common.httpError(400, 'Prea multe reguli')
  const seen = new Set()
  const seenKeys = new Set()
  const out = []
  for (const r of list) {
    const c = cleanRule(r)
    if (seen.has(c.id)) c.id = store.newId('r')
    seen.add(c.id)
    const k = ruleKey(c)
    if (seenKeys.has(k)) continue
    seenKeys.add(k)
    out.push(c)
  }
  return out
}

/** Corpul se descarca doar daca vreo regula activa se uita la el. */
function needsBody(rules) {
  return rules.some((r) => r.enabled && r.conditions.some((c) => c.field === 'body' || c.field === 'any'))
}

// §3 evaluare
function fmtAddrs(list) {
  return (list || []).map((a) => `${a.name || ''} <${a.address || ''}>`).join(', ')
}

/** msg = { subject, from:[{name,address}], to, cc, body }. */
function fieldText(msg, field) {
  switch (field) {
    case 'from':
      return fmtAddrs(msg.from)
    case 'fromName':
      return (msg.from || []).map((a) => a.name || '').join(', ')
    case 'fromEmail':
      return (msg.from || []).map((a) => a.address || '').join(', ')
    case 'to':
      return fmtAddrs([...(msg.to || []), ...(msg.cc || [])])
    case 'subject':
      return msg.subject || ''
    case 'body':
      return msg.body || ''
    default:
      return [msg.subject || '', fmtAddrs(msg.from), fmtAddrs([...(msg.to || []), ...(msg.cc || [])]), msg.body || ''].join('\n')
  }
}

function matchWildcard(text, rawPattern, field) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const raw = String(rawPattern || '').trim()
  const parts = raw.split(/\^\=|\*/g).map((p) => esc(norm(p)))
  if (!parts.some(Boolean)) return false
  const tail = field === 'fromEmail' && raw.includes('@') && !/[*^=]$/.test(raw) ? '(?=$|[\\s,])' : ''
  return new RegExp(parts.join('[\\s\\S]*') + tail).test(text)
}

function testCondition(c, msg, cacheNorm) {
  const v = c.op === 'wildcard' ? String(c.value || '').trim() : norm(c.value).trim()
  if (!v) return false // valoare goala ar potrivi tot: ignorata
  if (!cacheNorm[c.field]) cacheNorm[c.field] = norm(fieldText(msg, c.field))
  const t = cacheNorm[c.field]
  switch (c.op) {
    case 'contains':
      return t.includes(v)
    case 'notContains':
      return !t.includes(v)
    case 'equals':
      return t.trim() === v
    case 'startsWith':
      return t.trimStart().startsWith(v)
    case 'endsWith':
      return t.trimEnd().endsWith(v)
    case 'wildcard':
      return matchWildcard(t, v, c.field)
    default:
      return false
  }
}

function matches(rule, msg) {
  if (!rule.conditions.length) return false
  const cacheNorm = {}
  return rule.match === 'any' ? rule.conditions.some((c) => testCondition(c, msg, cacheNorm)) : rule.conditions.every((c) => testCondition(c, msg, cacheNorm))
}

/**
 * Rezultatul pentru un mesaj: categorii/flag/markRead se cumuleaza; dintre move/delete/deleteForever
 * se aplica doar prima intalnita. `stop` opreste evaluarea regulilor urmatoare.
 */
function evaluate(rules, msg, accountId) {
  const plan = { matched: [], categories: [], flag: false, markRead: false, terminal: null }
  for (const r of rules) {
    if (!r.enabled || (r.account !== '*' && r.account !== accountId)) continue
    if (!matches(r, msg)) continue
    plan.matched.push(r.id)
    for (const a of r.actions) {
      if (a.type === 'category' && !plan.categories.includes(a.value)) plan.categories.push(a.value)
      else if (a.type === 'flag') plan.flag = true
      else if (a.type === 'markRead') plan.markRead = true
      else if (TERMINAL.includes(a.type) && !plan.terminal) plan.terminal = { type: a.type, value: a.value }
    }
    if (r.stop) break
  }
  return plan
}

// §4 lot de actiuni
function newBatch() {
  return { seen: [], flagged: [], moves: new Map(), localMoves: new Map(), trash: [], expunge: [], categories: [], count: 0 }
}

/** Aduna planul unui mesaj in lot (executia se face grupat, pe folder). */
function addToBatch(batch, plan, msg) {
  if (!plan.matched.length) return
  if (plan.markRead) (batch.seen.push(msg.uid), batch.count++)
  if (plan.flag) (batch.flagged.push(msg.uid), batch.count++)
  if (plan.categories.length) {
    batch.categories.push({ msg, categories: plan.categories })
    batch.count += plan.categories.length
  }
  const t = plan.terminal
  if (!t) return
  batch.count++
  if (t.type === 'move') {
    if (!batch.moves.has(t.value)) batch.moves.set(t.value, [])
    batch.moves.get(t.value).push(msg.uid)
  } else if (t.type === 'moveLocal') {
    if (!batch.localMoves.has(t.value)) batch.localMoves.set(t.value, [])
    batch.localMoves.get(t.value).push(msg)
  } else if (t.type === 'delete') batch.trash.push(msg.uid)
  else batch.expunge.push(msg.uid)
}

// §5 executie pe IMAP
/**
 * Ruleaza lotul pe conexiunea `c`, cu folderul `folder` deja selectat (sub lacatul poolului).
 * Ordinea: flaguri si categorii, apoi mutari (IMAP si locale), apoi stergeri definitive.
 */
async function executeBatch(c, batch, ctx) {
  const { user, accountId, folder } = ctx
  if (batch.seen.length) await c.addFlags(batch.seen, ['\\Seen'])
  if (batch.flagged.length) await c.addFlags(batch.flagged, ['\\Flagged'])
  if (batch.categories.length) {
    const valid = new Set(store.getProfile(user).categories.map((x) => x.id))
    await store.update(user, 'meta.json', (meta) => {
      for (const { msg, categories } of batch.categories) {
        const key = common.metaKey(accountId, msg.messageId, folder, msg.uid)
        const m = meta[key] || { categories: [], task: null }
        for (const id of categories) if (valid.has(id) && !m.categories.includes(id)) m.categories.push(id)
        if (!m.categories.length && !m.task) continue
        Object.assign(m, { messageId: msg.messageId || null, folder, uid: msg.uid, subject: msg.subject || '', from: (msg.from || [])[0] || { name: '', address: '' }, date: msg.date || null })
        meta[key] = m
      }
    })
  }
  const destOf = new Map()
  for (const [localId, msgs] of batch.localMoves) {
    for (const m of msgs) {
      const raw = await c.fetchRaw(m.uid, BODY_RAW_MAX)
      await localStore.saveMessage(user, localId, {
        messageId: m.messageId || null,
        subject: m.subject || '',
        from: (m.from || [])[0] || { name: '', address: '' },
        to: m.to || [],
        date: m.date || null,
        seen: !!m.seen,
        flagged: !!m.flagged,
        hasAttachments: !!m.hasAttachments,
        preview: m.preview || '',
        sourceAccount: accountId,
        sourceFolder: folder,
      }, raw)
      batch.expunge.push(m.uid)
      destOf.set(m.uid, `${localStore.LOCAL_ACC}:${localId}`)
    }
  }
  for (const [dest, uids] of batch.moves) {
    if (dest === folder) continue
    await c.move(uids, dest)
    for (const u of uids) destOf.set(u, dest)
  }
  if (batch.trash.length) {
    const trashPath = await common.findSpecialOn(c, '\\Trash', 'Trash', user, accountId)
    if (trashPath === folder) batch.expunge.push(...batch.trash)
    else {
      await c.move(batch.trash, trashPath)
      for (const u of batch.trash) destOf.set(u, trashPath)
    }
  }
  if (batch.expunge.length) await c.expunge(batch.expunge)
  if (batch.count) common.invalidate(user, accountId)
  return destOf
}

// §6 export
module.exports = { cleanRule, cleanRules, ruleKey, needsBody, evaluate, matches, newBatch, addToBatch, executeBatch, fieldText }
