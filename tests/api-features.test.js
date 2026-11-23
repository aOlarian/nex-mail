'use strict'
/* MAP
 * §1 setup                              L9-L28
 * §2 grupuri conturi si reordonare      L29-L46
 * §3 foldere locale, wildcard, run all  L47-L94
 * §4 cautare multi-scope, sort, flagged L95-L147
 */

// §1 setup
const test = require('node:test')
const assert = require('node:assert/strict')
const rules = require('../src/rules')
const { makeWorld, rawMessage, startService } = require('./helpers-mail')

let S
let W1
let W2
let acc1
let acc2
test.before(async () => {
  S = await startService()
  W1 = makeWorld('a@firma.ro', 'p1', { folders: [['INBOX/Clients', null], ['Sent', '\\Sent'], ['Sent/Archive', null], ['Trimise/Clients', null], ['Trash', '\\Trash']] })
  W2 = makeWorld('b@shop.ro', 'p2', { folders: [['Sent', '\\Sent'], ['Trash', '\\Trash']] })
  acc1 = await S.addAccount('u1', 'a@firma.ro', 'p1')
  acc2 = await S.addAccount('u1', 'b@shop.ro', 'p2')
})
test.after(() => S.stop())

// §2 grupuri conturi si reordonare
test('account-groups & accounts/reorder persists order and category assignment', async () => {
  const gRes = await S.req('u1', 'POST', '/api/mail/account-groups', {
    groups: [{ id: 'sereni', name: 'Sereni', color: '#0f6cbd' }, { name: 'Qbits', color: '#107c10' }],
  })
  assert.equal(gRes.status, 200)
  assert.equal(gRes.json.length, 2)
  const rRes = await S.req('u1', 'POST', '/api/mail/accounts/reorder', {
    order: [{ id: acc2.id, groupId: gRes.json[0].id }, { id: acc1.id, groupId: gRes.json[1].id }],
  })
  assert.equal(rRes.status, 200)
  assert.deepEqual(rRes.json.map((a) => a.id), [acc2.id, acc1.id])
  assert.equal(rRes.json[0].groupId, 'sereni')
  const st = (await S.req('u1', 'GET', '/api/mail/state')).json
  assert.deepEqual(st.accounts.map((a) => a.id), [acc2.id, acc1.id])
  assert.equal(st.accountGroups.length, 2)
})

// §3 foldere locale, wildcard, run all
test('wildcard matching supports * and ^= and fromName/fromEmail', () => {
  const r1 = rules.cleanRule({ conditions: [{ field: 'subject', op: 'wildcard', value: 'Comanda * a fost procesata' }], actions: [{ type: 'flag' }] })
  const r2 = rules.cleanRule({ conditions: [{ field: 'fromEmail', op: 'wildcard', value: '*.shop' }], actions: [{ type: 'flag' }] })
  const r3 = rules.cleanRule({ conditions: [{ field: 'fromName', op: 'wildcard', value: 'Auto^=Bot' }], actions: [{ type: 'flag' }] })
  const r4 = rules.cleanRule({ conditions: [{ field: 'fromEmail', op: 'wildcard', value: '*@mega.shop' }], actions: [{ type: 'flag' }] })
  assert.equal(rules.matches(r1, { subject: 'Comanda #9921 a fost procesata si livrata', from: [], to: [], cc: [], body: '' }), true)
  assert.equal(rules.matches(r2, { subject: '', from: [{ name: 'Shop', address: 'deals@mega.shop' }], to: [], cc: [], body: '' }), true)
  assert.equal(rules.matches(r3, { subject: '', from: [{ name: 'Auto Filter Bot', address: 'a@x.ro' }], to: [], cc: [], body: '' }), true)
  assert.equal(rules.matches(r4, { subject: '', from: [{ name: 'Promo', address: 'promo@mega.shop' }], to: [], cc: [], body: '' }), true)
  assert.equal(rules.matches(r4, { subject: '', from: [{ name: 'Spoof', address: 'promo@mega.shop.evil.com' }], to: [], cc: [], body: '' }), false)
})

