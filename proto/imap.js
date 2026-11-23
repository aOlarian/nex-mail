/* MAP
 * §1 imports            L12-L18
 * §2 class & lifecycle  L20-L104
 * §3 authentication     L106-L137
 * §4 folders            L139-L203
 * §5 mailbox state      L205-L232
 * §6 search             L234-L249
 * §7 exports            L251-L252
 */
'use strict';

// §1 imports
const { EventEmitter } = require('events');
const { ImapConn, imapError } = require('./imap-conn');
const { str } = require('./imap-parse');
const utf7 = require('./utf7');
const cmd = require('./imap-cmd');
const ops = require('./imap-ops');

// §2 class & lifecycle
// Client IMAP. Apelurile concurente se pun la coada in ImapConn (o comanda in zbor).
class Imap extends EventEmitter {
  constructor(opts) {
    super();
    const o = opts || {};
    this.opts = {
      host: o.host, port: Number(o.port) || (o.secure === false ? 143 : 993), secure: o.secure !== false,
      user: o.user, pass: o.pass, rejectUnauthorized: o.rejectUnauthorized !== false,
      timeoutMs: Number(o.timeoutMs) || 30000,
      // doar pentru teste pe loopback: permite LOGIN fara TLS
      allowInsecureAuth: o.allowInsecureAuth === true,
    };
    this.caps = new Set();
    this.conn = null;
    this.mailbox = null;
    this.delimiter = null;
  }

  get closed() { return !this.conn || this.conn.closed; }

  async connect() {
    const conn = new ImapConn(this.opts);
    this.conn = conn;
    conn.on('capability', (resp) => this.setCaps(resp));
    conn.on('exists', (n) => this.emit('exists', n));
    conn.on('expunge', (n) => this.emit('expunge', n));
    conn.on('close', () => { this.mailbox = null; this.emit('close'); });
    try {
      await this.handshake(conn, await conn.open());
    } catch (e) {
      // conectare esuata la jumatate (STARTTLS, AUTH): nu lasam socketul deschis
      conn.destroy();
      throw e;
    }
    return this;
  }

  async handshake(conn, greet) {
    if (greet.code === 'CAPABILITY') this.setCaps(greet);
    if (!this.caps.size) await this.capability();
    if (!this.opts.secure && this.caps.has('STARTTLS')) {
      await this.run(['STARTTLS']);
      await conn.upgrade();
      this.caps.clear();
      await this.capability();
    } else if (!this.opts.secure && greet.type !== 'PREAUTH' && !this.opts.allowInsecureAuth) {
      throw imapError('CONNECT', 'Serverul nu ofera conexiune criptata (STARTTLS); parola nu se trimite in clar');
    }
    if (greet.type !== 'PREAUTH') {
      const before = this.caps;
      await this.authenticate();
      // capabilitatile se pot schimba dupa autentificare; le cerem daca serverul nu le-a trimis
      if (this.caps === before) await this.capability();
    }
    conn.literalPlus = this.caps.has('LITERAL+');
  }

  setCaps(resp) {
    const list = resp.code === 'CAPABILITY' ? resp.args : (resp.data || []).map((t) => String(str(t)));
    this.caps = new Set(list.map((c) => String(c).toUpperCase()));
  }

  async capability() {
    await this.run(['CAPABILITY']);
    return [...this.caps];
  }

  async logout() {
    if (this.closed) return;
    try {
      await this.run(['LOGOUT'], { timeoutMs: 5000 });
    } catch (e) {
      // la LOGOUT serverul poate inchide inainte de raspunsul etichetat; nu e o eroare reala
      if (e.code !== 'CLOSED' && e.code !== 'TIMEOUT') throw e;
    } finally {
      this.conn.destroy();
    }
  }

  // Ruleaza o comanda; erorile au deja .code din ImapConn.
  run(pieces, opts) {
    if (!this.conn) return Promise.reject(imapError('CLOSED', 'IMAP: connect() nu a fost apelat'));
    return this.conn.exec(pieces, opts);
  }

  // §3 authentication
  async authenticate() {
    const { user, pass } = this.opts;
    const usePlain = this.caps.has('AUTH=PLAIN') || this.caps.has('LOGINDISABLED');
    try {
      if (usePlain) {
        try {
          await this.authPlain(user, pass);
        } catch (e) {
          // BAD = mecanism nesuportat in practica; incercam LOGIN daca e permis
          if (e.code !== 'BAD' || this.caps.has('LOGINDISABLED')) throw e;
          await this.run(['LOGIN ', cmd.astring(user), ' ', cmd.astring(pass)], { label: 'LOGIN' });
        }
      } else {
        await this.run(['LOGIN ', cmd.astring(user), ' ', cmd.astring(pass)], { label: 'LOGIN' });
      }
    } catch (e) {
      if (e.code === 'NO' || e.code === 'BAD') {
        const err = imapError('AUTH', `Autentificare IMAP esuata: ${e.message}`);
        err.responseCode = e.responseCode;
        throw err;
      }
      throw e;
    }
    this.authenticated = true;
  }

  authPlain(user, pass) {
    const token = Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64');
    if (this.caps.has('SASL-IR')) return this.run([`AUTHENTICATE PLAIN ${token}`], { label: 'AUTHENTICATE' });
    return this.run(['AUTHENTICATE PLAIN'], { label: 'AUTHENTICATE', onContinue: () => Buffer.from(token + '\r\n') });
  }

