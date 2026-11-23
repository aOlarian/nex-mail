'use strict'
/* MAP
 * §1 pregatire                          L7-L32
 * §2 CRUD                               L33-L56
 * §3 from-message (ICS, text)           L57-L94
 */
// §1 pregatire
const test = require('node:test')
const assert = require('node:assert/strict')
const { makeWorld, rawMessage, startService } = require('./helpers-mail')

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'PRODID:-//Test//EN',
  'BEGIN:VEVENT', 'UID:ev-1@test', 'SUMMARY:Revizie proiect', 'LOCATION:Sala Mare',
  'DTSTART;TZID=Europe/Bucharest:20261125T100000', 'DTEND;TZID=Europe/Bucharest:20261125T113000',
  'ORGANIZER;CN=Ion:mailto:ion@firma.ro', 'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n')

let S
let W
let acc
let icsUid
let textUid
test.before(async () => {
  S = await startService()
  W = makeWorld('ana@firma.ro', 'parolaA')
  icsUid = W.put('INBOX', rawMessage({ subject: 'Invitatie: Revizie proiect', attachments: [{ filename: 'invite.ics', contentType: 'text/calendar; method=REQUEST', content: Buffer.from(ICS) }] }))
  textUid = W.put('INBOX', rawMessage({ subject: 'Programare service auto', text: 'Programarea dvs: 03.12.2027, ora 09:00. Adresa: Str. Fabricii 2' }))
  acc = await S.addAccount('ana', 'ana@firma.ro', 'parolaA')
})
test.after(() => S.stop())

// §2 CRUD
test('calendar: save/list cu interval/update/delete si validare', async () => {
  const s = await S.req('ana', 'POST', '/api/mail/calendar/save', { event: { title: 'Dentist', start: '2026-11-20T08:00:00Z', location: 'Clinica' } })
  assert.equal(s.status, 200)
  const ev = s.json
  assert.ok(ev.id)
  assert.equal(ev.end, '2026-11-20T09:00:00.000Z', 'end implicit +1h')
  assert.equal(ev.status, 'confirmed')
  assert.equal(ev.source, null)
  const day = await S.req('ana', 'POST', '/api/mail/calendar/save', { event: { title: 'Concediu', start: '2026-12-24', allDay: true } })
  assert.equal(day.json.start, '2026-12-23T22:00:00.000Z', 'data simpla = miezul noptii la Bucuresti')
  const upd = await S.req('ana', 'POST', '/api/mail/calendar/save', { event: { ...ev, title: 'Dentist (mutat)', status: 'tentative' } })
  assert.equal(upd.json.id, ev.id)
  assert.equal(upd.json.status, 'tentative')
  assert.equal((await S.req('ana', 'POST', '/api/mail/calendar/save', { event: { title: 'X', start: 'ieri' } })).status, 400)
  const nov = (await S.req('ana', 'GET', '/api/mail/calendar?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z')).json.events
  assert.deepEqual(nov.map((e) => e.title), ['Dentist (mutat)'])
  assert.equal((await S.req('ana', 'GET', '/api/mail/calendar')).json.events.length, 2)
  assert.deepEqual((await S.req('ana', 'POST', '/api/mail/calendar/delete', { id: ev.id })).json, { ok: true })
  assert.equal((await S.req('ana', 'POST', '/api/mail/calendar/delete', { id: ev.id })).status, 404)
  await S.req('ana', 'POST', '/api/mail/calendar/delete', { id: day.json.id })
  assert.equal((await S.req('bogdan', 'GET', '/api/mail/calendar')).json.events.length, 0)
})

// §3 from-message (ICS, text)
test('message expune events din ICS (proto/ics real) si suggestions din text', async () => {
  const m = (await S.req('ana', 'GET', `/api/mail/message?account=${acc.id}&folder=INBOX&uid=${icsUid}`)).json
  assert.equal(m.events.length, 1)
  assert.equal(m.events[0].summary, 'Revizie proiect')
  assert.equal(m.events[0].start, '2026-11-25T08:00:00.000Z')
  assert.equal(m.events[0].method, 'REQUEST')
  const t = (await S.req('ana', 'GET', `/api/mail/message?account=${acc.id}&folder=INBOX&uid=${textUid}`)).json
  assert.equal(t.events.length, 0)
  assert.equal(t.suggestions.length, 1)
  assert.equal(t.suggestions[0].start, '2027-12-03T07:00:00.000Z')
  assert.equal(t.suggestions[0].location, 'Str. Fabricii 2')
})

