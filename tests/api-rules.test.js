'use strict'
/* MAP
 * §1 pregatire                          L8-L23
 * §2 motorul de reguli (unit)           L24-L72
 * §3 rute: salvare, quick               L73-L98
 * §4 rules/run                          L99-L136
 */
// §1 pregatire
const test = require('node:test')
const assert = require('node:assert/strict')
const rules = require('../src/rules')
const { makeWorld, rawMessage, startService } = require('./helpers-mail')

let S
let W
let acc
test.before(async () => {
  S = await startService()
  W = makeWorld('ana@firma.ro', 'parolaA', { folders: [['Trash', '\\Trash'], ['Facturi', null], ['Newsletter', null]] })
  acc = await S.addAccount('ana', 'ana@firma.ro', 'parolaA')
})
test.after(() => S.stop())

// §2 motorul de reguli (unit)
const R = (o) => rules.cleanRule({ name: 't', enabled: true, account: '*', match: 'all', stop: false, ...o })
const msg = (o) => ({ uid: 1, subject: '', from: [{ name: 'Ion Popescu', address: 'ion@banca.ro' }], to: [{ name: 'Eu', address: 'eu@firma.ro' }], cc: [], body: '', ...o })

test('subject contains fara diacritice si fara majuscule (ș cu virgula si ş cu sedila)', () => {
  const r = R({ conditions: [{ field: 'subject', op: 'contains', value: 'ȘEDINȚĂ' }], actions: [{ type: 'flag' }] })
  assert.equal(rules.matches(r, msg({ subject: 'Invitatie la sedinta de luni' })), true)
  assert.equal(rules.matches(r, msg({ subject: 'Invitaţie la şedinţa de luni' })), true)
  assert.equal(rules.matches(r, msg({ subject: 'Altceva' })), false)
})

test('from = „nume <adresa>”, operatori equals/startsWith/endsWith/notContains, valoare goala ignorata', () => {
  const t = (op, value, m = msg()) => rules.matches(R({ conditions: [{ field: 'from', op, value }] }), m)
  assert.equal(t('contains', '@banca.ro'), true)
  assert.equal(t('contains', 'popescu'), true)
  assert.equal(t('equals', 'ion popescu <ion@banca.ro>'), true)
  assert.equal(t('startsWith', 'Ion'), true)
  assert.equal(t('endsWith', 'banca.ro>'), true)
  assert.equal(t('notContains', 'banca'), false)
  assert.equal(t('contains', ''), false)
  const r = R({ conditions: [{ field: 'to', op: 'contains', value: 'sef@firma.ro' }] })
  assert.equal(rules.matches(r, msg({ cc: [{ name: '', address: 'sef@firma.ro' }] })), true, 'to include si cc')
})

test('any/all, body, any-field, ordinea actiunilor si stop', () => {
  const both = [{ field: 'subject', op: 'contains', value: 'factura' }, { field: 'body', op: 'contains', value: 'scadență' }]
  const m = msg({ subject: 'Factura nr 5', body: 'Data scadenta: 20.11' })
  assert.equal(rules.matches(R({ match: 'all', conditions: both }), m), true)
  assert.equal(rules.matches(R({ match: 'all', conditions: both }), msg({ subject: 'Factura' })), false)
  assert.equal(rules.matches(R({ match: 'any', conditions: both }), msg({ subject: 'Factura' })), true)
  assert.equal(rules.matches(R({ conditions: [{ field: 'any', op: 'contains', value: 'ion@banca' }] }), msg()), true)
  const list = [
    R({ id: 'r1', conditions: [{ field: 'from', op: 'contains', value: 'banca' }], actions: [{ type: 'category', value: 'blue' }, { type: 'move', value: 'Facturi' }, { type: 'markRead' }] }),
    R({ id: 'r2', conditions: [{ field: 'from', op: 'contains', value: 'ion' }], actions: [{ type: 'delete' }, { type: 'flag' }], stop: true }),
    R({ id: 'r3', conditions: [{ field: 'from', op: 'contains', value: 'ion' }], actions: [{ type: 'category', value: 'red' }] }),
  ]
  const plan = rules.evaluate(list, msg(), 'A')
  assert.deepEqual(plan.matched, ['r1', 'r2'])
  assert.deepEqual(plan.categories, ['blue'])
  assert.equal(plan.markRead, true)
  assert.equal(plan.flag, true)
  assert.deepEqual(plan.terminal, { type: 'move', value: 'Facturi' }, 'doar prima actiune terminala')
  list[0].enabled = false
  list[1].account = 'altcont'
  assert.deepEqual(rules.evaluate(list, msg(), 'A').matched, ['r3'])
  assert.equal(rules.needsBody(list), false)
  assert.equal(rules.needsBody([R({ conditions: both })]), true)
})

