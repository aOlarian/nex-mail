'use strict'
/* MAP
 * §1 pregatire                          L7-L33
 * §2 prima rulare, mesaje noi           L34-L91
 * §3 erori, backoff, uidvalidity        L92-L137
 */
// §1 pregatire
const test = require('node:test')
const assert = require('node:assert/strict')
const { makeWorld, rawMessage, startService } = require('./helpers-mail')
const subj = (m) => require('../proto/mime').parse(m.raw).subject

const ics = (method) => ['BEGIN:VCALENDAR', 'VERSION:2.0', `METHOD:${method}`, 'BEGIN:VEVENT', `UID:${method}@t`, 'SUMMARY:Sedinta buget', 'DTSTART:20261201T090000Z', 'DTEND:20261201T100000Z', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')

let S
let W
let W2
let acc
let acc2
let sync
const pool = () => require('../src/pool')
test.before(async () => {
  S = await startService()
  sync = require('../src/sync')
  W = makeWorld('ana@firma.ro', 'parolaA', { folders: [['Trash', '\\Trash'], ['Facturi', null]] })
  W2 = makeWorld('ana@gmail.test', 'parolaG')
  W.put('INBOX', rawMessage({ subject: 'Factura veche' }))
  W.put('INBOX', rawMessage({ subject: 'Programare veche', text: 'programare 20.12.2026 ora 10:00' }))
  acc = await S.addAccount('ana', 'ana@firma.ro', 'parolaA')
  await S.req('ana', 'POST', '/api/mail/rules', { rules: [{ id: 'f', name: 'Facturi', conditions: [{ field: 'subject', op: 'contains', value: 'factura' }], actions: [{ type: 'move', value: 'Facturi' }, { type: 'category', value: 'green' }] }] })
})
test.after(() => S.stop())

// §2 prima rulare, mesaje noi
test('prima rulare: doar marcheaza lastUid, fara reguli si fara calendar pe istoric', async () => {
  await sync.runOnce({ user: 'ana', force: true })
  const st = S.store.read('ana', 'sync.json')[acc.id]
  assert.equal(st.lastUid, 2)
  assert.equal(st.unseen, 2)
  assert.equal(st.error, null)
  assert.ok(st.uidvalidity && st.lastSync)
  assert.equal(W.msgs('INBOX').length, 2)
  assert.equal(W.msgs('Facturi').length, 0)
  assert.equal(S.store.read('ana', 'calendar.json').events.length, 0)
  const state = (await S.req('ana', 'GET', '/api/mail/state')).json
  assert.deepEqual(state.unread, { total: 2, byAccount: { [acc.id]: 2 } })
  assert.equal(state.accounts[0].status.ok, true)
  assert.equal(state.accounts[0].status.lastSync, st.lastSync)
})

test('a doua rulare: reguli pe mesajele noi, ICS REQUEST → invited, text → detected, CANCEL ignorat, contacte', async () => {
  W.put('INBOX', rawMessage({ subject: 'Factura noiembrie', from: { name: 'Furnizor', address: 'facturi@furnizor.ro' } }))
  W.put('INBOX', rawMessage({ subject: 'Programare dentist', text: 'Programarea dvs este pe 05.12.2026 ora 15:00.' }))
  W.put('INBOX', rawMessage({ subject: 'Invitație: Sedinta buget', attachments: [{ filename: 'invite.ics', contentType: 'text/calendar', content: Buffer.from(ics('REQUEST')) }] }))
  W.put('INBOX', rawMessage({ subject: 'Anulat: Sedinta buget', text: 'sedinta din 07.12.2026 ora 10:00 se anuleaza', attachments: [{ filename: 'cancel.ics', contentType: 'text/calendar', content: Buffer.from(ics('CANCEL')) }] }))
  W.put('INBOX', Buffer.from('List-Unsubscribe: <https://list.test/u>\r\n' + rawMessage({ subject: 'Newsletter Webinar', text: 'Booking open for webinar on 08.12.2026 at 14:00' }).toString()))
  W.put('INBOX', rawMessage({ subject: 'Salut', text: 'nimic special' }))
  await sync.runOnce({ user: 'ana', force: true })
  const st = S.store.read('ana', 'sync.json')[acc.id]
  assert.equal(st.lastUid, 8)
  assert.deepEqual(W.msgs('Facturi').map((m) => subj(m)), ['Factura noiembrie'])
  assert.ok(W.msgs('INBOX').some((m) => subj(m) === 'Factura veche'), 'istoricul ramane neatins')
  assert.equal(st.unseen, 7)
  const meta = Object.values(S.store.read('ana', 'meta.json'))
  assert.deepEqual(meta.map((m) => m.categories), [['green']])
  const ev = S.store.read('ana', 'calendar.json').events.sort((a, b) => a.start.localeCompare(b.start))
  assert.deepEqual(ev.map((e) => [e.title, e.start, e.status]), [
    ['Sedinta buget', '2026-12-01T09:00:00.000Z', 'invited'],
    ['Programare dentist', '2026-12-05T13:00:00.000Z', 'detected'],
  ])
  assert.equal(ev[1].source.folder, 'INBOX')
  assert.ok(ev[1].source.messageId)
  const contacts = S.store.read('ana', 'contacts.json').items.map((c) => c.address)
  assert.ok(contacts.includes('facturi@furnizor.ro'))
  // rulare fara mesaje noi: nu dubleaza nimic
  await sync.runOnce({ user: 'ana', force: true })
  assert.equal(S.store.read('ana', 'calendar.json').events.length, 2)
  assert.equal(S.store.read('ana', 'sync.json')[acc.id].lastUid, 8)
})

test('autoCalendar=false: fara evenimente; pollSeconds respectat fara force', async () => {
  await S.req('ana', 'POST', '/api/mail/settings', { autoCalendar: false })
  W.put('INBOX', rawMessage({ subject: 'Programare ITP', text: 'programare 10.12.2026 ora 11:00' }))
  const c0 = W.calls.length
  await sync.runOnce({ user: 'ana' })
  assert.equal(W.calls.length, c0, 'pollSeconds (120 s) nu a expirat: nicio operatie')
  await sync.runOnce({ user: 'ana', force: true })
  assert.equal(S.store.read('ana', 'sync.json')[acc.id].lastUid, 9)
  assert.equal(S.store.read('ana', 'calendar.json').events.length, 2)
  await S.req('ana', 'POST', '/api/mail/settings', { autoCalendar: true })
})

// §3 erori, backoff, uidvalidity
test('un cont cu eroare nu blocheaza celalalt; backoff la parola gresita', async () => {
  acc2 = await S.addAccount('ana', 'ana@gmail.test', 'parolaG')
  W2.down = true
  W.pass = 'schimbata'
  pool().drop('ana', acc.id)
  await sync.runOnce({ user: 'ana', force: true })
  const s = S.store.read('ana', 'sync.json')
  assert.equal(s[acc.id].error, 'Parola sau utilizatorul gresit')
  assert.ok(s[acc.id].authFailAt)
  assert.equal(s[acc2.id].error, 'Serverul nu raspunde')
  const st = (await S.req('ana', 'GET', '/api/mail/state')).json.accounts.find((a) => a.id === acc.id)
  assert.deepEqual([st.status.ok, st.status.error], [false, 'Parola sau utilizatorul gresit'])
  // backoff: nici macar cu force nu reincearca in 15 minute
  W.pass = 'parolaA'
  const c0 = W.connects
  await sync.runOnce({ user: 'ana', force: true })
  assert.equal(W.connects, c0)
  // parola salvata din nou → backoff anulat
  await S.req('ana', 'POST', '/api/mail/accounts/save', { ...st, password: 'parolaA' })
  W2.down = false
  await sync.runOnce({ user: 'ana', force: true })
  const s2 = S.store.read('ana', 'sync.json')
  assert.equal(s2[acc.id].error, null)
  assert.equal(s2[acc.id].authFailAt, undefined)
  assert.equal(s2[acc2.id].error, null)
})

test('UIDVALIDITY schimbat: repozitionare fara procesare; POST /sync raspunde imediat', async () => {
  const inbox = W.folders.get('INBOX')
  inbox.uidvalidity = 9999
  W.put('INBOX', rawMessage({ subject: 'Factura dupa reset' }))
  await sync.runOnce({ user: 'ana', account: acc.id, force: true })
  const s = S.store.read('ana', 'sync.json')[acc.id]
  assert.equal(s.uidvalidity, 9999)
  assert.equal(s.lastUid, inbox.uidnext - 1)
  assert.ok(W.msgs('INBOX').some((m) => subj(m) === 'Factura dupa reset'))
  const r = await S.req('ana', 'POST', '/api/mail/sync', { account: acc.id })
  assert.deepEqual(r.json, { ok: true })
  assert.equal((await S.req('ana', 'POST', '/api/mail/sync', { account: 'nuexista' })).status, 404)
  assert.equal((await S.req('ana', 'GET', '/api/mail/unread')).json.total >= 0, true)
  // contul sters nu mai apare in sync.json la urmatorul ciclu
  await S.req('ana', 'POST', '/api/mail/accounts/delete', { id: acc2.id })
  await sync.runOnce({ user: 'ana', force: true })
  assert.equal(S.store.read('ana', 'sync.json')[acc2.id], undefined)
})
