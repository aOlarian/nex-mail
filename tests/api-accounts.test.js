'use strict'
/* MAP
 * §1 pregatire                          L9-L23
 * §2 autentificare si izolare           L24-L57
 * §3 parole criptate, CRUD              L58-L107
 * §4 test cont, autoconfig              L108-L165
 * §5 setari, categorii, statice         L166-L211
 */
// §1 pregatire
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { makeWorld, startService } = require('./helpers-mail')

let S
test.before(async () => {
  S = await startService()
  makeWorld('ana@firma.ro', 'parolaA')
  makeWorld('bogdan@firma.ro', 'parolaB')
})
test.after(() => S.stop())

// §2 autentificare si izolare
test('fara antet sau cu user invalid → 401', async () => {
  assert.equal((await S.req(null, 'GET', '/api/mail/state')).status, 401)
  assert.equal((await S.req('..', 'GET', '/api/mail/state')).status, 401)
  assert.equal((await S.req('a b', 'GET', '/api/mail/state')).status, 401)
  assert.equal((await S.req('x'.repeat(65), 'GET', '/api/mail/state')).status, 401)
  const ok = await S.req('  Ana  ', 'GET', '/api/mail/state')
  assert.equal(ok.status, 200)
  assert.equal(ok.json.user, 'ana')
})

test('userul B nu vede si nu poate atinge conturile lui A', async () => {
  const a = await S.addAccount('ana', 'ana@firma.ro', 'parolaA')
  const stB = await S.req('bogdan', 'GET', '/api/mail/state')
  assert.deepEqual(stB.json.accounts, [])
  const f = await S.req('bogdan', 'GET', `/api/mail/folders?account=${a.id}`)
  assert.equal(f.status, 404)
  const d = await S.req('bogdan', 'POST', '/api/mail/accounts/delete', { id: a.id })
  assert.equal(d.status, 404)
  const stA = await S.req('ana', 'GET', '/api/mail/state')
  assert.equal(stA.json.accounts.length, 1)
  assert.ok(fs.existsSync(path.join(S.dir, 'users', 'ana', 'accounts.json')))
  assert.deepEqual(S.store.read('bogdan', 'accounts.json').accounts, [])
  assert.equal(S.store.read('ana', 'accounts.json').accounts.length, 1)
})

test('ruta necunoscuta → 404, metoda gresita → 405, JSON invalid → 400', async () => {
  assert.equal((await S.req('ana', 'GET', '/api/mail/nimic')).status, 404)
  assert.equal((await S.req('ana', 'GET', '/api/mail/settings')).status, 405)
  const r = await fetch(S.base + '/api/mail/settings', { method: 'POST', headers: { 'x-nex-user': 'ana' }, body: '{nu' })
  assert.equal(r.status, 400)
  assert.ok((await r.json()).eroare)
})

// §3 parole criptate, CRUD
test('parola criptata pe disc, niciodata in API', async () => {
  const acc = await S.addAccount('cripto', 'ana@firma.ro', 'Parola-Secreta-123')
  assert.equal(acc.hasPassword, true)
  assert.equal(acc.password, undefined)
  const disk = fs.readFileSync(path.join(S.dir, 'users', 'cripto', 'accounts.json'), 'utf8')
  assert.ok(!disk.includes('Parola-Secreta-123'))
  const saved = JSON.parse(disk).accounts[0].password
  assert.ok(saved.iv && saved.tag && saved.data)
  const st = await S.req('cripto', 'GET', '/api/mail/state')
  assert.ok(!JSON.stringify(st.json).includes('Parola-Secreta'))
  assert.ok(!JSON.stringify(st.json).includes(saved.data))
  assert.equal(S.store.getPassword('cripto', acc.id), 'Parola-Secreta-123')
  // key.bin: 32 octeti, nu se regenereaza
  const key1 = fs.readFileSync(path.join(S.dir, 'key.bin'))
  assert.equal(key1.length, 32)
  S.store.resetForTests()
  assert.equal(S.store.getPassword('cripto', acc.id), 'Parola-Secreta-123')
  assert.deepEqual(fs.readFileSync(path.join(S.dir, 'key.bin')), key1)
})