test('filtered folders CRUD + quick custom rule + moveLocal expunges from IMAP and serves locally', async () => {
  const created = await S.req('u1', 'POST', '/api/mail/filtered/folders', { action: 'create', name: 'Receipts' })
  assert.equal(created.status, 200)
  const recId = created.json.folder.id
  W1.put('INBOX', rawMessage({ subject: 'Comanda #55 a fost procesata azi', from: { name: 'Mega', address: 'noreply@mega.shop' }, text: 'Receipt body', attachments: [{ filename: 'bon.txt', contentType: 'text/plain', content: Buffer.from('BON') }] }))
  W2.put('Sent', rawMessage({ subject: 'Comanda #56 a fost procesata ieri', from: { name: 'B', address: 'b@shop.ro' }, text: 'Old order' }))
  W1.put('INBOX', rawMessage({ subject: 'Regular Hello', from: { name: 'Ana', address: 'ana@ok.ro' }, text: 'Keep me' }))
  const qr = await S.req('u1', 'POST', '/api/mail/rules/quick', {
    kind: 'custom', field: 'subject', op: 'wildcard', value: 'Comanda * a fost procesata', action: 'moveLocal', dest: recId,
  })
  assert.equal(qr.status, 200)
  const run = await S.req('u1', 'POST', '/api/mail/rules/run', { all: true })
  assert.equal(run.status, 200)
  assert.equal(run.json.matched, 2)
  assert.equal(W1.msgs('INBOX').length, 1)
  assert.equal(W2.msgs('Sent').length, 0)
  const list = await S.req('u1', 'GET', `/api/mail/messages?account=__local__&folder=${recId}&sortBy=subject&sortDir=asc`)
  assert.equal(list.status, 200)
  assert.equal(list.json.items.length, 2)
  assert.equal(list.json.items[0].subject, 'Comanda #55 a fost procesata azi')
  const msg = await S.req('u1', 'GET', `/api/mail/message?account=__local__&folder=${recId}&uid=${list.json.items[0].uid}`)
  assert.equal(msg.status, 200)
  assert.equal(msg.json.attachments.length, 1)
  const att = await S.req('u1', 'GET', `/api/mail/attachment?account=__local__&folder=${recId}&uid=${list.json.items[0].uid}&part=${msg.json.attachments[0].id}`)
  assert.equal(att.status, 200)
  const renamed = await S.req('u1', 'POST', '/api/mail/filtered/folders', { action: 'rename', id: recId, name: 'All Receipts' })
  assert.ok(renamed.json.folders.some((f) => f.id === recId && f.name === 'All Receipts'))
  const qd = await S.req('u1', 'POST', '/api/mail/rules/quick', { kind: 'quickDomain', value: '*@promo.ro', action: 'delete' })
  assert.equal(qd.status, 200)
  assert.deepEqual(qd.json.conditions, [{ field: 'fromEmail', op: 'wildcard', value: '*@promo.ro' }])
  const cd = await S.req('u1', 'POST', '/api/mail/rules/quick', { kind: 'custom', field: 'domain', value: 'Alerts.EU', action: 'delete' })
  assert.equal(cd.status, 200)
  assert.deepEqual(cd.json.conditions, [{ field: 'fromEmail', op: 'wildcard', value: '*@alerts.eu' }])
})

