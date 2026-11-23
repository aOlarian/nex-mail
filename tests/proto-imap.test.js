/* MAP
 * §1 setup        L9-L19
 * §2 fake server  L20-L75
 * §3 handlers     L76-L139
 * §4 tests        L140-L244
 */
'use strict';

// §1 setup
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { Imap } = require('../proto/imap');
const { tokenize } = require('../proto/imap-parse');

const USER = 'office@exemplu.ro';
const PASS = 'parolă "x"';
const BINARY = Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 37) % 256));

// §2 fake server
// Server IMAP minimal pe 127.0.0.1:0; citeste comenzi cu literali {n} si raspunde scriptat.
function fakeImap(opts) {
  const o = Object.assign({ caps: 'UIDPLUS', hang: false }, opts);
  const state = { cmds: [], literals: [] };
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    let buf = Buffer.alloc(0);
    let pending = null; // comanda partiala cu literal in asteptare
    let saslTag = null;
    const w = (s) => sock.write(typeof s === 'string' ? Buffer.from(s + '\r\n', 'utf8') : s);
    w(`* OK [CAPABILITY IMAP4rev1 ${o.caps}] fake ready`);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (pending && pending.need) {
          if (buf.length < pending.need) return;
          const lit = buf.subarray(0, pending.need);
          state.literals.push(Buffer.from(lit));
          pending.parts.push(lit);
          buf = buf.subarray(pending.need);
          pending.need = 0;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.subarray(0, i);
        buf = buf.subarray(i + 2);
        if (saslTag) { const t = saslTag; saslTag = null; handleSasl(t, line.toString(), w, o); continue; }
        pending = pending || { parts: [] };
        pending.parts.push(line);
        const m = /\{(\d+)(\+?)\}$/.exec(line.toString('latin1'));
        if (m) {
          pending.parts.push(Buffer.from('\r\n'));
          pending.need = Number(m[1]);
          if (!m[2]) w('+ Ready for literal');
          continue;
        }
        const full = Buffer.concat(pending.parts);
        pending = null;
        const toks = tokenize(full, 0);
        const tag = toks[0];
        const name = String(toks[1]).toUpperCase() + (String(toks[1]).toUpperCase() === 'UID' ? ' ' + String(toks[2]).toUpperCase() : '');
        state.cmds.push({ name, text: full.toString('utf8'), toks });
        if (name === 'AUTHENTICATE') { saslTag = tag; w('+ '); continue; }
        handle(tag, name, toks, full.toString('utf8'), w, sock, o, state);
      }
    });
    sock.on('error', () => { /* clientul poate inchide brusc in testele de timeout */ });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const cfg = { host: '127.0.0.1', port: server.address().port, secure: false, allowInsecureAuth: true, user: USER, pass: PASS, timeoutMs: 3000 };
    resolve({ state, cfg, close: () => new Promise((r) => { server.close(r); for (const s of sockets) s.destroy(); }) });
  }));
}