test('save fara parola pastreaza parola; editare; validare; delete curata meta si sync', async () => {
  const acc = await S.addAccount('crud', 'ana@firma.ro', 'parolaA')
  const ed = await S.req('crud', 'POST', '/api/mail/accounts/save', { ...acc, name: 'Birou', password: '', insecureTls: true })
  assert.equal(ed.status, 200)
  assert.equal(ed.json.name, 'Birou')
  assert.equal(ed.json.insecureTls, true)
  assert.equal(ed.json.hasPassword, true)
  assert.equal(S.store.getPassword('crud', acc.id), 'parolaA')
  assert.deepEqual(ed.json.status, { ok: true, error: null, lastSync: null })
  const bad = await S.req('crud', 'POST', '/api/mail/accounts/save', { email: 'nu-e-email', imap: { host: 'x.ro' }, smtp: { host: 'y.ro' } })
  assert.equal(bad.status, 400)
  const badHost = await S.req('crud', 'POST', '/api/mail/accounts/save', { email: 'a@b.ro', imap: { host: 'x y' }, smtp: { host: 'y.ro' } })
  assert.equal(badHost.status, 400)
  const ghost = await S.req('crud', 'POST', '/api/mail/accounts/save', { id: 'nuexista', email: 'a@b.ro', imap: { host: 'x.ro' }, smtp: { host: 'y.ro' } })
  assert.equal(ghost.status, 404)
  await S.store.update('crud', 'meta.json', (m) => {
    m[`${acc.id}|abc@x`] = { categories: ['red'], task: null }
    m['altcont|abc@x'] = { categories: ['red'], task: null }
  })
  await S.store.update('crud', 'sync.json', (s) => {
    s[acc.id] = { lastUid: 5 }
  })
  const del = await S.req('crud', 'POST', '/api/mail/accounts/delete', { id: acc.id })
  assert.deepEqual(del.json, { ok: true })
  assert.deepEqual(Object.keys(S.store.read('crud', 'meta.json')), ['altcont|abc@x'])
  assert.equal(S.store.read('crud', 'sync.json')[acc.id], undefined)
  assert.equal((await S.req('crud', 'GET', '/api/mail/state')).json.accounts.length, 0)
})

// §4 test cont, autoconfig
test('accounts/test: IMAP real-dublura + SMTP dublura, cu mesaje umane', async () => {
  const common = require('../src/api-common')
  common.setSmtp({
    verify: async (cfg) => {
      if (cfg.pass !== 'parolaA') throw Object.assign(new Error('535 auth'), { code: 'AUTH' })
      return true
    },
  })
  const body = { email: 'ana@firma.ro', user: 'ana@firma.ro', imap: { host: 'imap.test.local', port: 993, secure: true }, smtp: { host: 'smtp.test.local', port: 465, secure: true } }
  const ok = await S.req('ana', 'POST', '/api/mail/accounts/test', { ...body, password: 'parolaA' })
  assert.deepEqual(ok.json, { imap: { ok: true, error: null }, smtp: { ok: true, error: null } })
  const bad = await S.req('ana', 'POST', '/api/mail/accounts/test', { ...body, password: 'gresit' })
  assert.deepEqual(bad.json.imap, { ok: false, error: 'Parola sau utilizatorul gresit' })
  assert.deepEqual(bad.json.smtp, { ok: false, error: 'Parola sau utilizatorul gresit' })
  // fara parola + id existent → parola salvata
  const acc = (await S.req('ana', 'GET', '/api/mail/state')).json.accounts[0]
  const saved = await S.req('ana', 'POST', '/api/mail/accounts/test', { ...body, id: acc.id })
  assert.equal(saved.json.imap.ok, true)
  // server cazut si certificat invalid
  const { worlds } = require('./helpers-mail')
  worlds.get('ana@firma.ro').down = true
  const down = await S.req('ana', 'POST', '/api/mail/accounts/test', { ...body, password: 'parolaA' })
  assert.equal(down.json.imap.error, 'Serverul nu raspunde')
  worlds.get('ana@firma.ro').down = false
  common.setSmtp({ verify: async () => { throw Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }) } })
  const tls = await S.req('ana', 'POST', '/api/mail/accounts/test', { ...body, password: 'parolaA' })
  assert.match(tls.json.smtp.error, /^Certificat TLS invalid/)
  common.setSmtp(null)
})

test('autoconfig: furnizori cunoscuti, MX si proba TCP', async () => {
  const accounts = require('../src/api-accounts')
  const probed = []
  accounts.setAutoconfigDeps({
    resolveMx: async (d) => (d === 'firma.ro' ? [{ exchange: 'mx2.host.ro', priority: 20 }, { exchange: 'mx1.host.ro', priority: 10 }] : d === 'gfirma.ro' ? [{ exchange: 'aspmx.l.google.com', priority: 1 }] : []),
    probe: async (host, port) => {
      probed.push(`${host}:${port}`)
      return (host === 'imap.firma.ro' && port === 993) || (host === 'mx1.host.ro' && port === 587)
    },
  })
  const g = await S.req('ana', 'POST', '/api/mail/accounts/autoconfig', { email: 'x@gmail.com' })
  assert.deepEqual(g.json.imap, { host: 'imap.gmail.com', port: 993, secure: true })
  const o = await S.req('ana', 'POST', '/api/mail/accounts/autoconfig', { email: 'x@hotmail.com' })
  assert.deepEqual(o.json.smtp, { host: 'smtp.office365.com', port: 587, secure: false })
  const gw = await S.req('ana', 'POST', '/api/mail/accounts/autoconfig', { email: 'x@gfirma.ro' })
  assert.equal(gw.json.imap.host, 'imap.gmail.com')
  const r = await S.req('ana', 'POST', '/api/mail/accounts/autoconfig', { email: 'x@firma.ro' })
  assert.deepEqual(r.json.imap, { host: 'imap.firma.ro', port: 993, secure: true })
  assert.deepEqual(r.json.smtp, { host: 'mx1.host.ro', port: 587, secure: false })
  assert.equal(r.json.guessed, true)
  assert.ok(probed.includes('mail.firma.ro:993'))
  const none = await S.req('ana', 'POST', '/api/mail/accounts/autoconfig', { email: 'x@nimic.ro' })
  assert.equal(none.json.imap.host, 'mail.nimic.ro')
  assert.deepEqual(none.json.reachable, { imap: false, smtp: false })
  assert.equal((await S.req('ana', 'POST', '/api/mail/accounts/autoconfig', { email: 'gresit' })).status, 400)
})