  // §4 folders
  async list() {
    const res = await this.run(['LIST "" "*"']);
    const out = [];
    const flagged = new Set();
    for (const r of res.untagged) {
      if (r.type !== 'LIST' || !r.data) continue;
      const flags = (Array.isArray(r.data[0]) ? r.data[0] : []).map((f) => String(str(f)));
      const delimiter = str(r.data[1]);
      let raw = str(r.data[2]);
      if (raw == null) continue;
      if (/^inbox$/i.test(raw)) raw = 'INBOX';
      const path = utf7.decode(raw);
      const parts = delimiter ? path.split(delimiter) : [path];
      const lower = flags.map((f) => f.toLowerCase());
      const item = {
        path, name: parts[parts.length - 1], delimiter, flags,
        specialUse: path === 'INBOX' ? '\\Inbox' : cmd.specialFromFlags(flags),
        noselect: lower.includes('\\noselect') || lower.includes('\\nonexistent'),
      };
      if (item.specialUse) flagged.add(item.specialUse);
      out.push(item);
    }
    if (out.length && !this.delimiter) this.delimiter = out.find((f) => f.delimiter) ? out.find((f) => f.delimiter).delimiter : null;
    // ghicim dupa nume doar folderele de pe primul nivel (sau sub INBOX) si doar rolurile lipsa
    for (const f of out) {
      if (f.specialUse || f.noselect) continue;
      const depth = f.delimiter ? f.path.split(f.delimiter) : [f.path];
      if (depth.length > 2 || (depth.length === 2 && depth[0] !== 'INBOX')) continue;
      const guess = cmd.guessSpecial(f.name);
      if (guess && !flagged.has(guess)) { f.specialUse = guess; flagged.add(guess); }
    }
    if (!out.some((f) => f.path === 'INBOX')) {
      out.unshift({ path: 'INBOX', name: 'INBOX', delimiter: this.delimiter, flags: [], specialUse: '\\Inbox', noselect: false });
    }
    return out;
  }

  async status(path) {
    const res = await this.run(['STATUS ', cmd.mailbox(path), ' (MESSAGES UNSEEN UIDNEXT UIDVALIDITY)']);
    const out = { messages: 0, unseen: 0, uidnext: null, uidvalidity: null };
    for (const r of res.untagged) {
      if (r.type !== 'STATUS' || !Array.isArray(r.data[1])) continue;
      const l = r.data[1];
      for (let i = 0; i + 1 < l.length; i += 2) {
        const k = String(l[i]).toUpperCase();
        const v = Number(str(l[i + 1]));
        if (k === 'MESSAGES') out.messages = v;
        else if (k === 'UNSEEN') out.unseen = v;
        else if (k === 'UIDNEXT') out.uidnext = v;
        else if (k === 'UIDVALIDITY') out.uidvalidity = v;
      }
    }
    return out;
  }

  create(path) { return this.run(['CREATE ', cmd.mailbox(path)]).then(() => true); }
  rename(oldPath, newPath) { return this.run(['RENAME ', cmd.mailbox(oldPath), ' ', cmd.mailbox(newPath)]).then(() => true); }
  subscribe(path) { return this.run(['SUBSCRIBE ', cmd.mailbox(path)]).then(() => true); }
  async delete(path) {
    // folderul selectat nu poate fi sters pe unele servere
    if (this.mailbox && this.mailbox.path === path) await this.unselect();
    await this.run(['DELETE ', cmd.mailbox(path)]);
    return true;
  }

  // §5 mailbox state
  select(path) { return this.open(path, false); }
  examine(path) { return this.open(path, true); }

  async open(path, readOnly) {
    this.mailbox = null;
    const res = await this.run([readOnly ? 'EXAMINE ' : 'SELECT ', cmd.mailbox(path)]);
    const out = { exists: 0, uidvalidity: null, uidnext: null, readOnly: !!readOnly || res.code === 'READ-ONLY' };
    for (const r of res.untagged) {
      if (r.type === 'EXISTS') out.exists = r.num;
      else if (r.code === 'UIDVALIDITY') out.uidvalidity = Number(r.args[0]);
      else if (r.code === 'UIDNEXT') out.uidnext = Number(r.args[0]);
    }
    this.mailbox = Object.assign({ path }, out);
    return out;
  }

  async unselect() {
    if (!this.mailbox) return;
    if (this.caps.has('UNSELECT')) await this.run(['UNSELECT']);
    else await this.examine('INBOX'); // fara UNSELECT: EXAMINE nu face expunge implicit
    this.mailbox = null;
  }

  requireMailbox(write) {
    if (!this.mailbox) throw imapError('BAD', 'Niciun folder selectat (apeleaza select/examine)');
    if (write && this.mailbox.readOnly) throw imapError('NO', `Folderul ${this.mailbox.path} e deschis read-only (EXAMINE)`);
  }

  // §6 search
  async search(query) {
    this.requireMailbox(false);
    const { pieces, utf8 } = cmd.buildSearch(query);
    const head = utf8 ? 'UID SEARCH CHARSET UTF-8 ' : 'UID SEARCH ';
    const res = await this.run([head, ...pieces], { label: 'SEARCH' });
    const set = new Set();
    for (const r of res.untagged) {
      if (r.type !== 'SEARCH' || !r.data) continue;
      for (const t of r.data) { const n = Number(str(t)); if (Number.isInteger(n) && n > 0) set.add(n); }
    }
    return [...set].sort((a, b) => a - b);
  }
}

Object.assign(Imap.prototype, ops);

// §7 exports
module.exports = { Imap };
