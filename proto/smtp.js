/* MAP
 * §1 imports & errors  L11-L21
 * §2 session           L23-L118
 * §3 handshake & auth  L120-L188
 * §4 dot-stuffing      L190-L208
 * §5 public API        L210-L264
 * §6 exports           L266-L267
 */
'use strict';

// §1 imports & errors
const net = require('net');
const tls = require('tls');
const os = require('os');

function smtpError(code, message, reply) {
  const err = new Error(message);
  err.code = code;
  if (reply) { err.status = reply.status; err.response = reply.text; }
  return err;
}

// §2 session
// Raspunsuri multi-linie: "250-..." continua, "250 ..." incheie.
class Session {
  constructor(cfg) {
    this.cfg = cfg;
    this.timeoutMs = Number(cfg.timeoutMs) || 30000;
    this.buf = '';
    this.lines = [];
    this.waiter = null;
    this.replies = [];
    this.socket = null;
    this.closedErr = null;
  }

  connect() {
    const c = this.cfg;
    return new Promise((resolve, reject) => {
      const opts = { host: c.host, port: c.port, servername: c.host, rejectUnauthorized: c.rejectUnauthorized !== false };
      const sock = c.secure ? tls.connect(opts) : net.connect({ host: c.host, port: c.port });
      const fail = (e) => { cleanup(); sock.destroy(); reject(smtpError(e.code === 'TIMEOUT' ? 'TIMEOUT' : 'CONNECT', e.message)); };
      const timer = setTimeout(() => fail({ code: 'TIMEOUT', message: `Timeout la conectarea SMTP ${c.host}:${c.port}` }), this.timeoutMs);
      const onErr = (e) => fail({ message: `Conectare SMTP esuata (${c.host}:${c.port}): ${e.message}` });
      const cleanup = () => { clearTimeout(timer); sock.removeListener('error', onErr); };
      sock.once('error', onErr);
      sock.once(c.secure ? 'secureConnect' : 'connect', () => { cleanup(); this.attach(sock); resolve(); });
    });
  }

