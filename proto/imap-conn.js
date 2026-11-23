/* MAP
 * §1 imports & errors  L11-L23
 * §2 socket lifecycle  L25-L104
 * §3 reader (framing)  L106-L130
 * §4 dispatch          L132-L161
 * §5 command queue     L163-L234
 * §6 exports           L236-L237
 */
'use strict';

// §1 imports & errors
const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');
const { parseResponse } = require('./imap-parse');

function imapError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const LITERAL_RE = /\{(\d+)\+?\}\r?\n$/;

// §2 socket lifecycle
// Conexiunea bruta: incadrare raspunsuri, taguri, o singura comanda in zbor.
class ImapConn extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.timeoutMs = opts.timeoutMs || 30000;
    this.socket = null;
    this.closed = true;
    this.tagSeq = 0;
    this.queue = [];
    this.current = null;
    this.parts = [];
    this.lineBuf = null;
    this.litLeft = 0;
    this.greeting = null;
    this.literalPlus = false;
  }

  open() {
    const o = this.opts;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err, val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) { this.destroy(); reject(err); } else resolve(val);
      };
      const timer = setTimeout(() => finish(imapError('TIMEOUT', `Timeout la conectarea IMAP ${o.host}:${o.port}`)), this.timeoutMs);
      const tlsOpts = { host: o.host, port: o.port, servername: o.host, rejectUnauthorized: o.rejectUnauthorized !== false };
      const sock = o.secure ? tls.connect(tlsOpts) : net.connect({ host: o.host, port: o.port });
      this.closed = false;
      this.attach(sock);
      this.greetWaiter = (resp) => {
        if (resp.type === 'BYE') return finish(imapError('CONNECT', `Serverul IMAP a refuzat conexiunea: ${resp.text}`));
        finish(null, resp);
      };
      sock.once('error', (e) => finish(imapError('CONNECT', `Conectare IMAP esuata (${o.host}:${o.port}): ${e.message}`)));
      sock.once('close', () => finish(imapError('CONNECT', 'Conexiunea IMAP s-a inchis inainte de salut')));
    });
  }

  attach(sock) {
    this.socket = sock;
    sock.on('data', (chunk) => this.onData(chunk));
    sock.on('error', (e) => { this.lastError = e; });
    sock.on('close', () => this.onClose());
  }

  // STARTTLS: inlocuim socketul TCP cu unul TLS peste el, fara sa declansam 'close'.
  upgrade() {
    const o = this.opts;
    const raw = this.socket;
    raw.removeAllListeners('data');
    raw.removeAllListeners('close');
    raw.removeAllListeners('error');
    return new Promise((resolve, reject) => {
      const sock = tls.connect({ socket: raw, servername: o.host, rejectUnauthorized: o.rejectUnauthorized !== false });
      const onErr = (e) => { this.destroy(); reject(imapError('CONNECT', `STARTTLS esuat: ${e.message}`)); };
      sock.once('error', onErr);
      sock.once('secureConnect', () => { sock.removeListener('error', onErr); this.attach(sock); resolve(); });
    });
  }

  // Inchidere sincrona: starea 'closed' si coada respinsa imediat, nu la evenimentul socketului.
  destroy() {
    if (this.socket) this.socket.destroy();
    this.onClose();
  }

  onClose() {
    if (this.closed) return;
    this.closed = true;
    const why = this.lastError ? `: ${this.lastError.message}` : '';
    const err = imapError('CLOSED', `Conexiunea IMAP s-a inchis${why}`);
    if (this.current) { this.current.fail(err); this.current = null; }
    for (const job of this.queue.splice(0)) job.fail(err);
    this.emit('close');
  }

  // §3 reader (framing)
  // Incadrare pe Buffer: rand cu {n} la final → urmeaza n octeti de literal, apoi restul randului.
  onData(chunk) {
    if (this.current) this.current.touch();
    while (chunk.length) {
      if (this.litLeft > 0) {
        const take = Math.min(this.litLeft, chunk.length);
        this.parts.push(chunk.subarray(0, take));
        this.litLeft -= take;
        chunk = chunk.subarray(take);
        continue;
      }
      const lf = chunk.indexOf(0x0a);
      if (lf < 0) { this.lineBuf = this.lineBuf ? Buffer.concat([this.lineBuf, chunk]) : chunk; return; }
      let line = chunk.subarray(0, lf + 1);
      if (this.lineBuf) { line = Buffer.concat([this.lineBuf, line]); this.lineBuf = null; }
      chunk = chunk.subarray(lf + 1);
      this.parts.push(line);
      const m = LITERAL_RE.exec(line.toString('latin1', Math.max(0, line.length - 24)));
      if (m) { this.litLeft = Number(m[1]); continue; }
      const full = this.parts.length === 1 ? Buffer.from(this.parts[0]) : Buffer.concat(this.parts);
      this.parts = [];
      this.dispatch(full);
    }
  }

  // §4 dispatch
  dispatch(buf) {
    let resp;
    try {
      resp = parseResponse(buf);
    } catch (e) {
      // raspuns imposibil de parsat: il raportam comenzii curente, nu oprim conexiunea
      resp = { kind: 'untagged', type: 'UNPARSED', error: e.message };
    }
    if (this.greetWaiter) { const w = this.greetWaiter; this.greetWaiter = null; this.greeting = resp; return w(resp); }
    if (resp.kind === 'continue') {
      if (this.current) this.current.onContinue(resp);
      return;
    }
    if (resp.kind === 'untagged') {
      if (resp.type === 'EXISTS') this.emit('exists', resp.num);
      else if (resp.type === 'EXPUNGE') this.emit('expunge', resp.num);
      else if (resp.type === 'BYE') this.byeText = resp.text;
      if (resp.code === 'CAPABILITY' || resp.type === 'CAPABILITY') this.emit('capability', resp);
      if (this.current) this.current.untagged.push(resp);
      return;
    }
    if (this.current && resp.tag === this.current.tag) {
      const job = this.current;
      this.current = null;
      if (resp.code === 'CAPABILITY') this.emit('capability', resp);
      job.complete(resp);
      this.pump();
    }
  }

  // §5 command queue
  // pieces: string-uri si { literal: Buffer }. onContinue(resp) → Buffer de trimis (AUTHENTICATE).
  exec(pieces, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(imapError('CLOSED', 'Conexiunea IMAP este inchisa'));
      this.queue.push({ pieces: Array.isArray(pieces) ? pieces : [pieces], opts, resolve, reject });
      this.pump();
    });
  }

  pump() {
    if (this.current || !this.queue.length || this.closed) return;
    const req = this.queue.shift();
    const tag = 'A' + (++this.tagSeq);
    const chunks = this.serialize(tag, req.pieces);
    let timer = null;
    const job = {
      tag, untagged: [],
      touch: () => { clearTimeout(timer); timer = setTimeout(onTimeout, req.opts.timeoutMs || this.timeoutMs); },
      fail: (err) => { clearTimeout(timer); req.reject(err); },
      complete: (resp) => {
        clearTimeout(timer);
        const result = { untagged: job.untagged, status: resp.status, code: resp.code, args: resp.args, text: resp.text };
        if (resp.status === 'OK') return req.resolve(result);
        const code = resp.status === 'BAD' ? 'BAD' : 'NO';
        const err = imapError(code, resp.text || resp.status);
        err.responseCode = resp.code;
        err.response = result;
        req.reject(err);
      },
      onContinue: (resp) => {
        if (chunks.length) return this.write(chunks.shift());
        if (req.opts.onContinue) return this.write(req.opts.onContinue(resp));
        this.write(Buffer.from('*\r\n')); // continuare neasteptata: anulam (SASL)
      },
    };
    const onTimeout = () => {
      this.current = null;
      job.fail(imapError('TIMEOUT', `Timeout IMAP la comanda ${req.opts.label || String(req.pieces[0]).split(' ')[0]}`));
      // starea protocolului e necunoscuta dupa timeout: inchidem conexiunea
      this.destroy();
    };
    this.current = job;
    job.touch();
    this.write(chunks.shift());
  }

  // Imparte comanda in bucati de trimis: dupa fiecare {n} asteptam '+' (fara LITERAL+).
  serialize(tag, pieces) {
    const out = [];
    let cur = [Buffer.from(tag + ' ')];
    for (const p of pieces) {
      if (p && p.literal) {
        const lit = Buffer.isBuffer(p.literal) ? p.literal : Buffer.from(String(p.literal), 'utf8');
        if (this.literalPlus) { cur.push(Buffer.from(`{${lit.length}+}\r\n`), lit); continue; }
        cur.push(Buffer.from(`{${lit.length}}\r\n`));
        out.push(Buffer.concat(cur));
        cur = [lit];
      } else {
        cur.push(Buffer.from(String(p), 'utf8'));
      }
    }
    cur.push(Buffer.from('\r\n'));
    out.push(Buffer.concat(cur));
    return out;
  }

  write(buf) {
    if (this.socket && !this.socket.destroyed) this.socket.write(buf);
  }
}

// §6 exports
module.exports = { ImapConn, imapError };
