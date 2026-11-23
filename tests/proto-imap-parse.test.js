/* MAP
 * §1 setup            L10-L19
 * §2 tokenizer        L20-L58
 * §3 envelope         L59-L91
 * §4 bodystructure    L92-L130
 * §5 utf7 & commands  L131-L155
 */
'use strict';

// §1 setup
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../proto/imap-parse');
const S = require('../proto/imap-struct');
const utf7 = require('../proto/utf7');
const cmd = require('../proto/imap-cmd');

const b = (s) => Buffer.from(s, 'latin1');

// §2 tokenizer
test('tokenizer: atomi, citate, NIL, liste imbricate', () => {
  const t = P.tokenize(b('* LIST (\\HasNoChildren (a "b c" NIL)) "/" "INBOX/Sub \\"x\\""\r\n'));
  assert.deepEqual(t, ['*', 'LIST', ['\\HasNoChildren', ['a', 'b c', null]], '/', 'INBOX/Sub "x"']);
});

test('tokenizer: literal binar cu CRLF si paranteze in interior', () => {
  const payload = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x29, 0x28, 0x7b, 0x33, 0x7d, 0x0d, 0x0a, 0x80]);
  const buf = Buffer.concat([b(`* 1 FETCH (UID 7 BODY[] {${payload.length}}\r\n`), payload, b(' FLAGS (\\Seen))\r\n')]);
  assert.equal(P.responseEnd(buf, 0), buf.length);
  const r = P.parseResponse(buf);
  assert.equal(r.type, 'FETCH');
  assert.equal(r.num, 1);
  const a = P.fetchAttrs(r.data[0]);
  assert.equal(a.UID, '7');
  assert.ok(Buffer.isBuffer(a['BODY[]']));
  assert.ok(a['BODY[]'].equals(payload));
  assert.deepEqual(a.FLAGS, ['\\Seen']);
});

test('tokenizer: atom cu sectiune si paranteze BODY[HEADER.FIELDS (SUBJECT)]<0>', () => {
  const r = P.parseResponse(b('* 2 FETCH (BODY[HEADER.FIELDS (SUBJECT DATE)]<0> "x" UID 9)\r\n'));
  const a = P.fetchAttrs(r.data[0]);
  assert.equal(a['BODY[HEADER.FIELDS (SUBJECT DATE)]<0>'], 'x');
  assert.equal(a.UID, '9');
});

test('raspunsuri de stare: coduri si text', () => {
  const t = P.parseResponse(b('A5 OK [APPENDUID 42 1001] Append completed\r\n'));
  assert.equal(t.kind, 'tagged');
  assert.equal(t.status, 'OK');
  assert.equal(t.code, 'APPENDUID');
  assert.deepEqual(t.args, ['42', '1001']);
  const u = P.parseResponse(b('* OK [UIDVALIDITY 3857529045] UIDs valid\r\n'));
  assert.equal(u.code, 'UIDVALIDITY');
  assert.equal(P.parseResponse(b('+ go ahead\r\n')).kind, 'continue');
  assert.equal(P.responseEnd(b('* 1 FETCH (BODY[] {10}\r\nabc'), 0), -1);
});

// §3 envelope
const RFC_FETCH = '* 12 FETCH (FLAGS (\\Seen) INTERNALDATE "17-Jul-1996 02:44:25 -0700" RFC822.SIZE 4286 '
  + 'ENVELOPE ("Wed, 17 Jul 1996 02:23:25 -0700 (PDT)" "IMAP4rev1 WG mtg summary and minutes" '
  + '(("Terry Gray" NIL "gray" "cac.washington.edu")) (("Terry Gray" NIL "gray" "cac.washington.edu")) '
  + '(("Terry Gray" NIL "gray" "cac.washington.edu")) ((NIL NIL "imap" "cac.washington.edu")) '
  + '((NIL NIL "minutes" "CNRI.Reston.VA.US")("John Klensin" NIL "KLENSIN" "MIT.EDU")) NIL NIL '
  + '"<B27397-0100000@cac.washington.edu>") BODY ("TEXT" "PLAIN" ("CHARSET" "US-ASCII") NIL NIL "7BIT" 3028 92))\r\n';

test('ENVELOPE real (RFC 3501) + INTERNALDATE', () => {
  const a = P.fetchAttrs(P.parseResponse(b(RFC_FETCH)).data[0]);
  const env = S.parseEnvelope(a.ENVELOPE);
  assert.equal(env.subject, 'IMAP4rev1 WG mtg summary and minutes');
  assert.equal(env.date, '1996-07-17T09:23:25.000Z');
  assert.deepEqual(env.from, [{ name: 'Terry Gray', address: 'gray@cac.washington.edu' }]);
  assert.deepEqual(env.to, [{ name: '', address: 'imap@cac.washington.edu' }]);
  assert.equal(env.cc.length, 2);
  assert.equal(env.cc[1].address, 'KLENSIN@MIT.EDU');
  assert.equal(env.messageId, '<B27397-0100000@cac.washington.edu>');
  assert.equal(env.inReplyTo, null);
});

test('ENVELOPE cu subiect literal codat, nume codat si grup', () => {
  const subj = '=?UTF-8?B?w45udMOibG5pcmU=?= =?UTF-8?Q?_s=C4=83pt=C4=83m=C3=A2nal=C4=83?=';
  const line = `* 3 FETCH (UID 5 ENVELOPE (NIL {${Buffer.byteLength(subj)}}\r\n${subj} `
    + '(("=?iso-8859-2?Q?=AAtefan?=" NIL "s" "x.ro")) NIL NIL '
    + '((NIL NIL "echipa" NIL)("Ana" NIL "ana" "y.ro")(NIL NIL NIL NIL)) NIL NIL NIL NIL))\r\n';
  const a = P.fetchAttrs(P.parseResponse(b(line)).data[0]);
  const env = S.parseEnvelope(a.ENVELOPE);
  assert.equal(env.subject, 'Întâlnire săptămânală');
  assert.deepEqual(env.from, [{ name: 'Ştefan', address: 's@x.ro' }]);
  assert.deepEqual(env.to, [{ name: 'Ana', address: 'ana@y.ro' }]);
});

