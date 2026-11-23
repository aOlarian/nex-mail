'use strict'
/* MAP
 * §1 pregatire                          L7-L13
 * §2 texte romanesti                    L14-L44
 * §3 texte englezesti, margini          L45-L67
 */
// §1 pregatire
const test = require('node:test')
const assert = require('node:assert/strict')
const { detect, norm, htmlToText } = require('../src/detect')

const NOW = new Date('2026-11-12T10:00:00Z')

// §2 texte romanesti
test('RO: dd.mm.yyyy + „ora 10:00” + locatie; ora Bucurestiului (UTC+2 iarna)', () => {
  const r = detect({ subject: 'Confirmare programare', text: 'Bună ziua, programarea dvs. este pe 17.11.2026, ora 10:00.\nLocația: Str. Ion Câmpineanu 20, București' }, NOW)
  assert.equal(r.length, 1)
  assert.deepEqual({ ...r[0], snippet: undefined }, { title: 'Confirmare programare', start: '2026-11-17T08:00:00.000Z', end: '2026-11-17T09:00:00.000Z', allDay: false, location: 'Str. Ion Câmpineanu 20, București', snippet: undefined })
  assert.match(r[0].snippet, /17\.11\.2026/)
})

test('RO: „luni, 17 noiembrie” fara an + interval „14:30 - 15:45” + „la sediul”', () => {
  const r = detect({ subject: 'Ședință lunară', text: 'Ne vedem luni, 17 noiembrie, 14:30 - 15:45 la sediul firmei din Cluj.' }, NOW)
  assert.equal(r.length, 1)
  assert.equal(r[0].start, '2026-11-17T12:30:00.000Z')
  assert.equal(r[0].end, '2026-11-17T13:45:00.000Z')
  assert.equal(r[0].location, 'firmei din Cluj')
})

test('RO: „15 nov.” fara ora = toata ziua; vara UTC+3; data trecuta ignorata', () => {
  const a = detect({ subject: 'Rezervare', text: 'Rezervarea pentru 15 nov. a fost confirmată.' }, NOW)
  assert.deepEqual([a[0].allDay, a[0].start, a[0].end], [true, '2026-11-14T22:00:00.000Z', '2026-11-15T22:00:00.000Z'])
  const s = detect({ subject: 'Interviu', text: 'Interviul are loc pe 2027-07-01 la 09:30.' }, NOW)
  assert.equal(s[0].start, '2027-07-01T06:30:00.000Z')
  assert.deepEqual(detect({ subject: 'Programare', text: 'Programarea din 01.10.2026 ora 9:00' }, NOW), [])
  // ieri: inca acceptat (toleranta 1 zi)
  assert.equal(detect({ subject: 'Programare', text: 'programare 12/11/2026 ora 08:00' }, NOW).length, 1)
})

test('RO: fara cuvant-cheie → nimic; „mai 20 de minute” nu e data', () => {
  assert.deepEqual(detect({ subject: 'Salut', text: 'Ne auzim pe 20.11.2026 ora 10:00' }, NOW), [])
  assert.deepEqual(detect({ subject: 'Hello', text: 'Mai 20 de minute si ajung.' }, NOW), [])
})

// §3 texte englezesti, margini
test('EN: „November 20, 2026 at 2:30 PM” + Address', () => {
  const r = detect({ subject: 'Interview', text: 'Your interview is scheduled for November 20, 2026 at 2:30 PM.\nAddress: 1 Main St' }, NOW)
  assert.equal(r[0].start, '2026-11-20T12:30:00.000Z')
  assert.equal(r[0].location, '1 Main St')
})

test('EN: „15 Nov 2026” + „10:00 - 11:00”, din HTML, max 3, fara duplicate', () => {
  const r = detect({ subject: 'Team meeting', html: '<p>Meeting on <b>15 Nov 2026</b>, 10:00 - 11:00</p><style>p{}</style>' }, NOW)
  assert.equal(r.length, 1)
  assert.equal(r[0].start, '2026-11-15T08:00:00.000Z')
  assert.equal(r[0].end, '2026-11-15T09:00:00.000Z')
  const many = detect({ subject: 'Webinar series', text: '1) 20.11.2026 ora 10:00\n\n2) 21.11.2026 ora 10:00\n\n3) 22.11.2026 ora 10:00\n\n4) 23.11.2026 ora 10:00\n\nrepet: 20.11.2026 ora 10:00' }, NOW)
  assert.equal(many.length, 3)
  assert.equal(new Set(many.map((x) => x.start)).size, 3)
})

test('call ca cuvant intreg; norm si htmlToText', () => {
  assert.equal(detect({ subject: 'Recall notice', text: 'on 20.11.2026 at 10:00' }, NOW).length, 0)
  assert.equal(detect({ subject: 'I Call It Sugar Season', text: 'November 19, 2026 at 12:00' }, NOW).length, 0)
  assert.equal(detect({ subject: 'Quick call', text: 'on 20.11.2026 at 10:00' }, NOW).length, 1)
  assert.equal(detect({ subject: 'Art History Link Up', text: 'Booking info. Applications close at 5pm on Friday 4 December.' }, NOW).length, 0)
  assert.equal(detect({ subject: 'Meeting', text: 'On 20.11.2026 at 10:00', headers: new Map([['list-unsubscribe', ['<https://x.test/unsub>']]]) }, NOW).length, 0)
  assert.equal(detect({ subject: 'Webinar', text: 'Webinar 20.11.2026 at 10:00', headers: { 'X-Mailer': 'Mailchimp Mailer' } }, NOW).length, 0)
  assert.equal(detect({ subject: 'Confirmare', text: 'Programarea solicitată: Miercuri, 18 Noiembrie 2026, ora 08:00' }, NOW).length, 1)
  assert.equal(norm('ȘȚĂÎÂ şţ'), 'staia st')
  assert.equal(htmlToText('a<br>b&nbsp;&amp;&#259;').trim(), 'a\nb &ă')
  const now17 = new Date('2026-11-17T11:00:00Z')
  const mixed = detect({ subject: 'AZI 16:00 interviu', text: 'Ai interviu marți 17 noiembrie 2026, la 16:00-16:30.\nTarif comunicat ieri, 16 noiembrie, la 14:47.\n\nÎn lun., 16 nov. 2026 la 14:47, X a scris:\nProgramare 25.11.2026 ora 10:00' }, now17)
  assert.equal(mixed.length, 1)
  assert.equal(mixed[0].start, '2026-11-17T14:00:00.000Z')
})
