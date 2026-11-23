'use strict'
/* MAP
 * §1 pregatire                          L10-L31
 * §2 foldere                            L32-L74
 * §3 lista, paginare, filtre            L75-L102
 * §4 mesaj, cid, atasament, sursa       L103-L139
 * §5 flaguri, mutare, stergere          L140-L197
 * §6 meta: categorii, taskuri           L198-L236
 */
// §1 pregatire
const test = require('node:test')
const assert = require('node:assert/strict')
const { makeWorld, rawMessage, startService } = require('./helpers-mail')

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082', 'hex')
let S
let W
let acc
const q = (o) => new URLSearchParams(o).toString()
const list = (o) => S.req('ana', 'GET', '/api/mail/messages?' + q({ account: acc.id, folder: 'INBOX', ...o }))

test.before(async () => {
  S = await startService()
  W = makeWorld('ana@firma.ro', 'parolaA')
  W.put('INBOX', rawMessage({ subject: 'Factura octombrie', from: { name: 'Contabil', address: 'conta@firma.ro' }, attachments: [{ filename: 'factură.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 test') }] }), ['\\Seen'])
  W.put('INBOX', rawMessage({ subject: 'Poza', html: '<p>Uite:<img src="cid:poza1@x"></p><script>alert(1)</script><a href="javascript:alert(2)" onclick="x()">l</a><img src="https://tracker.example/p.gif">', attachments: [{ filename: 'poza.png', contentType: 'image/png', content: PNG, contentId: 'poza1@x' }] }))
  for (let i = 0; i < 6; i++) W.put('INBOX', rawMessage({ subject: `Știri ${i}`, text: `buletin ${i} despre ședință` }), i % 2 ? ['\\Seen'] : ['\\Flagged'])
  acc = await S.addAccount('ana', 'ana@firma.ro', 'parolaA')
})
test.after(() => S.stop())

// §2 foldere
test('folders: ordine Inbox, Drafts, Sent, Archive, Junk, Trash, apoi alfabetic; unseen/total', async () => {
  W.addFolder('Zeta')
  W.addFolder('Clienti')
  W.addFolder('Clienti/Alfa')
  const r = await S.req('ana', 'GET', `/api/mail/folders?account=${acc.id}`)
  assert.equal(r.status, 200)
  assert.equal(r.json.delimiter, '/')
  assert.deepEqual(r.json.folders.map((f) => f.path), ['INBOX', 'Drafts', 'Sent', 'Junk', 'Trash', 'Clienti', 'Clienti/Alfa', 'Zeta'])
  const inbox = r.json.folders[0]
  assert.equal(inbox.total, 8)
  assert.equal(inbox.unseen, 4)
  assert.equal(inbox.specialUse, '\\Inbox')
  assert.deepEqual(Object.keys(inbox).sort(), ['delimiter', 'name', 'noselect', 'path', 'specialUse', 'total', 'unseen'])
})

test('folders: create/rename/move/delete; refuza INBOX si speciale', async () => {
  const c = await S.req('ana', 'POST', '/api/mail/folders/create', { account: acc.id, parent: 'Clienti', name: 'Beta' })
  assert.deepEqual(c.json, { ok: true, path: 'Clienti/Beta' })
  assert.ok(W.folders.has('Clienti/Beta'))
  assert.equal((await S.req('ana', 'POST', '/api/mail/folders/create', { account: acc.id, parent: '', name: 'a/b' })).status, 400)
  assert.equal((await S.req('ana', 'POST', '/api/mail/folders/create', { account: acc.id, parent: 'Clienti', name: 'Beta' })).status, 409)
  const rn = await S.req('ana', 'POST', '/api/mail/folders/rename', { account: acc.id, path: 'Clienti/Beta', name: 'Gama' })
  assert.deepEqual(rn.json, { ok: true, path: 'Clienti/Gama' })
  const mv = await S.req('ana', 'POST', '/api/mail/folders/move', { account: acc.id, path: 'Clienti/Gama', parent: '' })
  assert.deepEqual(mv.json, { ok: true, path: 'Gama' })
  assert.equal((await S.req('ana', 'POST', '/api/mail/folders/move', { account: acc.id, path: 'Clienti', parent: 'Clienti/Alfa' })).status, 400)
  for (const p of ['INBOX', 'Trash', 'Sent']) {
    assert.equal((await S.req('ana', 'POST', '/api/mail/folders/delete', { account: acc.id, path: p })).status, 400, p)
    assert.equal((await S.req('ana', 'POST', '/api/mail/folders/rename', { account: acc.id, path: p, name: 'X' })).status, 400, p)
  }
  assert.deepEqual((await S.req('ana', 'POST', '/api/mail/folders/delete', { account: acc.id, path: 'Gama' })).json, { ok: true })
  assert.ok(!W.folders.has('Gama'))
})