// §4 bodystructure
const MIXED = '(((("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 120 4 NIL NIL NIL NIL)'
  + '("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 450 9 NIL NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "b2") NIL NIL NIL)'
  + '("IMAGE" "PNG" ("NAME" "logo.png") "<logo@x>" NIL "BASE64" 2048 NIL ("INLINE" ("FILENAME" "logo.png")) NIL NIL) "RELATED" ("BOUNDARY" "b1") NIL NIL NIL)'
  + '("APPLICATION" "PDF" ("NAME" "Factura.pdf") NIL NIL "BASE64" 10240 NIL ("ATTACHMENT" ("FILENAME" "=?UTF-8?Q?Factur=C4=83.pdf?=")) NIL NIL)'
  + ' "MIXED" ("BOUNDARY" "b0") NIL NIL NIL)';

test('BODYSTRUCTURE multipart real: sectiuni, atasamente, parte pentru preview', () => {
  const tree = S.parseBodyStructure(P.tokenize(b(MIXED))[0]);
  assert.equal(tree.type, 'multipart/mixed');
  const rel = tree.children[0];
  assert.equal(rel.type, 'multipart/related');
  assert.equal(rel.children[0].children[1].part, '1.1.2');
  assert.equal(rel.children[1].part, '1.2');
  assert.equal(tree.children[1].part, '2');
  assert.equal(S.filenameOf(tree.children[1]), 'Factură.pdf');
  assert.equal(S.hasAttachments(tree), true);
  const pick = S.previewPart(tree);
  assert.equal(pick.section, '1.1.1');
  assert.equal(pick.node.encoding, 'quoted-printable');
});

test('BODYSTRUCTURE: doar inline cid → fara atasamente; mesaj simplu → sectiunea TEXT', () => {
  const rel = '((("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 45 2 NIL NIL NIL NIL)'
    + '("IMAGE" "JPEG" NIL "<a@b>" NIL "BASE64" 100 NIL NIL NIL NIL) "RELATED" ("BOUNDARY" "x") NIL NIL NIL))';
  const tree = S.parseBodyStructure(P.tokenize(b(rel))[0][0]);
  assert.equal(S.hasAttachments(tree), false);
  const single = S.parseBodyStructure(P.tokenize(b('("TEXT" "PLAIN" ("CHARSET" "windows-1250") NIL NIL "QUOTED-PRINTABLE" 10 1 NIL NIL NIL NIL)'))[0]);
  assert.equal(S.previewPart(single).section, 'TEXT');
  const prev = S.decodePreview(b('Bun=E3 ziua, =BAi mul=FEumesc pentru ofert=E3. Linie trunchiat=E'), single, 200);
  assert.equal(prev, 'Bună ziua, şi mulţumesc pentru ofertă. Linie trunchiat');
});

test('decodePreview: base64 trunchiat si html', () => {
  const node = { type: 'text/html', encoding: 'base64', params: { charset: 'utf-8' } };
  const full = Buffer.from('<html><head><style>p{}</style></head><body><p>Salut &amp; bun&#259; ziua</p><p>Al doilea paragraf</p></body></html>').toString('base64');
  assert.equal(S.decodePreview(b(full.slice(0, full.length - 3)), node, 200).startsWith('Salut & bună ziua Al doilea'), true);
});

// §5 utf7 & commands
test('modified UTF-7 dus-intors', () => {
  assert.equal(utf7.decode('~peter/mail/&U,BTFw-/&ZeVnLIqe-'), '~peter/mail/台北/日本語');
  assert.equal(utf7.decode('Ciorne &AQM-'), 'Ciorne ă');
  for (const s of ['Ciorne', 'Coș de gunoi', 'Șablon & Țară', 'A&B', 'Emoji 😀 x', 'Mesaje trimise/Arhivă 2026']) {
    assert.equal(utf7.decode(utf7.encode(s)), s);
    assert.match(utf7.encode(s), /^[\x20-\x7e]*$/);
  }
  assert.equal(utf7.encode('A&B'), 'A&-B');
});

test('set compact, loturi, cautare cu CHARSET', () => {
  assert.equal(cmd.compactSet([9, 1, 3, 5, 6, 7, 8, 3]), '1,3,5:9');
  assert.equal(cmd.compactSet([]), '');
  assert.equal(cmd.chunkUids([5, 4, 3, 2, 1], 2).length, 3);
  const s1 = cmd.buildSearch({ unseen: true, flagged: true });
  assert.deepEqual(s1, { pieces: ['UNSEEN ', 'FLAGGED'], utf8: false });
  const s2 = cmd.buildSearch({ text: 'factură' });
  assert.equal(s2.utf8, true);
  assert.equal(s2.pieces[0], 'OR OR ');
  assert.ok(s2.pieces.some((p) => p && p.literal && p.literal.toString() === 'factură'));
  assert.deepEqual(cmd.buildSearch('UID 5:*'), { pieces: ['UID 5:*'], utf8: false });
  assert.equal(cmd.guessSpecial('Coș de gunoi'), '\\Trash');
  assert.equal(cmd.mailbox('Ciorne ă'), '"Ciorne &AQM-"');
});
