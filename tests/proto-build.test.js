/* MAP
 * §1 setup       L8-L17
 * §2 round-trip  L18-L89
 * §3 encodings   L90-L107
 */
'use strict';

// §1 setup
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { build } = require('../proto/build');
const { parse } = require('../proto/mime');
const E = require('../proto/build-encode');

const lines = (buf) => buf.toString('latin1').split('\r\n');

// §2 round-trip
test('build → parse: subiect cu diacritice, html cu bold/liste, atasament binar identic', () => {
  const bin = crypto.randomBytes(5000);
  const subject = 'Întâlnire șăptămânală: ofertă & preț — țară ȘI ĂÎÂ, subiect suficient de lung ca să fie împărțit';
  const html = '<p>Bună <b>Ana</b>,</p><ul><li>punctul unu</li><li>punctul doi</li></ul><p>Toate&nbsp;bune &amp; frumoase.<br>Semnătură</p>';
  const r = build({
    from: { name: 'Ștefan Mureșan', address: 'office@example.com' },
    to: [{ name: 'Popescu, Ion', address: 'ion@a.ro' }, { name: '', address: 'b@c.ro' }],
    cc: [{ name: 'Țuțu', address: 'tutu@x.ro' }],
    bcc: [{ name: 'Ascuns', address: 'secret@x.ro' }, { address: 'ION@a.ro' }],
    subject, html,
    inReplyTo: '<prev@x.ro>', references: ['<first@x.ro>', 'prev@x.ro'],
    attachments: [{ filename: 'Factură țară 2026 cu nume foarte lung pentru continuări RFC2231 ăîâșț.bin', contentType: 'application/octet-stream', content: bin }],
  });
  assert.match(r.messageId, /^<[0-9a-f]+\.[0-9a-z]+@example\.com>$/);
  assert.deepEqual(r.recipients, ['ion@a.ro', 'b@c.ro', 'tutu@x.ro', 'secret@x.ro']);
  const text = r.raw.toString('latin1');
  assert.ok(!/secret@x\.ro|Ascuns/.test(text), 'Bcc nu apare in antete');
  assert.match(text, /\r\nMIME-Version: 1\.0\r\n/);
  assert.match(text, /\r\nDate: \w{3}, \d{1,2} \w{3} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}\r\n/);
  assert.ok(!/[^\r]\n/.test(text), 'doar CRLF');
  for (const l of lines(r.raw)) assert.ok(l.length <= 78, `linie prea lunga (${l.length}): ${l.slice(0, 40)}`);
  assert.ok(/^[\x00-\x7f]*$/.test(text), 'mesaj 7bit');

  const m = parse(r.raw);
  assert.equal(m.subject, subject);
  assert.deepEqual(m.from, [{ name: 'Ștefan Mureșan', address: 'office@example.com' }]);
  assert.deepEqual(m.to, [{ name: 'Popescu, Ion', address: 'ion@a.ro' }, { name: '', address: 'b@c.ro' }]);
  assert.deepEqual(m.cc, [{ name: 'Țuțu', address: 'tutu@x.ro' }]);
  assert.deepEqual(m.bcc, []);
  assert.equal(m.messageId, r.messageId);
  assert.equal(m.inReplyTo, '<prev@x.ro>');
  assert.deepEqual(m.references, ['<first@x.ro>', '<prev@x.ro>']);
  assert.equal(m.html, html);
  assert.equal(m.text, 'Bună Ana,\n\n- punctul unu\n- punctul doi\n\nToate bune & frumoase.\nSemnătură');
  assert.equal(m.attachments.length, 1);
  const a = m.attachments[0];
  assert.equal(a.filename, 'Factură țară 2026 cu nume foarte lung pentru continuări RFC2231 ăîâșț.bin');
  assert.ok(a.content.equals(bin), 'atasament identic octet cu octet');
});

test('build: inline cid → multipart/related; fara html → text/plain simplu', () => {
  const png = crypto.randomBytes(300);
  const r = build({
    from: { address: 'a@b.ro' }, to: [{ address: 'c@d.ro' }], subject: 'Poza',
    html: '<p>Logo: <img src="cid:logo@nex"></p>',
    attachments: [{ filename: 'logo.png', contentType: 'image/png', content: png, contentId: 'logo@nex' },
      { filename: 'doc.txt', contentType: 'text/plain', content: Buffer.from('salut') }],
  });
  const t = r.raw.toString();
  assert.match(t, /multipart\/mixed/);
  assert.match(t, /multipart\/related/);
  assert.match(t, /Content-ID: <logo@nex>/);
  const m = parse(r.raw);
  assert.equal(m.text, 'Logo:');
  const inl = m.attachments.find((x) => x.contentId === 'logo@nex');
  assert.equal(inl.inline, true);
  assert.ok(inl.content.equals(png));
  assert.equal(m.attachments.find((x) => x.filename === 'doc.txt').content.toString(), 'salut');

  const p = build({ from: 'x@y.ro', to: ['z@y.ro'], subject: 'Doar text', text: 'Linia 1\n.linie cu punct\nFrom acolo  ' });
  const pm = parse(p.raw);
  assert.equal(pm.html, null);
  assert.equal(pm.text, 'Linia 1\n.linie cu punct\nFrom acolo  \n');
  assert.match(p.raw.toString(), /\r\n=2Elinie cu punct\r\n/);
});

test('build: antetele nu permit injectie CR/LF', () => {
  const r = build({ from: { name: 'X\r\nBcc: evil@x.ro', address: 'a@b.ro' }, to: [{ address: 'c@d.ro' }], subject: 'S\r\nBcc: evil@x.ro', text: 't' });
  assert.ok(!/\r\nBcc:/i.test(r.raw.toString()));
});

// §3 encodings
test('encodeQP: linii <= 76, soft breaks, octeti corecti', () => {
  const src = 'ș'.repeat(100) + ' x '.repeat(40) + '= sfârșit ';
  const qp = E.encodeQP(src);
  for (const l of qp.split('\r\n')) assert.ok(l.length <= 76, `linie ${l.length}`);
  assert.ok(qp.endsWith('=20'));
  const { decodeQP } = require('../proto/mime-decode');
  assert.equal(decodeQP(Buffer.from(qp)).toString('utf8'), src);
});

test('encodeWords si param RFC 2231', () => {
  assert.equal(E.encodeWords('ASCII simplu'), 'ASCII simplu');
  const enc = E.encodeWords('ă'.repeat(60));
  for (const w of enc.split('\r\n ')) assert.ok(w.length <= 75);
  assert.equal(require('../proto/mime-words').decodeWords(enc), 'ă'.repeat(60));
  assert.equal(E.param('filename', 'a.pdf'), ';\r\n filename="a.pdf"');
  assert.equal(E.param('filename', 'ă.pdf'), ";\r\n filename*=UTF-8''%C4%83.pdf");
});