test('folders/empty doar pe Trash/Junk', async () => {
  W.put('Trash', rawMessage({ subject: 'gunoi' }))
  assert.equal((await S.req('ana', 'POST', '/api/mail/folders/empty', { account: acc.id, path: 'Zeta' })).status, 400)
  const r = await S.req('ana', 'POST', '/api/mail/folders/empty', { account: acc.id, path: 'Trash' })
  assert.equal(r.json.ok, true)
  assert.equal(W.msgs('Trash').length, 0)
})

// §3 lista, paginare, filtre
test('messages: cele mai noi primele, paginare, forma Item', async () => {
  const p0 = await list({ page: 0, size: 3 })
  assert.equal(p0.json.total, 8)
  assert.deepEqual(p0.json.items.map((i) => i.uid), [8, 7, 6])
  const p2 = await list({ page: 2, size: 3 })
  assert.deepEqual(p2.json.items.map((i) => i.uid), [2, 1])
  const it = p2.json.items[1]
  assert.deepEqual(Object.keys(it).sort(), ['answered', 'categories', 'date', 'flagged', 'from', 'hasAttachments', 'messageId', 'preview', 'seen', 'size', 'subject', 'task', 'to', 'uid'].sort())
  assert.equal(it.subject, 'Factura octombrie')
  assert.deepEqual(it.from, { name: 'Contabil', address: 'conta@firma.ro' })
  assert.equal(it.seen, true)
  assert.equal(it.hasAttachments, true)
  assert.deepEqual(it.categories, [])
  assert.equal(it.task, null)
  const def = await list({})
  assert.equal(def.json.size, 50)
})

test('messages: filtre unread/flagged/attachments si cautare', async () => {
  assert.deepEqual((await list({ filter: 'unread' })).json.items.map((i) => i.uid), [7, 5, 3, 2])
  assert.deepEqual((await list({ filter: 'flagged' })).json.items.map((i) => i.uid), [7, 5, 3])
  assert.deepEqual((await list({ filter: 'attachments' })).json.items.map((i) => i.uid), [1])
  assert.deepEqual((await list({ q: 'factura' })).json.items.map((i) => i.uid), [1])
  assert.deepEqual((await list({ q: 'buletin 4' })).json.items.map((i) => i.uid), [])
  assert.deepEqual((await list({ q: 'buletin 4', inBody: '1' })).json.items.map((i) => i.uid), [7])
})

// §4 mesaj, cid, atasament, sursa
test('message: html curatat, cid rescris, imagini externe, atasamente', async () => {
  const r = await S.req('ana', 'GET', '/api/mail/message?' + q({ account: acc.id, folder: 'INBOX', uid: 2 }))
  assert.equal(r.status, 200)
  const m = r.json
  assert.equal(m.subject, 'Poza')
  assert.ok(!/<script/i.test(m.html))
  assert.ok(!/onclick/i.test(m.html))
  assert.ok(!/javascript:/i.test(m.html))
  const att = m.attachments.find((a) => a.filename === 'poza.png')
  assert.ok(att && att.inline && att.contentId === 'poza1@x')
  assert.ok(m.html.includes(`/api/mail/attachment?account=${acc.id}&amp;folder=INBOX&amp;uid=2&amp;part=${encodeURIComponent(att.id)}&amp;inline=1`), m.html)
  assert.ok(!m.html.includes('cid:'))
  assert.equal(m.hasRemoteImages, true)
  assert.ok(Array.isArray(m.events) && Array.isArray(m.suggestions) && Array.isArray(m.cc) && Array.isArray(m.references))
  assert.equal(m.seen, false, 'citirea nu marcheaza \\Seen')
  const img = await S.req('ana', 'GET', '/api/mail/attachment?' + q({ account: acc.id, folder: 'INBOX', uid: 2, part: att.id, inline: 1 }))
  assert.equal(img.status, 200)
  assert.equal(img.headers.get('content-type'), 'image/png')
  assert.match(img.headers.get('content-disposition'), /^inline;/)
  assert.deepEqual(img.buf, PNG)
})

