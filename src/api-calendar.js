'use strict'
/* MAP
 * §1 imports & constante                L10-L19
 * §2 validare eveniment                 L20-L61
 * §3 adaugare fara duplicate            L62-L97
 * §4 rute CRUD + from-message           L98-L223
 * §5 export                             L224-L236
 */

// §1 imports & constante
const store = require('./store')
const { zonedToUtc } = require('./detect')
const common = require('./api-common')
const { httpError, requireAccount, requireFolder, toUid, str } = common

const STATUSES = ['confirmed', 'tentative', 'detected', 'invited']
const COLOR_RE = /^#[0-9a-f]{6}$/i
const MAX_EVENTS = 20000

// §2 validare eveniment
/** Data simpla (YYYY-MM-DD, ex. ICS VALUE=DATE) = miezul noptii la Bucuresti, ca la detectie. */
function isoOrNull(v) {
  if (!v) return null
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v))
  if (day) return new Date(zonedToUtc(+day[1], +day[2], +day[3])).toISOString()
  const d = new Date(v)
  return isNaN(d) ? null : d.toISOString()
}

function cleanSource(s) {
  if (!s || typeof s !== 'object') return null
  return {
    account: str(s.account, 40) || null,
    folder: str(s.folder, 1000) || null,
    uid: Number.isInteger(Number(s.uid)) && Number(s.uid) > 0 ? Number(s.uid) : null,
    messageId: str(s.messageId, 500) || null,
    subject: str(s.subject, 500),
  }
}

function cleanEvent(e, prev) {
  if (!e || typeof e !== 'object') throw httpError(400, 'Eveniment invalid')
  const start = isoOrNull(e.start)
  if (!start) throw httpError(400, 'Data de inceput lipseste sau e invalida')
  let end = isoOrNull(e.end)
  const allDay = !!e.allDay
  if (!end || end < start) end = new Date(Date.parse(start) + (allDay ? 24 : 1) * 3600 * 1000).toISOString()
  return {
    id: prev ? prev.id : typeof e.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(e.id) ? e.id : store.newId('e'),
    title: str(e.title, 300).trim() || '(fara titlu)',
    start,
    end,
    allDay,
    location: str(e.location, 500),
    notes: str(e.notes, 20000),
    color: COLOR_RE.test(e.color || '') ? e.color : null,
    status: STATUSES.includes(e.status) ? e.status : 'confirmed',
    source: e.source !== undefined ? cleanSource(e.source) : prev ? prev.source : null,
  }
}

// §3 adaugare fara duplicate
/** Fara Message-ID, mesajul e identificat prin cont+folder+uid. */
function sourceKey(s) {
  if (!s) return null
  return s.messageId ? 'id:' + common.normId(s.messageId) : s.account && s.uid ? `uid:${s.account}|${s.folder}|${s.uid}` : null
}

function sameSlot(a, source, start) {
  const k = sourceKey(source)
  return !!k && a.start === start && sourceKey(a.source) === k
}

/**
 * Adauga evenimente legate de un mesaj; duplicat = acelasi source.messageId + start.
 * `upgrade`: statusul existent se ridica (ex. detected → confirmed cand omul il adauga explicit).
 */
async function addEvents(user, list, source, status, upgrade = false) {
  const src = cleanSource(source)
  const fresh = list.map((ev) => cleanEvent({ ...ev, title: ev.title || ev.summary, notes: ev.notes || ev.description || '', status, source: src }))
  return store.update(user, 'calendar.json', (cal) => {
    const out = []
    for (const ev of fresh) {
      const dup = cal.events.find((x) => sameSlot(x, src, ev.start))
      if (dup) {
        if (upgrade && dup.status !== status) dup.status = status
        out.push(dup)
        continue
      }
      if (cal.events.length >= MAX_EVENTS) break
      cal.events.push(ev)
      out.push(ev)
    }
    return structuredClone(out)
  })
}

// §4 rute CRUD + from-message
const PENDING_STATUSES = new Set(['detected', 'invited'])

function getCalendar({ user, query }) {
  const from = isoOrNull(query.from)
  const to = isoOrNull(query.to)
  const nowIso = new Date().toISOString()
  const incPending = query.includePending === '1' || query.includePending === 'true'
  const events = store
    .read(user, 'calendar.json')
    .events.filter((e) => ((!to || e.start < to) && (!from || e.end > from)) || (incPending && PENDING_STATUSES.has(e.status) && e.end > nowIso))
    .sort((a, b) => a.start.localeCompare(b.start))
  return { events }
}

async function saveEvent({ user, body }) {
  const input = body.event
  return store.update(user, 'calendar.json', (cal) => {
    const prev = input && input.id ? cal.events.find((e) => e.id === input.id) : null
    const ev = cleanEvent(input, prev)
    if (prev) Object.assign(prev, ev)
    else {
      if (cal.events.length >= MAX_EVENTS) throw httpError(400, 'Calendarul e plin')
      cal.events.push(ev)
    }
    return structuredClone(ev)
  })
}

async function deleteEvent({ user, body }) {
  const found = await store.update(user, 'calendar.json', (cal) => {
    const n = cal.events.length
    cal.events = cal.events.filter((e) => e.id !== body.id)
    return cal.events.length !== n
  })
  if (!found) throw httpError(404, 'Evenimentul nu exista')
  return { ok: true }
}