// §3 handlers
function handleSasl(tag, line, w) {
  const [, u, p] = Buffer.from(line, 'base64').toString('utf8').split('\u0000');
  if (u === USER && p === PASS) w(`${tag} OK [CAPABILITY IMAP4rev1 AUTH=PLAIN MOVE] Logged in`);
  else w(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed.`);
}

const RAW_MSG = Buffer.concat([Buffer.from('Subject: bin\r\nContent-Type: application/octet-stream\r\n\r\n'), BINARY]);
const ENVELOPE = '("Thu, 12 Nov 2026 10:30:00 +0200" "=?UTF-8?Q?Ofert=C4=83?=" (("=?UTF-8?B?yJh0ZWZhbg==?=" NIL "s" "x.ro")) NIL NIL '
  + '((NIL NIL "office" "exemplu.ro")) NIL NIL NIL "<id1@x.ro>")';
const BODYSTRUCTURE = '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 40 2 NIL NIL NIL NIL)'
  + '("APPLICATION" "PDF" ("NAME" "a.pdf") NIL NIL "BASE64" 100 NIL ("ATTACHMENT" ("FILENAME" "a.pdf")) NIL NIL) "MIXED" ("BOUNDARY" "b") NIL NIL NIL)';

function handle(tag, name, toks, text, w, sock, o) {
  const ok = (t) => w(`${tag} OK ${t || 'done'}`);
  switch (name) {
    case 'CAPABILITY': w(`* CAPABILITY IMAP4rev1 ${o.caps}`); return ok();
    case 'LOGIN': {
      const u = Buffer.isBuffer(toks[2]) ? toks[2].toString() : toks[2];
      const p = Buffer.isBuffer(toks[3]) ? toks[3].toString() : toks[3];
      if (u === USER && p === PASS) return w(`${tag} OK [CAPABILITY IMAP4rev1 ${o.caps}] Logged in`);
      return w(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed.`);
    }
    case 'LIST':
      w('* LIST (\\HasChildren) "/" INBOX');
      w('* LIST (\\HasNoChildren \\Sent) "/" "Trimise"');
      w('* LIST (\\HasNoChildren) "/" "Ciorne &AQM-"');
      w('* LIST (\\HasNoChildren) "/" "Drafts"');
      w('* LIST (\\HasNoChildren) "/" "Co&Ahk- de gunoi"');
      w('* LIST (\\Noselect \\HasChildren) "/" "Arhiv&AQM-"');
      w('* LIST (\\HasNoChildren) "/" {11}\r\nINBOX/Sp&-m');
      return ok();
    case 'STATUS': w('* STATUS "INBOX" (MESSAGES 3 UNSEEN 1 UIDNEXT 10 UIDVALIDITY 42)'); return ok();
    case 'SELECT': case 'EXAMINE':
      w('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)');
      w('* 3 EXISTS'); w('* 0 RECENT'); w('* OK [UIDVALIDITY 42] UIDs valid'); w('* OK [UIDNEXT 10] Predicted next UID');
      return ok(name === 'SELECT' ? '[READ-WRITE] Select completed' : '[READ-ONLY] Examine completed');
    case 'UID SEARCH': w('* SEARCH 9 3 5'); return ok();
    case 'UID FETCH': {
      if (/BODY\.PEEK\[\]/.test(text)) {
        // raspuns fragmentat in 3 bucati ca sa testam incadrarea literalului
        const all = Buffer.concat([Buffer.from(`* 1 FETCH (UID 7 BODY[] {${RAW_MSG.length}}\r\n`), RAW_MSG, Buffer.from(` FLAGS (\\Seen))\r\n${tag} OK Fetch completed\r\n`)]);
        sock.write(all.subarray(0, 30));
        setTimeout(() => sock.write(all.subarray(30, 200)), 10);
        setTimeout(() => sock.write(all.subarray(200)), 20);
        return;
      }
      if (/BODY\.PEEK\[1\]<0\.1500>/.test(text)) {
        const qp = 'Bun=C4=83 ziua, v=C4=83 trimit oferta.=\r\nRestul';
        w(`* 1 FETCH (UID 3 BODY[1]<0> {${qp.length}}\r\n${qp})`);
        return ok();
      }
      w('* 2 FETCH (FLAGS (\\Seen))');
      w(`* 1 FETCH (UID 3 FLAGS (\\Seen \\Flagged) INTERNALDATE "12-Nov-2026 08:30:05 +0000" RFC822.SIZE 4321 ENVELOPE ${ENVELOPE} BODYSTRUCTURE ${BODYSTRUCTURE})`);
      w('* 4 EXISTS');
      return ok();
    }
    case 'APPEND': return ok('[APPENDUID 42 11] Append completed');
    case 'NOOP': if (o.hang) return; return ok();
    case 'LOGOUT': w('* BYE Logging out'); ok(); sock.end(); return;
    default: return ok();
  }
}