  attach(sock) {
    this.socket = sock;
    sock.on('data', (d) => this.onData(d.toString('utf8')));
    sock.on('error', (e) => { this.closedErr = e; });
    sock.on('close', () => {
      this.closedErr = this.closedErr || new Error('conexiunea s-a inchis');
      if (this.waiter) this.waiter.reject(smtpError('CONNECT', `Conexiunea SMTP s-a inchis: ${this.closedErr.message}`));
      this.waiter = null;
    });
  }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = { status: Number(line.slice(0, 3)), lines: this.lines.map((l) => l.slice(4)), text: this.lines.join('\n') };
        this.lines = [];
        if (this.waiter) { const w = this.waiter; this.waiter = null; w.resolve(reply); } else this.replies.push(reply);
      }
    }
  }

  read() {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    return new Promise((resolve, reject) => {
      if (this.closedErr) return reject(smtpError('CONNECT', `Conexiunea SMTP s-a inchis: ${this.closedErr.message}`));
      const timer = setTimeout(() => {
        this.waiter = null;
        this.socket.destroy();
        reject(smtpError('TIMEOUT', 'Timeout SMTP: serverul nu a raspuns'));
      }, this.timeoutMs);
      this.waiter = {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
  }

  // Asteptam scrierea completa (callback) inainte de cronometrarea raspunsului: DATA mare dureaza.
  async cmd(data) {
    await new Promise((resolve, reject) => {
      this.socket.write(data, (err) => (err ? reject(smtpError('CONNECT', err.message)) : resolve()));
    });
    return this.read();
  }

  upgrade() {
    const c = this.cfg;
    const raw = this.socket;
    raw.removeAllListeners('data');
    raw.removeAllListeners('close');
    raw.removeAllListeners('error');
    return new Promise((resolve, reject) => {
      const sock = tls.connect({ socket: raw, servername: c.host, rejectUnauthorized: c.rejectUnauthorized !== false });
      const onErr = (e) => { raw.destroy(); reject(smtpError('CONNECT', `STARTTLS esuat: ${e.message}`)); };
      sock.once('error', onErr);
      sock.once('secureConnect', () => { sock.removeListener('error', onErr); this.attach(sock); resolve(); });
    });
  }

  close() {
    if (this.socket) this.socket.destroy();
  }
}

// §3 handshake & auth
function heloName() {
  const h = String(os.hostname() || '').toLowerCase().replace(/[^a-z0-9.-]/g, '');
  return h || 'localhost';
}

async function ehlo(s) {
  let r = await s.cmd(`EHLO ${heloName()}\r\n`);
  if (r.status !== 250) {
    r = await s.cmd(`HELO ${heloName()}\r\n`);
    if (r.status !== 250) throw smtpError('CONNECT', `Serverul SMTP a refuzat HELO: ${r.text}`, r);
    return new Map();
  }
  const ext = new Map();
  for (const l of r.lines.slice(1)) {
    const [k, ...rest] = l.trim().split(/\s+/);
    if (k) ext.set(k.toUpperCase(), rest.join(' ').toUpperCase());
  }
  return ext;
}

async function open(cfg) {
  const s = new Session(cfg);
  await s.connect();
  try {
    const greet = await s.read();
    if (greet.status !== 220) throw smtpError('CONNECT', `Salut SMTP neasteptat: ${greet.text}`, greet);
    let ext = await ehlo(s);
    if (!cfg.secure && ext.has('STARTTLS')) {
      const r = await s.cmd('STARTTLS\r\n');
      if (r.status !== 220) throw smtpError('CONNECT', `STARTTLS refuzat: ${r.text}`, r);
      await s.upgrade();
      ext = await ehlo(s);
    } else if (!cfg.secure && cfg.user && cfg.allowInsecureAuth !== true) {
      // allowInsecureAuth exista doar pentru testele pe loopback
      throw smtpError('CONNECT', 'Serverul nu ofera conexiune criptata (STARTTLS); parola nu se trimite in clar');
    }
    s.ext = ext;
    if (cfg.user) await auth(s, cfg);
    return s;
  } catch (e) {
    s.close();
    throw e;
  }
}

async function authPlain(s, cfg) {
  const token = Buffer.from(`\u0000${cfg.user}\u0000${cfg.pass || ''}`, 'utf8').toString('base64');
  return s.cmd(`AUTH PLAIN ${token}\r\n`);
}

async function authLogin(s, cfg) {
  let r = await s.cmd('AUTH LOGIN\r\n');
  if (r.status !== 334) return r;
  r = await s.cmd(Buffer.from(String(cfg.user), 'utf8').toString('base64') + '\r\n');
  if (r.status !== 334) return r;
  return s.cmd(Buffer.from(String(cfg.pass || ''), 'utf8').toString('base64') + '\r\n');
}

// PLAIN intai; LOGIN daca PLAIN lipseste sau e refuzat si serverul ofera LOGIN.
async function auth(s, cfg) {
  const mechs = (s.ext.get('AUTH') || '').split(/\s+/);
  const hasPlain = mechs.includes('PLAIN') || !s.ext.has('AUTH');
  const hasLogin = mechs.includes('LOGIN') || !s.ext.has('AUTH');
  let r = null;
  if (hasPlain) r = await authPlain(s, cfg);
  if ((!r || r.status !== 235) && hasLogin) r = await authLogin(s, cfg);
  if (!r || r.status !== 235) throw smtpError('AUTH', `Autentificare SMTP esuata: ${r ? r.text : 'niciun mecanism PLAIN/LOGIN oferit'}`, r);
}

// §4 dot-stuffing
// Normalizeaza la CRLF, dubleaza "." de la inceput de rand si incheie cu CRLF.CRLF.
function dotStuff(raw) {
  const src = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  const out = Buffer.alloc(src.length * 2 + 5);
  let o = 0;
  let bol = true;
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    if (b === 0x0d && src[i + 1] === 0x0a) { out[o++] = 0x0d; out[o++] = 0x0a; i++; bol = true; continue; }
    if (b === 0x0a || b === 0x0d) { out[o++] = 0x0d; out[o++] = 0x0a; bol = true; continue; }
    if (bol && b === 0x2e) out[o++] = 0x2e;
    out[o++] = b;
    bol = false;
  }
  if (!bol) { out[o++] = 0x0d; out[o++] = 0x0a; }
  out[o++] = 0x2e; out[o++] = 0x0d; out[o++] = 0x0a;
  return out.subarray(0, o);
}

// §5 public API
function normCfg(cfg) {
  const c = Object.assign({}, cfg);
  c.port = Number(c.port) || (c.secure === false ? 587 : 465);
  c.secure = c.secure !== undefined ? !!c.secure : c.port === 465;
  return c;
}

async function quit(s) {
  try {
    await s.cmd('QUIT\r\n');
  } catch (e) {
    // unele servere inchid fara 221; mesajul a fost deja acceptat, deci nu e o eroare
  } finally {
    s.close();
  }
}

async function send(cfg, envelope) {
  const env = envelope || {};
  const recipients = [...new Set((env.recipients || []).map((a) => String(a).trim()).filter(Boolean))];
  if (!recipients.length) throw smtpError('REJECTED', 'Niciun destinatar');
  const from = String(env.from || '').replace(/[<>\r\n\s]/g, '');
  const s = await open(normCfg(cfg));
  try {
    let r = await s.cmd(`MAIL FROM:<${from}>\r\n`);
    if (r.status !== 250) throw smtpError('REJECTED', `Expeditor refuzat: ${r.text}`, r);
    const accepted = [], rejected = [], rejectedDetails = [];
    for (const rcpt of recipients) {
      r = await s.cmd(`RCPT TO:<${rcpt.replace(/[<>\r\n\s]/g, '')}>\r\n`);
      if (r.status === 250 || r.status === 251) accepted.push(rcpt);
      else { rejected.push(rcpt); rejectedDetails.push({ address: rcpt, status: r.status, response: r.text }); }
    }
    if (!accepted.length) {
      const err = smtpError('REJECTED', `Toti destinatarii au fost refuzati: ${rejectedDetails.map((d) => d.response).join('; ')}`);
      err.rejected = rejected;
      throw err;
    }
    r = await s.cmd('DATA\r\n');
    if (r.status !== 354) throw smtpError('REJECTED', `DATA refuzat: ${r.text}`, r);
    r = await s.cmd(dotStuff(env.raw || ''));
    if (r.status !== 250) throw smtpError('REJECTED', `Mesaj refuzat de server: ${r.text}`, r);
    await quit(s);
    return { accepted, rejected, response: r.text, rejectedDetails };
  } catch (e) {
    s.close();
    throw e;
  }
}

async function verify(cfg) {
  const s = await open(normCfg(cfg));
  await quit(s);
  return true;
}

// §6 exports
module.exports = { send, verify, dotStuff };