test('from-message: ICS prioritar, apoi text; fara duplicate; status ridicat la confirmed', async () => {
  const a = await S.req('ana', 'POST', '/api/mail/calendar/from-message', { account: acc.id, folder: 'INBOX', uid: icsUid })
  assert.equal(a.json.events.length, 1)
  const e = a.json.events[0]
  assert.deepEqual([e.title, e.start, e.end, e.location, e.status], ['Revizie proiect', '2026-11-25T08:00:00.000Z', '2026-11-25T09:30:00.000Z', 'Sala Mare', 'confirmed'])
  assert.equal(e.source.account, acc.id)
  assert.equal(e.source.uid, icsUid)
  assert.ok(e.source.messageId)
  const again = await S.req('ana', 'POST', '/api/mail/calendar/from-message', { account: acc.id, folder: 'INBOX', uid: icsUid })
  assert.equal(again.json.events[0].id, e.id)
  assert.equal((await S.req('ana', 'GET', '/api/mail/calendar')).json.events.length, 1)

  // sync-ul adaugase deja „detected”: from-message il confirma, nu-l dubleaza
  const cal = require('../src/api-calendar')
  const m = (await S.req('ana', 'GET', `/api/mail/message?account=${acc.id}&folder=INBOX&uid=${textUid}`)).json
  await cal.addEvents('ana', m.suggestions, { account: acc.id, folder: 'INBOX', uid: textUid, messageId: m.messageId, subject: m.subject }, 'detected')
  const t = await S.req('ana', 'POST', '/api/mail/calendar/from-message', { account: acc.id, folder: 'INBOX', uid: textUid, index: 0 })
  assert.equal(t.json.events.length, 1)
  assert.equal(t.json.events[0].status, 'confirmed')
  assert.equal(t.json.events[0].title, 'Programare service auto')
  assert.equal((await S.req('ana', 'GET', '/api/mail/calendar')).json.events.length, 2)
  const none = await S.req('ana', 'POST', '/api/mail/calendar/from-message', { account: acc.id, folder: 'INBOX', uid: textUid, index: 5 })
  assert.deepEqual(none.json, { events: [] })
})

test('respond: approve trimite confirmare prin SMTP si confirma evenimentul; reject il sterge', async () => {
  const cal = require('../src/api-calendar')
  const compose = require('../src/api-compose')
  const sent = []
  compose.setSender(async (cfg, m) => { sent.push(m); return { accepted: m.recipients, rejected: [], response: '250 ok' } })
  try {
    const uid = W.put('INBOX', rawMessage({ from: { name: 'Client', address: 'client@ext.ro' }, subject: 'Consultatie 10.12.2027', text: 'Programare pe 10.12.2027 ora 11:00.' }))
    const msg = (await S.req('ana', 'GET', `/api/mail/message?account=${acc.id}&folder=INBOX&uid=${uid}`)).json
    const added = await cal.addEvents('ana', msg.suggestions, { account: acc.id, folder: 'INBOX', uid, messageId: msg.messageId, subject: msg.subject }, 'detected')
    const ev = added[0]
    const inc = await S.req('ana', 'GET', '/api/mail/calendar?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&includePending=1')
    assert.ok(inc.json.events.some((x) => x.id === ev.id), 'includePending include propunerea neaprobata')
    const rt = await S.req('ana', 'GET', `/api/mail/calendar/reply-target?id=${ev.id}`)
    assert.equal(rt.status, 200)
    assert.equal(rt.json.to, 'client@ext.ro')
    const app = await S.req('ana', 'POST', '/api/mail/calendar/respond', { id: ev.id, decision: 'approve', sendConfirmation: true, note: 'Ne auzim atunci.' })
    assert.equal(app.status, 200)
    assert.equal(app.json.event.status, 'confirmed')
    assert.equal(app.json.confirmationSent, true)
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0].recipients, ['client@ext.ro'])
    const added2 = await cal.addEvents('ana', [{ title: 'Spam call', start: '2027-12-11T10:00:00.000Z', end: '2027-12-11T11:00:00.000Z' }], { account: acc.id, folder: 'INBOX', uid: uid + 1 }, 'detected')
    const rej = await S.req('ana', 'POST', '/api/mail/calendar/respond', { id: added2[0].id, decision: 'reject' })
    assert.equal(rej.status, 200)
    assert.ok(!(await S.req('ana', 'GET', '/api/mail/calendar')).json.events.some((x) => x.id === added2[0].id))
  } finally { compose.setSender(null) }
})