test('attachment: filename* RFC 5987 si sursa', async () => {
  const m = (await S.req('ana', 'GET', '/api/mail/message?' + q({ account: acc.id, folder: 'INBOX', uid: 1 }))).json
  const pdf = m.attachments.find((a) => a.contentType === 'application/pdf')
  assert.equal(pdf.filename, 'factură.pdf')
  const r = await S.req('ana', 'GET', '/api/mail/attachment?' + q({ account: acc.id, folder: 'INBOX', uid: 1, part: pdf.id }))
  assert.equal(r.headers.get('content-disposition'), `attachment; filename="factura_.pdf"; filename*=UTF-8''factur%C4%83.pdf`)
  assert.equal(r.buf.toString(), '%PDF-1.4 test')
  assert.equal((await S.req('ana', 'GET', '/api/mail/attachment?' + q({ account: acc.id, folder: 'INBOX', uid: 1, part: '9.9' }))).status, 404)
  const src = await S.req('ana', 'GET', '/api/mail/source?' + q({ account: acc.id, folder: 'INBOX', uid: 1 }))
  assert.match(src.headers.get('content-type'), /^text\/plain/)
  assert.match(src.buf.toString(), /Subject: Factura octombrie/)
  assert.equal((await S.req('ana', 'GET', '/api/mail/message?' + q({ account: acc.id, folder: 'INBOX', uid: 999 }))).status, 404)
})

// §5 flaguri, mutare, stergere
test('flags, move, delete in Trash, delete in Trash = definitiv, archive creeaza Archive', async () => {
  const f = await S.req('ana', 'POST', '/api/mail/flags', { account: acc.id, folder: 'INBOX', uids: [2], add: ['\\Seen'], remove: [] })
  assert.deepEqual(f.json, { ok: true })
  assert.ok(W.msgs('INBOX').find((m) => m.uid === 2).flags.includes('\\Seen'))
  assert.equal((await S.req('ana', 'POST', '/api/mail/flags', { account: acc.id, folder: 'INBOX', uids: [2], add: ['\\Hack'] })).status, 400)
  assert.equal((await list({ filter: 'unread' })).json.total, 3, 'cache-ul listei e invalidat la flags')

  await S.req('ana', 'POST', '/api/mail/move', { account: acc.id, folder: 'INBOX', uids: [3], dest: 'Zeta' })
  assert.equal(W.msgs('Zeta').length, 1)
  assert.equal((await list({})).json.total, 7)

  const d = await S.req('ana', 'POST', '/api/mail/delete', { account: acc.id, folder: 'INBOX', uids: [4] })
  assert.deepEqual(d.json, { ok: true, dest: 'Trash' })
  assert.equal(W.msgs('Trash').length, 1)
  const tUid = W.msgs('Trash')[0].uid
  const d2 = await S.req('ana', 'POST', '/api/mail/delete', { account: acc.id, folder: 'Trash', uids: [tUid] })
  assert.equal(d2.json.permanent, true)
  assert.equal(W.msgs('Trash').length, 0)
  const d3 = await S.req('ana', 'POST', '/api/mail/delete', { account: acc.id, folder: 'Zeta', uids: [1], permanent: true })
  assert.equal(d3.json.permanent, true)
  assert.equal(W.msgs('Zeta').length, 0)

  const a = await S.req('ana', 'POST', '/api/mail/archive', { account: acc.id, folder: 'INBOX', uids: [5] })
  assert.deepEqual(a.json, { ok: true, dest: 'Archive' })
  assert.equal(W.msgs('Archive').length, 1)
  const fl = (await S.req('ana', 'GET', `/api/mail/folders?account=${acc.id}`)).json.folders.map((x) => x.path)
  assert.deepEqual(fl.slice(0, 6), ['INBOX', 'Drafts', 'Sent', 'Archive', 'Junk', 'Trash'])
})

test('pool: o singura conexiune reutilizata, SELECT doar la schimbarea folderului', async () => {
  const c0 = W.connects
  const s0 = W.selects
  await list({})
  await list({ page: 1, size: 2 })
  await S.req('ana', 'POST', '/api/mail/flags', { account: acc.id, folder: 'INBOX', uids: [6], add: ['\\Seen'] })
  assert.equal(W.connects, c0)
  assert.ok(W.selects - s0 <= 1, `select-uri: ${W.selects - s0}`)
})

