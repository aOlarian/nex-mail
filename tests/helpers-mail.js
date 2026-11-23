'use strict'
/* MAP
 * §1 imports                            L12-L19
 * §2 lumea IMAP in memorie              L20-L57
 * §3 FakeImap (contract proto)          L58-L233
 * §4 constructor de mesaje              L234-L250
 * §5 pornire serviciu + cereri          L251-L290
 */
// Dubla IMAP in memorie dupa contractul din docs/plan-mail.md; mesajele sunt construite cu
// proto/build real si citite cu proto/mime real, ca testele sa prinda nepotrivirile dintre module.

// §1 imports
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { build } = require('../proto/build')
const mime = require('../proto/mime')

// §2 lumea IMAP in memorie
const worlds = new Map() // user IMAP → lume

function makeWorld(user, pass, opts = {}) {
  const w = {
    pass,
    delimiter: '/',
    folders: new Map(),
    connects: 0,
    selects: 0,
    down: false,
    failAppend: false,
    calls: [],
  }
  const add = (p, specialUse) => w.folders.set(p, { specialUse: specialUse || null, uidvalidity: 1000 + w.folders.size, uidnext: 1, messages: [] })
  add('INBOX')
  for (const [p, use] of opts.folders || [['Sent', '\\Sent'], ['Drafts', '\\Drafts'], ['Trash', '\\Trash'], ['Junk', '\\Junk']]) add(p, use)
  w.addFolder = add
  w.put = (folder, raw, flags = []) => {
    const f = w.folders.get(folder)
    const uid = f.uidnext++
    f.messages.push({ uid, raw: Buffer.from(raw), flags: [...flags], internalDate: new Date().toISOString() })
    return uid
  }
  w.msgs = (folder) => w.folders.get(folder).messages
  worlds.set(user, w)
  return w
}

function err(code, message) {
  return Object.assign(new Error(message), { code })
}

function parsedOf(m) {
  if (!m.parsed) m.parsed = mime.parse(m.raw)
  return m.parsed
}

// §3 FakeImap (contract proto)
class FakeImap extends EventEmitter {
  constructor(cfg) {
    super()
    this.cfg = cfg
    this.w = worlds.get(cfg.user)
    this.closed = true
    this.mailbox = null
  }

  async connect() {
    if (!this.w || this.w.down) throw err('CONNECT', 'connect ECONNREFUSED')
    if (this.cfg.pass !== this.w.pass) throw err('AUTH', 'NO [AUTHENTICATIONFAILED] Invalid credentials')
    this.w.connects++
    this.w.last = this
    this.closed = false
  }

  async logout() {
    this.closed = true
    this.emit('close')
  }

  kill() {
    this.closed = true
    this.emit('close')
  }

  folder(p) {
    const f = this.w.folders.get(p)
    if (!f) throw err('NO', 'NO [NONEXISTENT] Mailbox does not exist')
    return f
  }

  sel() {
    if (this.closed) throw err('CLOSED', 'closed')
    if (!this.mailbox) throw err('BAD', 'No mailbox selected')
    return this.folder(this.mailbox)
  }

  async list() {
    return [...this.w.folders.entries()].map(([p, f]) => ({ path: p, name: p.split('/').pop(), delimiter: '/', specialUse: f.specialUse, flags: [], noselect: false }))
  }

  async status(p) {
    const f = this.folder(p)
    return { messages: f.messages.length, unseen: f.messages.filter((m) => !m.flags.includes('\\Seen')).length, uidnext: f.uidnext, uidvalidity: f.uidvalidity }
  }

  async select(p) {
    const f = this.folder(p)
    this.w.selects++
    this.mailbox = p
    return { exists: f.messages.length, uidvalidity: f.uidvalidity, uidnext: f.uidnext }
  }

  async examine(p) {
    return this.select(p)
  }

  async search(q) {
    const f = this.sel()
    this.w.calls.push(['search', q])
    if (this.w.dropNext) {
      // conexiunea cade in mijlocul comenzii (retea)
      this.w.dropNext = false
      this.kill()
      throw err('CLOSED', 'connection closed')
    }
    const all = f.messages.map((m) => m.uid)
    if (q === 'ALL') return all
    if (typeof q === 'string') {
      let m = /^UID (\d+):\*$/.exec(q)
      // Ca serverele reale: n:* intoarce mereu si ultimul mesaj, chiar daca uid < n.
      if (m) return all.filter((u) => u >= +m[1]).concat(all.length ? [Math.max(...all)] : []).filter((u, i, a) => a.indexOf(u) === i)
      m = /^HEADER Message-ID "<(.+)>"$/.exec(q)
      if (m) return f.messages.filter((x) => String(parsedOf(x).messageId || '').replace(/^<|>$/g, '') === m[1]).map((x) => x.uid)
      throw err('BAD', 'unsupported search ' + q)
    }
    const lc = (s) => String(s || '').toLowerCase()
    const addrs = (l) => (l || []).map((a) => `${a.name} ${a.address}`).join(' ')
    return f.messages
      .filter((x) => {
        const p = parsedOf(x)
        if (q.unseen && x.flags.includes('\\Seen')) return false
        if (q.flagged && !x.flags.includes('\\Flagged')) return false
        if (q.text && ![p.subject, addrs(p.from), addrs(p.to)].some((s) => lc(s).includes(lc(q.text)))) return false
        if (q.body && !lc(p.text).includes(lc(q.body))) return false
        return true
      })
      .map((x) => x.uid)
  }