// §4 tests
test('IMAP: LOGIN literal, LIST utf7 + special-use, STATUS, SELECT, FETCH, SEARCH, APPEND, MOVE fallback', async () => {
  const f = await fakeImap();
  const c = new Imap(f.cfg);
  const events = [];
  c.on('exists', (n) => events.push(n));
  try {
    await c.connect();
    assert.equal(c.closed, false);
    const login = f.state.cmds.find((x) => x.name === 'LOGIN');
    assert.ok(login && f.state.literals.some((l) => l.toString() === PASS), 'parola non-ASCII trimisa ca literal');
    const list = await c.list();
    const by = Object.fromEntries(list.map((x) => [x.path, x]));
    assert.equal(by.INBOX.specialUse, '\\Inbox');
    assert.equal(by.Trimise.specialUse, '\\Sent');
    assert.equal(by['Ciorne ă'].specialUse, null);
    assert.equal(by.Drafts.specialUse, '\\Drafts');
    assert.equal(by['Coș de gunoi'].specialUse, '\\Trash');
    assert.equal(by['Arhivă'].noselect, true);
    assert.equal(by['INBOX/Sp&m'].name, 'Sp&m');
    assert.deepEqual(await c.status('INBOX'), { messages: 3, unseen: 1, uidnext: 10, uidvalidity: 42 });
    const sel = await c.select('Ciorne ă');
    assert.equal(sel.exists, 3);
    assert.equal(sel.uidvalidity, 42);
    assert.equal(sel.uidnext, 10);
    assert.ok(f.state.cmds.find((x) => x.name === 'SELECT').text.includes('"Ciorne &AQM-"'));

    // apeluri paralele: se serializeaza intern, tagurile raman secventiale
    const [uids, headers, raw] = await Promise.all([c.search({ text: 'ofertă', unseen: true }), c.fetchHeaders([3]), c.fetchRaw(7)]);
    assert.deepEqual(uids, [3, 5, 9]);
    const search = f.state.cmds.find((x) => x.name === 'UID SEARCH');
    assert.match(search.text, /UID SEARCH CHARSET UTF-8 OR OR SUBJECT \{7\}\r\nofertă FROM \{7\}\r\nofertă TO \{7\}\r\nofertă UNSEEN$/);
    assert.equal(headers.length, 1);
    const h = headers[0];
    assert.equal(h.uid, 3);
    assert.deepEqual(h.flags, ['\\Seen', '\\Flagged']);
    assert.equal(h.internalDate, '2026-11-12T08:30:05.000Z');
    assert.equal(h.size, 4321);
    assert.equal(h.envelope.subject, 'Ofertă');
    assert.deepEqual(h.envelope.from, [{ name: 'Ștefan', address: 's@x.ro' }]);
    assert.equal(h.envelope.messageId, '<id1@x.ro>');
    assert.equal(h.envelope.date, '2026-11-12T08:30:00.000Z');
    assert.equal(h.hasAttachments, true);
    assert.equal(h.preview, 'Bună ziua, vă trimit oferta.Restul');
    assert.ok(raw.equals(RAW_MSG), 'literal binar intact');
    assert.ok(events.includes(4));
    assert.deepEqual(await c.fetchHeaders([]), []);

    assert.equal(await c.append('Ciorne ă', Buffer.from('Subject: a\r\n\r\nb\r\n'), ['\\Seen']), 11);
    assert.equal(f.state.literals[f.state.literals.length - 1].toString(), 'Subject: a\r\n\r\nb\r\n');
    await c.addFlags([3, 4, 5], ['\\Flagged']);
    await c.move([3], 'Trimise');
    const names = f.state.cmds.map((x) => x.name);
    assert.ok(names.includes('UID COPY') && names.includes('UID EXPUNGE'), 'fara MOVE: COPY + \\Deleted + UID EXPUNGE');
    assert.ok(f.state.cmds.some((x) => /UID STORE 3:5 \+FLAGS\.SILENT \(\\Flagged\)/.test(x.text)));
    const tags = f.state.cmds.map((x) => Number(String(x.toks[0]).slice(1)));
    assert.deepEqual(tags, tags.slice().sort((a, b) => a - b));
    await c.examine('INBOX');
    await assert.rejects(c.addFlags([1], ['\\Seen']), (e) => e.code === 'NO');
    const closed = new Promise((r) => c.once('close', r));
    await c.logout();
    await closed;
    assert.equal(c.closed, true);
    await assert.rejects(c.noop(), (e) => e.code === 'CLOSED');
  } finally { await f.close(); }
});

test('IMAP: AUTHENTICATE PLAIN si parola gresita → code AUTH', async () => {
  const f = await fakeImap({ caps: 'AUTH=PLAIN LOGINDISABLED' });
  try {
    const c = new Imap(f.cfg);
    await c.connect();
    assert.ok(f.state.cmds.some((x) => x.name === 'AUTHENTICATE'));
    assert.ok(c.caps.has('MOVE'), 'capabilitatile de dupa login vin din codul OK');
    await c.logout();
    const bad = new Imap(Object.assign({}, f.cfg, { pass: 'gresit' }));
    await assert.rejects(bad.connect(), (e) => e.code === 'AUTH' && /Authentication failed/.test(e.message));
    assert.equal(bad.closed, true, "socketul se inchide la autentificare esuata");
  } finally { await f.close(); }
});

test('IMAP: secure:false fara STARTTLS → CONNECT, parola nu pleaca', async () => {
  const f = await fakeImap();
  try {
    const cfg = Object.assign({}, f.cfg);
    delete cfg.allowInsecureAuth;
    const c = new Imap(cfg);
    await assert.rejects(c.connect(), (e) => e.code === 'CONNECT' && /nu ofera conexiune criptata \(STARTTLS\); parola nu se trimite in clar/.test(e.message));
    assert.equal(c.closed, true);
    assert.ok(!f.state.cmds.some((x) => x.name === 'LOGIN' || x.name === 'AUTHENTICATE'), 'nicio comanda de autentificare trimisa');
    assert.equal(f.state.literals.length, 0);
  } finally { await f.close(); }
});

test('IMAP: timeout per comanda inchide conexiunea; conectare refuzata', async () => {
  const f = await fakeImap({ hang: true });
  try {
    const c = new Imap(Object.assign({}, f.cfg, { timeoutMs: 300 }));
    await c.connect();
    await assert.rejects(c.noop(), (e) => e.code === 'TIMEOUT');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(c.closed, true);
  } finally { await f.close(); }
  await assert.rejects(new Imap(f.cfg).connect(), (e) => e.code === 'CONNECT');
});