// §5 setari, categorii, statice
test('state implicit: setari, categorii Outlook in engleza, unread, accountGroups, filteredFolders', async () => {
  const st = (await S.req('nou', 'GET', '/api/mail/state')).json
  assert.deepEqual(st.settings, { theme: 'light', density: 'comfortable', fontSize: 'normal', readingPane: 'right', markReadSeconds: 2, showImages: 'ask', pollSeconds: 120, pageSize: 50, autoCalendar: true })
  assert.deepEqual(st.categories.map((c) => c.name), ['Important', 'Follow up', 'Waiting', 'Done', 'Client', 'Personal'])
  assert.deepEqual(st.accountGroups, [])
  assert.deepEqual(st.filteredFolders.map((f) => f.name), ['SPAM', 'SCAM', 'Newsletter', 'Ignore'])
  assert.ok(st.categories.every((c) => /^#[0-9a-f]{6}$/.test(c.color)))
  assert.deepEqual(st.unread, { total: 0, byAccount: {} })
  assert.deepEqual((await S.req('nou', 'GET', '/api/mail/unread')).json, { total: 0 })
})

test('settings partiale, categorii si semnaturi', async () => {
  const s = await S.req('set', 'POST', '/api/mail/settings', { theme: 'dark', pollSeconds: 5, pageSize: 999, necunoscut: 1 })
  assert.equal(s.json.theme, 'dark')
  assert.equal(s.json.pollSeconds, 60)
  assert.equal(s.json.pageSize, 200)
  assert.equal(s.json.necunoscut, undefined)
  assert.equal((await S.req('set', 'POST', '/api/mail/settings', { theme: 'roz' })).status, 400)
  assert.equal((await S.req('set', 'POST', '/api/mail/settings', { theme: 'amber-dark' })).json.theme, 'amber-dark')
  assert.equal((await S.req('set', 'POST', '/api/mail/settings', { theme: 'nex' })).json.theme, 'nex')
  assert.equal((await S.req('set', 'POST', '/api/mail/settings', { fontSize: 'huge' })).status, 400)
  assert.equal((await S.req('set', 'POST', '/api/mail/settings', { fontSize: 'xxlarge' })).json.fontSize, 'xxlarge')
  await S.req('set', 'POST', '/api/mail/settings', { theme: 'dark', fontSize: 'normal' })
  const c = await S.req('set', 'POST', '/api/mail/categories', { categories: [{ id: 'red', name: 'Urgent', color: '#FF0000' }, { name: 'Nou', color: '#00ff00' }] })
  assert.equal(c.json.length, 2)
  assert.equal(c.json[0].color, '#ff0000')
  assert.ok(c.json[1].id)
  assert.equal((await S.req('set', 'POST', '/api/mail/categories', { categories: [{ name: 'X', color: 'rosu' }] })).status, 400)
  const sig = await S.req('set', 'POST', '/api/mail/signatures', { signatures: [{ name: 'Birou', html: '<p>Ana</p>' }] })
  assert.equal(sig.json[0].html, '<p>Ana</p>')
  const st = (await S.req('set', 'GET', '/api/mail/state')).json
  assert.equal(st.settings.theme, 'dark')
  assert.equal(st.signatures.length, 1)
})

test('fisiere statice: doar nume simple din web/', async () => {
  assert.equal((await S.req(null, 'GET', '/mail')).status, 401)
  const idx = await S.req('set', 'GET', '/mail')
  assert.ok(idx.status === 200 || idx.status === 404)
  if (idx.status === 200) {
    assert.match(idx.headers.get('content-type'), /text\/html/)
    assert.equal(idx.headers.get('cache-control'), 'no-store')
  }
  assert.equal((await S.req('set', 'GET', '/mail/assets/..%2Fserviciu.js')).status, 404)
  assert.equal((await S.req('set', 'GET', '/mail/assets/serviciu.exe')).status, 404)
  const js = await S.req('set', 'GET', '/mail/assets/mail-api.js')
  if (fs.existsSync(path.join(__dirname, '..', 'web', 'mail-api.js'))) {
    assert.equal(js.status, 200)
    assert.match(js.headers.get('content-type'), /javascript/)
  }
})
