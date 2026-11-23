'use strict'
/* MAP
 * §1 pregatire                          L8-L33
 * §2 trimitere                          L34-L71
 * §3 forward, inline, erori             L72-L116
 * §4 ciorne                             L117-L126
 */
// §1 pregatire
const test = require('node:test')
const assert = require('node:assert/strict')
const mime = require('../proto/mime')
const { makeWorld, rawMessage, startService } = require('./helpers-mail')

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
let S
let W
let acc
let sent = []
let failSmtp = null
let origUid
test.before(async () => {
  S = await startService()
  W = makeWorld('ana@firma.ro', 'parolaA', { folders: [['Drafts', '\\Drafts'], ['Trash', '\\Trash']] })
  origUid = W.put('INBOX', rawMessage({ subject: 'Oferta', html: '<p>Logo: <img src="cid:logo@x"></p>', attachments: [{ filename: 'oferta.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF oferta') }, { filename: 'logo.png', contentType: 'image/png', content: PNG, contentId: 'logo@x' }] }))
  acc = await S.addAccount('ana', 'ana@firma.ro', 'parolaA')
  require('../src/api-compose').setSender(async (cfg, m) => {
    if (failSmtp) throw failSmtp
    sent.push({ cfg, m })
    return { accepted: m.recipients, rejected: [], response: '250 ok' }
  })
})
test.after(() => S.stop())