  async fetchHeaders(uids) {
    const f = this.sel()
    return f.messages
      .filter((m) => uids.includes(m.uid))
      .map((m) => {
        const p = parsedOf(m)
        return {
          uid: m.uid,
          flags: [...m.flags],
          internalDate: m.internalDate,
          size: m.raw.length,
          envelope: { date: p.date, subject: p.subject || '', from: p.from || [], to: p.to || [], cc: p.cc || [], replyTo: p.replyTo || [], messageId: p.messageId, inReplyTo: p.inReplyTo },
          hasAttachments: (p.attachments || []).some((a) => !a.inline),
          preview: String(p.text || '').slice(0, 200),
        }
      })
  }

  async fetchRaw(uid, max) {
    const m = this.sel().messages.find((x) => x.uid === uid)
    if (!m) return null
    return max ? m.raw.subarray(0, max) : m.raw
  }

  async addFlags(uids, flags) {
    for (const m of this.sel().messages) if (uids.includes(m.uid)) for (const fl of flags) if (!m.flags.includes(fl)) m.flags.push(fl)
  }

  async removeFlags(uids, flags) {
    for (const m of this.sel().messages) if (uids.includes(m.uid)) m.flags = m.flags.filter((x) => !flags.includes(x))
  }

  async copy(uids, dest) {
    const d = this.folder(dest)
    for (const m of this.sel().messages.filter((x) => uids.includes(x.uid))) d.messages.push({ ...m, uid: d.uidnext++, flags: [...m.flags] })
  }

  async move(uids, dest) {
    this.w.calls.push(['move', uids, dest])
    await this.copy(uids, dest)
    const f = this.sel()
    f.messages = f.messages.filter((m) => !uids.includes(m.uid))
  }

  async expunge(uids) {
    this.w.calls.push(['expunge', uids])
    const f = this.sel()
    f.messages = f.messages.filter((m) => !uids.includes(m.uid))
  }

  async append(p, raw, flags) {
    if (this.w.failAppend) throw err('NO', 'NO append refused')
    const f = this.folder(p)
    const uid = f.uidnext++
    f.messages.push({ uid, raw: Buffer.from(raw), flags: [...(flags || [])], internalDate: new Date().toISOString() })
    return uid
  }

  async create(p) {
    if (this.w.folders.has(p)) throw err('NO', 'NO [ALREADYEXISTS]')
    this.w.addFolder(p)
  }

  async rename(a, b) {
    for (const [p, f] of [...this.w.folders]) {
      if (p === a || p.startsWith(a + '/')) {
        this.w.folders.delete(p)
        this.w.folders.set(b + p.slice(a.length), f)
      }
    }
  }

  async delete(p) {
    this.folder(p)
    this.w.folders.delete(p)
    if (this.mailbox === p) this.mailbox = null
  }

  async subscribe() {}

  async noop() {}
}

// §4 constructor de mesaje
let seq = 0
function rawMessage(o = {}) {
  seq++
  return build({
    from: o.from || { name: 'Ana Pop', address: 'ana@exemplu.ro' },
    to: o.to || [{ name: 'Eu', address: 'eu@firma.ro' }],
    cc: o.cc || [],
    subject: o.subject !== undefined ? o.subject : `Mesaj ${seq}`,
    html: o.html !== undefined ? o.html : `<p>${o.text || 'Salut ' + seq}</p>`,
    text: o.text,
    attachments: o.attachments || [],
    date: o.date || new Date(Date.UTC(2026, 10, 1, 10, seq % 60)),
    messageId: o.messageId,
  }).raw
}

// §5 pornire serviciu + cereri
async function startService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-mail-test-'))
  process.env.NEX_MAIL_DATA = dir
  const store = require('../src/store')
  store.resetForTests()
  require('../src/pool').setConnector((cfg) => new FakeImap(cfg))
  const svc = require('../serviciu')
  const server = await svc.start({ port: 0, sync: false, identity: (req) => String(req.headers['x-nex-user'] || '').trim().toLowerCase() })
  const base = `http://127.0.0.1:${server.address().port}`

  async function req(user, method, p, body) {
    const headers = {}
    if (user) headers['x-nex-user'] = user
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const buf = Buffer.from(await res.arrayBuffer())
    let json = null
    if (/json/.test(res.headers.get('content-type') || '')) json = JSON.parse(buf.toString('utf8'))
    return { status: res.status, json, buf, headers: res.headers }
  }

  async function addAccount(user, imapUser, pass, extra = {}) {
    const r = await req(user, 'POST', '/api/mail/accounts/save', {
      name: 'Cont ' + imapUser, email: imapUser, user: imapUser, password: pass,
      imap: { host: 'imap.test.local', port: 993, secure: true }, smtp: { host: 'smtp.test.local', port: 465, secure: true }, ...extra,
    })
    if (r.status !== 200) throw new Error('addAccount ' + r.status + ' ' + JSON.stringify(r.json))
    return r.json
  }

  async function stop() {
    await svc.stop(server)
    fs.rmSync(dir, { recursive: true, force: true })
  }

  return { dir, base, req, addAccount, stop, store }
}

module.exports = { makeWorld, worlds, FakeImap, rawMessage, startService }
