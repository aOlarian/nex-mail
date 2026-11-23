/* MAP
 * §1 setup        L8-L16
 * §2 fake server  L17-L74
 * §3 tests        L75-L136
 */
'use strict';

// §1 setup
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { send, verify, dotStuff } = require('../proto/smtp');

const USER = 'office@exemplu.ro';
const PASS = 'parolă "grea"';

// §2 fake server
// Server SMTP minimal pe 127.0.0.1:0 (port efemer); jurnalizeaza comenzile primite.
function fakeSmtp(opts) {
  const o = Object.assign({ plainFails: false, mechs: 'PLAIN LOGIN', greet: true }, opts);
  const state = { log: [], data: null, auth: null };
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    let buf = '';
    let mode = 'cmd';
    let loginStep = 0, loginUser = '';
    const w = (s) => sock.write(s + '\r\n');
    if (o.greet) w('220 fake.local ESMTP');
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      for (;;) {
        if (mode === 'data') {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          state.data = Buffer.from(buf.slice(0, end + 2), 'latin1');
          buf = buf.slice(end + 5);
          mode = 'cmd';
          w('250 2.0.0 Ok: queued as ABC123');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        state.log.push(line);
        const up = line.toUpperCase();
        if (loginStep === 1) { loginUser = Buffer.from(line, 'base64').toString('utf8'); loginStep = 2; w('334 UGFzc3dvcmQ6'); continue; }
        if (loginStep === 2) {
          loginStep = 0;
          const pass = Buffer.from(line, 'base64').toString('utf8');
          if (loginUser === USER && pass === PASS) { state.auth = 'LOGIN'; w('235 2.7.0 Authentication successful'); } else w('535 5.7.8 Bad credentials');
          continue;
        }
        if (up.startsWith('EHLO')) { w('250-fake.local'); w('250-SIZE 10240000'); w(`250-AUTH ${o.mechs}`); w('250 8BITMIME'); }
        else if (up.startsWith('AUTH PLAIN ')) {
          const [, u, p] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\u0000');
          if (!o.plainFails && u === USER && p === PASS) { state.auth = 'PLAIN'; w('235 2.7.0 Authentication successful'); } else w('535 5.7.8 Bad credentials');
        } else if (up === 'AUTH LOGIN') { loginStep = 1; w('334 VXNlcm5hbWU6'); }
        else if (up.startsWith('MAIL FROM:')) w(state.auth ? '250 2.1.0 Ok' : '530 5.7.0 Authentication required');
        else if (up.startsWith('RCPT TO:')) w(/BAD@/.test(up) ? '550 5.1.1 User unknown' : '250 2.1.5 Ok');
        else if (up === 'DATA') { mode = 'data'; w('354 End data with <CR><LF>.<CR><LF>'); }
        else if (up === 'QUIT') { w('221 2.0.0 Bye'); sock.end(); }
        else w('502 5.5.2 Error: command not recognized');
      }
    });
    sock.on('error', () => { /* clientul poate inchide brusc in testele de eroare */ });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const cfg = { host: '127.0.0.1', port: server.address().port, secure: false, allowInsecureAuth: true, user: USER, pass: PASS, timeoutMs: 3000 };
    resolve({ server, state, cfg, close: () => new Promise((r) => { server.close(r); for (const s of sockets) s.destroy(); }) });
  }));
}

// §3 tests
test('send: AUTH PLAIN, RCPT partial, dot-stuffing si terminator corect', async () => {
  const f = await fakeSmtp();
  try {
    const raw = Buffer.from('Subject: test\r\n\r\n.ascuns\n..dublu\r\n.\r\nultima linie fara CRLF', 'utf8');
    const res = await send(f.cfg, { from: USER, recipients: ['a@x.ro', 'bad@x.ro', 'a@x.ro'], raw });
    assert.deepEqual(res.accepted, ['a@x.ro']);
    assert.deepEqual(res.rejected, ['bad@x.ro']);
    assert.match(res.response, /^250 /);
    assert.equal(f.state.auth, 'PLAIN');
    const wire = f.state.data.toString('latin1');
    assert.equal(wire, 'Subject: test\r\n\r\n..ascuns\r\n...dublu\r\n..\r\nultima linie fara CRLF\r\n');
    // de-stuffing pe partea serverului reda exact mesajul (cu CRLF normalizat)
    assert.equal(wire.replace(/^\./gm, ''), 'Subject: test\r\n\r\n.ascuns\r\n..dublu\r\n.\r\nultima linie fara CRLF\r\n');
    assert.ok(f.state.log.includes('MAIL FROM:<office@exemplu.ro>'));
    assert.ok(f.state.log.includes('QUIT'));
    assert.ok(!f.state.log.some((l) => l.includes(PASS)), 'parola nu circula in clar');
  } finally { await f.close(); }
});

test('AUTH PLAIN refuzat → fallback LOGIN', async () => {
  const f = await fakeSmtp({ plainFails: true });
  try {
    const res = await send(f.cfg, { from: USER, recipients: ['a@x.ro'], raw: Buffer.from('Subject: x\r\n\r\nok\r\n') });
    assert.equal(f.state.auth, 'LOGIN');
    assert.deepEqual(res.accepted, ['a@x.ro']);
  } finally { await f.close(); }
});

test('parola gresita → code AUTH; toti respinsi → REJECTED; verify ok', async () => {
  const f = await fakeSmtp();
  try {
    await assert.rejects(verify(Object.assign({}, f.cfg, { pass: 'gresit' })), (e) => e.code === 'AUTH' && /535/.test(e.message));
    await assert.rejects(send(f.cfg, { from: USER, recipients: ['bad@x.ro'], raw: Buffer.from('x') }), (e) => e.code === 'REJECTED');
    assert.equal(await verify(f.cfg), true);
  } finally { await f.close(); }
});

test('secure:false fara STARTTLS → CONNECT, parola nu pleaca', async () => {
  const f = await fakeSmtp();
  try {
    const cfg = Object.assign({}, f.cfg);
    delete cfg.allowInsecureAuth;
    await assert.rejects(verify(cfg), (e) => e.code === 'CONNECT' && /nu ofera conexiune criptata \(STARTTLS\); parola nu se trimite in clar/.test(e.message));
    assert.ok(!f.state.log.some((l) => /^AUTH/i.test(l)), 'nicio comanda AUTH trimisa');
  } finally { await f.close(); }
});

test('timeout la salut si conexiune refuzata', async () => {
  const f = await fakeSmtp({ greet: false });
  try {
    await assert.rejects(verify(Object.assign({}, f.cfg, { timeoutMs: 300 })), (e) => e.code === 'TIMEOUT');
  } finally { await f.close(); }
  const port = f.cfg.port; // serverul e inchis: portul refuza conexiunea
  await assert.rejects(verify(Object.assign({}, f.cfg, { port })), (e) => e.code === 'CONNECT');
});

test('dotStuff pe Buffer binar-safe', () => {
  assert.equal(dotStuff(Buffer.from('.')).toString(), '..\r\n.\r\n');
  assert.equal(dotStuff(Buffer.from('a\r\n')).toString(), 'a\r\n.\r\n');
  assert.equal(dotStuff(Buffer.from('a\rb')).toString(), 'a\r\nb\r\n.\r\n');
});