// §4 cautare multi-scope, sort, flagged
test('multi-scope search (inboxes, sent with recursive sentName, everywhere), multi-filters, flagged', async () => {
  W1.put('Trimise/Clients', rawMessage({ subject: 'Beta Proposal', from: { name: 'Me', address: 'a@firma.ro' }, text: 'Alpha inside' }), ['\\Seen'])
  W1.put('Sent/Archive', rawMessage({ subject: 'Alpha Archived Sent', from: { name: 'Me', address: 'a@firma.ro' }, text: 'hello' }), ['\\Seen', '\\Flagged'])
  W2.put('INBOX', rawMessage({ subject: 'Alpha Inbox B', from: { name: 'Client B', address: 'c@b.ro' }, text: 'unread flagged' }), ['\\Flagged'])

  const sentDefault = await S.req('u1', 'GET', '/api/mail/messages?scope=sent&sentName=Sent')
  assert.equal(sentDefault.status, 200)
  assert.ok(sentDefault.json.items.some((m) => m.subject === 'Alpha Archived Sent'))
  assert.ok(!sentDefault.json.items.some((m) => m.subject === 'Beta Proposal'))

  const sentCustom = await S.req('u1', 'GET', '/api/mail/messages?scope=sent&sentName=Trimise')
  assert.ok(sentCustom.json.items.some((m) => m.subject === 'Beta Proposal'))

  const inboxes = await S.req('u1', 'GET', '/api/mail/messages?scope=inboxes&filters=unread,flagged')
  assert.equal(inboxes.status, 200)
  assert.ok(inboxes.json.items.some((m) => m.subject === 'Alpha Inbox B' && m.account === acc2.id && m.folder === 'INBOX'))

  const every = await S.req('u1', 'GET', '/api/mail/messages?scope=everywhere&q=Comanda&sortBy=subject&sortDir=desc')
  assert.equal(every.status, 200)
  assert.ok(every.json.items.some((m) => m.account === '__local__'))

  const fl = await S.req('u1', 'GET', '/api/mail/flagged')
  assert.equal(fl.status, 200)
  assert.ok(fl.json.items.some((m) => m.subject === 'Alpha Inbox B'))

  // ALL INBOXES virtual account links INBOX + subfolders across accounts, acts on origin
  W1.put('INBOX/Clients', rawMessage({ subject: 'Subfolder Client Doc', from: { name: 'Client Sub', address: 'sub@client.ro' }, text: 'hi' }), [])
  const allOn = await S.req('u1', 'GET', '/api/mail/messages?account=__all_inboxes__&subfolders=1')
  assert.equal(allOn.status, 200)
  const subItem = allOn.json.items.find((m) => m.subject === 'Subfolder Client Doc')
  assert.ok(subItem && subItem.account === acc1.id && subItem.folder === 'INBOX/Clients')
  assert.ok(allOn.json.items.some((m) => m.subject === 'Alpha Inbox B' && m.account === acc2.id))
  assert.ok(!allOn.json.items.some((m) => m.account === '__local__' || m.folder === 'Sent/Archive'))

  const allOff = await S.req('u1', 'GET', '/api/mail/messages?account=__all_inboxes__&subfolders=0')
  assert.ok(!allOff.json.items.some((m) => m.folder === 'INBOX/Clients'))

  const mark = await S.req('u1', 'POST', '/api/mail/flags', { account: subItem.account, folder: subItem.folder, uids: [subItem.uid], add: ['\\Flagged'], remove: [] })
  assert.equal(mark.status, 200)
  const allFlagged = await S.req('u1', 'GET', '/api/mail/messages?account=__all_inboxes__&filters=flagged')
  assert.ok(allFlagged.json.items.some((m) => m.subject === 'Subfolder Client Doc'))

  // ALL INBOXES settings: accent color & per-mailbox exclusion
  const aiSet = await S.req('u1', 'POST', '/api/mail/settings', { allInboxes: { color: '#107c41', excluded: [acc2.id] } })
  assert.equal(aiSet.status, 200)
  assert.equal(aiSet.json.allInboxes.color, '#107c41')
  const allExcl = await S.req('u1', 'GET', '/api/mail/messages?account=__all_inboxes__')
  assert.ok(!allExcl.json.items.some((m) => m.account === acc2.id))
  await S.req('u1', 'POST', '/api/mail/settings', { allInboxes: { excluded: [] } })
  const allRestored = await S.req('u1', 'GET', '/api/mail/messages?account=__all_inboxes__')
  assert.ok(allRestored.json.items.some((m) => m.account === acc2.id))
})