async function fromMessage({ user, body }) {
  const acc = requireAccount(user, body.account)
  const folder = requireFolder(body.folder)
  const uid = toUid(body.uid)
  const messages = require('./api-messages')
  const detect = require('./detect')
  const { header, parsed } = await messages.loadMessage(user, acc.id, folder, uid)
  const env = header.envelope || {}
  const subject = parsed.subject || env.subject || ''
  // ICS are prioritate: e invitatia reala; textul liber e doar o ghicire.
  let found = messages.icsEvents(parsed).map((e) => ({ title: e.summary || subject, start: e.start, end: e.end, allDay: !!e.allDay, location: e.location || '', notes: e.description || '' }))
  if (!found.length) found = detect.detect({ subject, text: parsed.text, html: parsed.html })
  if (body.index !== undefined && body.index !== null) {
    const i = Number(body.index)
    found = Number.isInteger(i) && found[i] ? [found[i]] : []
  }
  if (!found.length) return { events: [] }
  const source = { account: acc.id, folder, uid, messageId: env.messageId || parsed.messageId || null, subject }
  return { events: await addEvents(user, found, source, 'confirmed', true) }
}

const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

async function resolveReplyTarget(user, ev) {
  const src = ev && ev.source
  if (!src || !src.account || !src.folder || !src.uid) return { to: '', name: '', subject: (src && src.subject) || ev.title || '', messageId: (src && src.messageId) || null, references: [] }
  try {
    const acc = store.getAccount(user, src.account)
    if (!acc) return { to: '', name: '', subject: src.subject || ev.title || '', messageId: src.messageId || null, references: [] }
    const messages = require('./api-messages')
    const { header, parsed } = await messages.loadMessage(user, acc.id, src.folder, src.uid, { header: false })
    const env = (header && header.envelope) || {}
    const ics = messages.icsEvents(parsed)[0]
    const org = ics && ics.organizer ? String(ics.organizer).replace(/^mailto:/i, '').trim() : ''
    const first = (v) => (Array.isArray(v) ? v[0] : v)
    const rt = first(parsed.replyTo) || first(parsed.from) || first(env.replyTo) || first(env.from) || null
    const addr = org || (rt && rt.address) || ''
    const refs = [...(parsed.references || []), env.messageId || parsed.messageId || src.messageId].filter(Boolean)
    return { to: addr, name: (rt && rt.name) || '', subject: parsed.subject || env.subject || src.subject || ev.title || '', messageId: env.messageId || parsed.messageId || src.messageId || null, references: [...new Set(refs)] }
  } catch (err) {
    return { to: '', name: '', subject: src.subject || ev.title || '', messageId: src.messageId || null, references: [] }
  }
}

async function getReplyTarget({ user, query }) {
  const ev = store.read(user, 'calendar.json').events.find((e) => e.id === str(query && query.id, 60))
  if (!ev) throw httpError(404, 'Evenimentul nu exista')
  const info = await resolveReplyTarget(user, ev)
  return { to: info.to, name: info.name, subject: info.subject }
}

async function respondEvent({ user, body }) {
  const decision = body && body.decision
  if (decision !== 'approve' && decision !== 'reject') throw httpError(400, 'Decizie invalida')
  const id = str(body.id, 60)
  const ev = store.read(user, 'calendar.json').events.find((e) => e.id === id)
  if (!ev) throw httpError(404, 'Evenimentul nu exista')
  if (decision === 'reject') {
    await store.update(user, 'calendar.json', (cal) => { cal.events = cal.events.filter((e) => e.id !== id) })
    return { ok: true, decision: 'reject', id }
  }
  let confirmationSent = false
  let sentTo = ''
  if (body.sendConfirmation !== false && ev.source && ev.source.account && store.getAccount(user, ev.source.account)) {
    const info = await resolveReplyTarget(user, ev)
    const to = str(body.to, 300).trim() || info.to
    if (to) {
      const whenFmt = new Intl.DateTimeFormat('ro-RO', { timeZone: 'Europe/Bucharest', dateStyle: 'medium', timeStyle: ev.allDay ? undefined : 'short' }).format(new Date(ev.start))
      const baseSubj = info.subject || ev.title || 'Programare'
      const subj = /^re:/i.test(baseSubj) ? baseSubj : `Re: ${baseSubj}`
      const note = str(body.note, 2000).trim()
      const html = `<p>Confirm participarea pentru: <b>${escHtml(ev.title)}</b> (${escHtml(whenFmt)})${ev.location ? `, ${escHtml(ev.location)}` : ''}.</p>${note ? `<p>${escHtml(note)}</p>` : ''}`
      const postSend = require('./api-compose').routes['POST send']
      await postSend({ user, body: { account: ev.source.account, to, subject: subj, html, inReplyTo: info.messageId || undefined, references: info.references, ...(ev.source.folder && ev.source.uid ? { replyTo: { folder: ev.source.folder, uid: ev.source.uid } } : {}) } })
      confirmationSent = true
      sentTo = to
    }
  }
  const updated = await store.update(user, 'calendar.json', (cal) => {
    const cur = cal.events.find((e) => e.id === id)
    if (!cur) return null
    cur.status = 'confirmed'
    return structuredClone(cur)
  })
  return { ok: true, decision: 'approve', event: updated, confirmationSent, to: sentTo }
}

// §5 export
module.exports = {
  addEvents,
  cleanEvent,
  routes: {
    'GET calendar': getCalendar,
    'GET calendar/reply-target': getReplyTarget,
    'POST calendar/respond': respondEvent,
    'POST calendar/save': saveEvent,
    'POST calendar/delete': deleteEvent,
    'POST calendar/from-message': fromMessage,
  },
}