// §2 trimitere
test('send: adrese din string si liste, Bcc doar in plic, copie in Sent creata cu \\Seen, contacte', async () => {
  const r = await S.req('ana', 'POST', '/api/mail/send', {
    account: acc.id, to: 'Ion Pop <ion@x.ro>, maria@y.ro', cc: [{ name: 'Șef', address: 'sef@firma.ro' }], bcc: 'ascuns@z.ro',
    subject: 'Raport săptămânal', html: '<p>Bună ziua, atașez raportul.</p>', attachments: [{ filename: 'raport.txt', contentType: 'text/plain', dataB64: Buffer.from('date').toString('base64') }],
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.equal(r.json.sentSaved, true)
  assert.ok(r.json.messageId)
  const { cfg, m } = sent.at(-1)
  assert.deepEqual([cfg.host, cfg.port, cfg.secure, cfg.user, cfg.pass, cfg.rejectUnauthorized], ['smtp.test.local', 465, true, 'ana@firma.ro', 'parolaA', true])
  assert.equal(m.from, 'ana@firma.ro')
  assert.deepEqual(m.recipients.sort(), ['ascuns@z.ro', 'ion@x.ro', 'maria@y.ro', 'sef@firma.ro'])
  const p = mime.parse(m.raw)
  assert.equal(p.subject, 'Raport săptămânal')
  assert.ok(!/^bcc:/im.test(m.raw.toString()))
  assert.ok(p.attachments.some((a) => a.filename === 'raport.txt'))
  assert.ok(W.folders.has('Sent'), 'Sent lipsea → creat')
  const copy = W.msgs('Sent')
  assert.equal(copy.length, 1)
  assert.deepEqual(copy[0].flags, ['\\Seen'])
  assert.deepEqual(copy[0].raw, m.raw)
  const contacts = (await S.req('ana', 'GET', '/api/mail/contacts?q=sef')).json.items
  assert.deepEqual(contacts, [{ name: 'Șef', address: 'sef@firma.ro' }])
})

test('send cu replyTo → \\Answered pe original; draft vechi sters dupa trimitere', async () => {
  const d = await S.req('ana', 'POST', '/api/mail/draft', { account: acc.id, to: 'ion@x.ro', subject: 'Re: Oferta', html: '<p>ciorna</p>' })
  assert.equal(d.json.folder, 'Drafts')
  const r = await S.req('ana', 'POST', '/api/mail/send', { account: acc.id, to: 'ion@x.ro', subject: 'Re: Oferta', html: '<p>Multumesc</p>', inReplyTo: '<orig@x>', references: ['<orig@x>'], replyTo: { folder: 'INBOX', uid: origUid }, draft: { folder: d.json.folder, uid: d.json.uid } })
  assert.equal(r.json.ok, true)
  assert.ok(W.msgs('INBOX').find((x) => x.uid === origUid).flags.includes('\\Answered'))
  assert.equal(W.msgs('Drafts').length, 0)
  const p = mime.parse(sent.at(-1).m.raw)
  assert.equal(p.inReplyTo, '<orig@x>')
})

// §3 forward, inline, erori
test('forward: atasamentele originalului + imaginea inline citata devine cid:', async () => {
  const m = (await S.req('ana', 'GET', `/api/mail/message?account=${acc.id}&folder=INBOX&uid=${origUid}`)).json
  assert.ok(m.html.includes('/api/mail/attachment?'))
  const r = await S.req('ana', 'POST', '/api/mail/send', { account: acc.id, to: 'x@y.ro', subject: 'Fw: Oferta', html: `<p>Vezi mai jos</p><blockquote>${m.html}</blockquote>`, forward: { folder: 'INBOX', uid: origUid } })
  assert.equal(r.json.ok, true)
  const p = mime.parse(sent.at(-1).m.raw)
  assert.ok(p.attachments.some((a) => a.filename === 'oferta.pdf' && a.content.toString() === '%PDF oferta'))
  const logo = p.attachments.find((a) => a.contentType === 'image/png')
  assert.ok(logo && logo.contentId, 'imaginea pleaca inline')
  assert.ok(p.html.includes('cid:' + logo.contentId), p.html)
  assert.ok(!p.html.includes('/api/mail/attachment'))
})

test('erori: fara destinatari 400, adresa invalida 400, SMTP cazut 502 fara copie, APPEND esuat → sentSaved:false', async () => {
  assert.equal((await S.req('ana', 'POST', '/api/mail/send', { account: acc.id, to: '', subject: 'x', html: '' })).status, 400)
  const bad = await S.req('ana', 'POST', '/api/mail/send', { account: acc.id, to: [{ address: 'nu e adresa' }], subject: 'x', html: '' })
  assert.equal(bad.status, 400)
  const n = W.msgs('Sent').length
  failSmtp = Object.assign(new Error('535 5.7.8 auth failed for parolaA'), { code: 'AUTH' })
  const f = await S.req('ana', 'POST', '/api/mail/send', { account: acc.id, to: 'a@b.ro', subject: 'x', html: '<p>x</p>' })
  failSmtp = null
  assert.equal(f.status, 502)
  assert.deepEqual(f.json, { eroare: 'Parola sau utilizatorul gresit' })
  assert.equal(W.msgs('Sent').length, n)
  W.failAppend = true
  const s = await S.req('ana', 'POST', '/api/mail/send', { account: acc.id, to: 'a@b.ro', subject: 'x', html: '<p>x</p>' })
  W.failAppend = false
  assert.deepEqual([s.json.ok, s.json.sentSaved], [true, false])
})

test('send: imaginile data:image/png;base64 din semnatura devin parti inline cid: deduplicate', async () => {
  const b64 = PNG.toString('base64')
  const r = await S.req('ana', 'POST', '/api/mail/send', {
    account: acc.id, to: 'x@y.ro', subject: 'Semnatura',
    html: `<p>Sal</p><img src="data:image/png;base64,${b64}"><img src="data:image/png;base64,${b64}">`,
  })
  assert.equal(r.json.ok, true)
  const p = mime.parse(sent.at(-1).m.raw)
  const inline = p.attachments.filter((a) => a.contentType === 'image/png' && a.contentId)
  assert.equal(inline.length, 1, 'imagini identice deduplicate intr-o singura parte cid:')
  assert.ok(!p.html.includes('data:image/png'), p.html)
  assert.equal((p.html.match(new RegExp('cid:' + inline[0].contentId, 'g')) || []).length, 2)
})

// §4 ciorne
test('draft: \\Draft \\Seen in Drafts; a doua salvare inlocuieste ciorna veche', async () => {
  const a = await S.req('ana', 'POST', '/api/mail/draft', { account: acc.id, to: '', subject: 'Ciorna 1', html: '<p>v1</p>' })
  assert.equal(a.json.ok, true)
  assert.deepEqual(W.msgs('Drafts').find((x) => x.uid === a.json.uid).flags, ['\\Draft', '\\Seen'])
  const b = await S.req('ana', 'POST', '/api/mail/draft', { account: acc.id, to: 'ion@x.ro', subject: 'Ciorna 1', html: '<p>v2</p>', draft: { folder: a.json.folder, uid: a.json.uid } })
  assert.notEqual(b.json.uid, a.json.uid)
  assert.deepEqual(W.msgs('Drafts').map((x) => x.uid), [b.json.uid])
  assert.match(mime.parse(W.msgs('Drafts')[0].raw).html, /v2/)
})