// §3 rute: salvare, quick
test('GET/POST rules valideaza; rules/quick creeaza regula', async () => {
  const p = await S.req('ana', 'POST', '/api/mail/rules', { rules: [{ name: 'Banca', conditions: [{ field: 'from', op: 'contains', value: 'banca' }, { field: 'xx', op: 'contains', value: 'y' }], actions: [{ type: 'move', value: 'Facturi' }, { type: 'rm -rf' }] }] })
  assert.equal(p.status, 200)
  assert.equal(p.json.length, 1)
  assert.equal(p.json[0].conditions.length, 1)
  assert.equal(p.json[0].actions.length, 1)
  assert.equal(p.json[0].match, 'all')
  assert.equal(p.json[0].account, '*')
  assert.equal((await S.req('ana', 'POST', '/api/mail/rules', { rules: [{ actions: [{ type: 'move' }] }] })).status, 400)
  const qk = await S.req('ana', 'POST', '/api/mail/rules/quick', { kind: 'blockDomain', value: 'spam@reclame.ro', action: 'delete' })
  assert.deepEqual(qk.json.conditions, [{ field: 'from', op: 'contains', value: '@reclame.ro' }])
  assert.deepEqual(qk.json.actions, [{ type: 'delete', value: null }])
  assert.equal(qk.json.stop, true)
  const qkDup = await S.req('ana', 'POST', '/api/mail/rules/quick', { kind: 'blockDomain', value: 'other@RECLAME.RO', action: 'delete' })
  assert.equal(qkDup.json.duplicate, true)
  assert.equal(qkDup.json.id, qk.json.id)
  const dedup = await S.req('ana', 'POST', '/api/mail/rules', { rules: [{ name: 'A', conditions: [{ field: 'subject', op: 'contains', value: 'Ședință' }], actions: [{ type: 'flag' }] }, { name: 'B', conditions: [{ field: 'subject', op: 'contains', value: 'sedinta' }], actions: [{ type: 'flag' }] }] })
  assert.equal(dedup.json.length, 1)
  await S.req('ana', 'POST', '/api/mail/rules', { rules: [p.json[0], qk.json] })
  assert.equal((await S.req('ana', 'POST', '/api/mail/rules/quick', { kind: 'blockSender', value: 'x@y.ro', action: 'move' })).status, 400)
  const all = (await S.req('ana', 'GET', '/api/mail/rules')).json.rules
  assert.equal(all.length, 2)
  await S.req('ana', 'POST', '/api/mail/rules', { rules: [] })
})