test('pool: reconectare dupa close si o reincercare la caderea retelei in comanda', async () => {
  const c0 = W.connects
  W.last.kill()
  assert.equal((await list({})).status, 200)
  assert.equal(W.connects, c0 + 1)
  W.dropNext = true
  const r = await list({ q: 'reconectare' })
  assert.equal(r.status, 200)
  assert.equal(W.connects, c0 + 2)
  W.pass = 'alta'
  W.dropNext = true
  const fail = await list({ q: 'iar' })
  assert.equal(fail.status, 502)
  assert.deepEqual(fail.json, { eroare: 'Parola sau utilizatorul gresit' })
  W.pass = 'parolaA'
  assert.equal((await list({})).status, 200)
})

// §6 meta: categorii, taskuri
test('meta: categorii si task (+\\Flagged), lista de taskuri, filtru task, mutare pastreaza taskul', async () => {
  const r = await S.req('ana', 'POST', '/api/mail/meta', { account: acc.id, folder: 'INBOX', uids: [6, 7], addCategory: 'red' })
  assert.deepEqual(r.json, { ok: true })
  assert.equal((await S.req('ana', 'POST', '/api/mail/meta', { account: acc.id, folder: 'INBOX', uids: [6], addCategory: 'nuexista' })).status, 400)
  await S.req('ana', 'POST', '/api/mail/meta', { account: acc.id, folder: 'INBOX', uids: [6], task: { due: '2026-11-20T10:00:00Z', done: false } })
  assert.ok(W.msgs('INBOX').find((m) => m.uid === 6).flags.includes('\\Flagged'))
  const items = (await list({})).json.items
  const i6 = items.find((i) => i.uid === 6)
  assert.deepEqual(i6.categories, ['red'])
  assert.deepEqual(i6.task, { due: '2026-11-20T10:00:00.000Z', done: false })
  assert.deepEqual(items.find((i) => i.uid === 7).categories, ['red'])
  assert.deepEqual((await list({ filter: 'task' })).json.items.map((i) => i.uid), [6])
  const t = (await S.req('ana', 'GET', '/api/mail/tasks?done=0')).json.items
  assert.equal(t.length, 1)
  assert.deepEqual({ ...t[0], messageId: undefined }, { account: acc.id, folder: 'INBOX', uid: 6, messageId: undefined, subject: 'Știri 3', from: { name: 'Ana Pop', address: 'ana@exemplu.ro' }, date: t[0].date, due: '2026-11-20T10:00:00.000Z', done: false, categories: ['red'] })
  // mutare: taskul isi gaseste mesajul in destinatie (Message-ID)
  await S.req('ana', 'POST', '/api/mail/move', { account: acc.id, folder: 'INBOX', uids: [6], dest: 'Zeta' })
  const moved = (await S.req('ana', 'GET', '/api/mail/tasks')).json.items[0]
  assert.equal(moved.folder, 'Zeta')
  assert.equal(moved.uid, W.msgs('Zeta')[0].uid)
  const zl = (await S.req('ana', 'GET', '/api/mail/messages?' + q({ account: acc.id, folder: 'Zeta' }))).json.items[0]
  assert.deepEqual(zl.categories, ['red'])
  // task facut, apoi scos
  await S.req('ana', 'POST', '/api/mail/meta', { account: acc.id, folder: 'Zeta', uids: [moved.uid], task: { due: null, done: true } })
  assert.equal((await S.req('ana', 'GET', '/api/mail/tasks?done=1')).json.items.length, 1)
  assert.equal((await S.req('ana', 'GET', '/api/mail/tasks?done=0')).json.items.length, 0)
  await S.req('ana', 'POST', '/api/mail/meta', { account: acc.id, folder: 'Zeta', uids: [moved.uid], task: null, categories: [] })
  assert.ok(!W.msgs('Zeta')[0].flags.includes('\\Flagged'))
  assert.equal((await S.req('ana', 'GET', '/api/mail/tasks?done=1')).json.items.length, 0)
})

test('contacts: cautare fara diacritice, max 10', async () => {
  const common = require('../src/api-common')
  await common.addContacts('ana', [{ name: 'Ștefan Ionescu', address: 'Stefan@Firma.ro' }, { name: 'Maria', address: 'maria@x.ro' }])
  for (let i = 0; i < 15; i++) await common.addContacts('ana', [{ name: '', address: `c${i}@firma.ro` }])
  assert.deepEqual((await S.req('ana', 'GET', '/api/mail/contacts?q=stef')).json.items, [{ name: 'Ștefan Ionescu', address: 'stefan@firma.ro' }])
  assert.equal((await S.req('ana', 'GET', '/api/mail/contacts?q=firma')).json.items.length, 10)
})