// §4 rules/run
test('rules/run: from contains → move, subject cu diacritice → categorie + citit, delete → Trash', async () => {
  W.put('INBOX', rawMessage({ subject: 'Extras de cont', from: { name: 'Banca X', address: 'extras@banca.ro' } }))
  W.put('INBOX', rawMessage({ subject: 'Ședință de bord', from: { name: 'Sef', address: 'sef@firma.ro' } }))
  W.put('INBOX', rawMessage({ subject: 'Oferte', from: { name: 'Shop', address: 'news@reclame.ro' } }))
  W.put('INBOX', rawMessage({ subject: 'Salut', from: { name: 'Prieten', address: 'p@x.ro' }, text: 'ne vedem la sedinta' }))
  await S.req('ana', 'POST', '/api/mail/rules', {
    rules: [
      { id: 'banca', name: 'Banca', conditions: [{ field: 'from', op: 'contains', value: '@banca.ro' }], actions: [{ type: 'move', value: 'Facturi' }] },
      { id: 'sed', name: 'Sedinte', conditions: [{ field: 'subject', op: 'contains', value: 'sedinta' }], actions: [{ type: 'category', value: 'red' }, { type: 'markRead' }] },
      { id: 'spam', name: 'Spam', conditions: [{ field: 'from', op: 'endsWith', value: 'reclame.ro>' }], actions: [{ type: 'delete' }] },
      { id: 'oprita', name: 'Oprita', enabled: false, conditions: [{ field: 'subject', op: 'contains', value: 'salut' }], actions: [{ type: 'deleteForever' }] },
    ],
  })
  const r = await S.req('ana', 'POST', '/api/mail/rules/run', { account: acc.id, folder: 'INBOX' })
  assert.deepEqual(r.json, { checked: 4, matched: 3, actions: 4 })
  assert.deepEqual(W.msgs('Facturi').map((m) => m.parsed.subject), ['Extras de cont'])
  assert.deepEqual(W.msgs('Trash').map((m) => m.parsed.subject), ['Oferte'])
  const left = W.msgs('INBOX')
  assert.deepEqual(left.map((m) => m.parsed.subject), ['Ședință de bord', 'Salut'])
  assert.ok(left[0].flags.includes('\\Seen'))
  const item = (await S.req('ana', 'GET', `/api/mail/messages?account=${acc.id}&folder=INBOX`)).json.items.find((i) => i.subject === 'Ședință de bord')
  assert.deepEqual(item.categories, ['red'])
  // regula oprita, rulata explicit dupa id; body nu e cerut
  const one = await S.req('ana', 'POST', '/api/mail/rules/run', { ruleId: 'oprita', account: acc.id, folder: 'INBOX' })
  assert.deepEqual(one.json, { checked: 2, matched: 1, actions: 1 })
  assert.deepEqual(W.msgs('INBOX').map((m) => m.parsed.subject), ['Ședință de bord'])
  assert.equal((await S.req('ana', 'POST', '/api/mail/rules/run', { ruleId: 'nu', account: acc.id, folder: 'INBOX' })).status, 404)
  // ruleIds: ruleaza doar subsetul dat de reguli
  W.put('INBOX', rawMessage({ subject: 'Extra X', from: { name: 'Shop', address: 'promo@shop.ro' } }))
  await S.req('ana', 'POST', '/api/mail/rules', { rules: [{ id: 'keep', name: 'Keep', enabled: true, conditions: [{ field: 'subject', op: 'contains', value: 'bord' }], actions: [{ type: 'delete' }] }, { id: 'sub1', name: 'Sub1', enabled: false, conditions: [{ field: 'from', op: 'contains', value: 'promo@shop.ro' }], actions: [{ type: 'flag' }] }] })
  const multi = await S.req('ana', 'POST', '/api/mail/rules/run', { ruleIds: ['sub1'], account: acc.id, folder: 'INBOX' })
  assert.deepEqual(multi.json, { checked: 2, matched: 1, actions: 1 })
  assert.equal(W.msgs('INBOX').length, 2, 'regula keep neselectata in ruleIds nu trebuie sa stearga')
})

test('rules/run cu conditie body descarca corpul; limit', async () => {
  W.put('INBOX', rawMessage({ subject: 'A', text: 'cod promotional REDUCERE' }))
  W.put('INBOX', rawMessage({ subject: 'B', text: 'nimic' }))
  await S.req('ana', 'POST', '/api/mail/rules', { rules: [{ id: 'b', name: 'Body', conditions: [{ field: 'body', op: 'contains', value: 'reducere' }], actions: [{ type: 'flag' }] }] })
  const r = await S.req('ana', 'POST', '/api/mail/rules/run', { account: acc.id, folder: 'INBOX', limit: 2 })
  assert.deepEqual(r.json, { checked: 2, matched: 1, actions: 1 })
  assert.ok(W.msgs('INBOX').find((m) => m.parsed.subject === 'A').flags.includes('\\Flagged'))
})
