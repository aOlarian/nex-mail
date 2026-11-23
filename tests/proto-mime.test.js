/* MAP
 * §1 setup              L9-L15
 * §2 encoded-words      L16-L43
 * §3 multipart          L44-L173
 * §4 charsets & bodies  L174-L213
 */
'use strict';

// §1 setup
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, decodeWords, parseAddresses } = require('../proto/mime');

const crlf = (lines) => Buffer.from(lines.join('\r\n'), 'utf8');

// §2 encoded-words
test('decodeWords: B/Q, adiacente lipite, UTF-8 rupt intre cuvinte, alte charseturi', () => {
  assert.equal(decodeWords('=?UTF-8?B?yJhh?= =?UTF-8?B?YmxvbiDImw==?='), 'Șablon ț');
  // "ș" (C8 99) rupt intre doua cuvinte
  assert.equal(decodeWords('=?UTF-8?Q?Pa=C8?= =?UTF-8?Q?=99tele_fericit?='), 'Paștele fericit');
  assert.equal(decodeWords('=?iso-8859-2?Q?Bun=E3_ziua?= Ion'), 'Bună ziua Ion');
  assert.equal(decodeWords('=?windows-1250?B?TXVs/nVtZXNj?=!'), 'Mulţumesc!');
  assert.equal(decodeWords('Re: =?utf-8?q?ofert=C4=83?= nou'), 'Re: ofertă nou');
  assert.equal(decodeWords('=?UTF-8*ro?Q?ap=C4=83?='), 'apă');
  assert.equal(decodeWords('fara codare'), 'fara codare');
});

test('parseAddresses: nume cu virgula, codat, grup, comentarii', () => {
  const list = parseAddresses('"Popescu, Ion" <ion@a.ro>, c@d.ro, =?UTF-8?B?yJh0ZWZhbg==?= <s@e.ro>, '
    + 'echipa: x@f.ro, "Y Z" <y@f.ro>;, w@g.ro (Wanda W), <only@h.ro>');
  assert.deepEqual(list, [
    { name: 'Popescu, Ion', address: 'ion@a.ro' },
    { name: '', address: 'c@d.ro' },
    { name: 'Ștefan', address: 's@e.ro' },
    { name: '', address: 'x@f.ro' },
    { name: 'Y Z', address: 'y@f.ro' },
    { name: 'Wanda W', address: 'w@g.ro' },
    { name: '', address: 'only@h.ro' },
  ]);
  assert.deepEqual(parseAddresses('undisclosed-recipients:;'), []);
  assert.deepEqual(parseAddresses('"=?utf-8?Q?Ana_Maria?=" <a@b.c>'), [{ name: 'Ana Maria', address: 'a@b.c' }]);
});

// §3 multipart
const ATT = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80, 0x0d, 0x0a, 0x2e]);

function sampleMixed() {
  const b64 = ATT.toString('base64');
  return crlf([
    'From: =?UTF-8?Q?Andrei_Mure=C8=99an?= <andrei@exemplu.ro>',
    'To: "Popescu, Ion" <ion@a.ro>, b@c.ro',
    'Cc: Echipa <echipa@x.ro>',
    'Subject: =?UTF-8?B?RmFjdHVyxIMgxZ9pIGNvbnRyYWN0?=',
    ' =?UTF-8?B?IOKAlCBub2llbWJyaWU=?=',
    'Date: Thu, 12 Nov 2026 10:30:00 +0200',
    'Message-ID: <abc@exemplu.ro>',
    'In-Reply-To: <prev@x.ro>',
    'References: <first@x.ro>',
    ' <prev@x.ro>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mix"',
    '',
    'preamble',
    '--mix',
    'Content-Type: multipart/alternative; boundary=alt',
    '',
    '--alt',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Bun=C4=83 ziua, v=C4=83 trimit factura =',
    'ata=C8=99at=C4=83.',
    '--alt',
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('<p>Bună ziua, <b>factura</b></p>').toString('base64').replace(/(.{10})/g, '$1 \r\n'),
    '--alt--',
    '',
    '--mix',
    'Content-Type: application/pdf; name="ignored.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment;',
    " filename*0*=UTF-8''Factur%C4%83%20%C8%99i%20;",
    ' filename*1*=contract%20%C8%9B%C4%83r%C4%83.pdf',
    '',
    b64,
    '--mix',
    'Content-Type: message/rfc822',
    '',
    'Subject: Mesaj inclus',
    'From: z@z.ro',
    '',
    'Corp inclus.',
    '--mix--',
    'epilog',
  ]);
}

test('multipart/mixed: alternative + atasament RFC 2231 + message/rfc822', () => {
  const m = parse(sampleMixed());
  assert.equal(m.subject, 'Factură şi contract — noiembrie');
  assert.deepEqual(m.from, [{ name: 'Andrei Mureșan', address: 'andrei@exemplu.ro' }]);
  assert.equal(m.to.length, 2);
  assert.equal(m.to[0].name, 'Popescu, Ion');
  assert.equal(m.cc[0].address, 'echipa@x.ro');
  assert.equal(m.date, '2026-11-12T08:30:00.000Z');
  assert.equal(m.messageId, '<abc@exemplu.ro>');
  assert.equal(m.inReplyTo, '<prev@x.ro>');
  assert.deepEqual(m.references, ['<first@x.ro>', '<prev@x.ro>']);
  assert.equal(m.text, 'Bună ziua, vă trimit factura atașată.');
  assert.equal(m.html, '<p>Bună ziua, <b>factura</b></p>');
  assert.equal(m.attachments.length, 2);
  const [pdf, eml] = m.attachments;
  assert.equal(pdf.id, '2');
  assert.equal(pdf.filename, 'Factură și contract țără.pdf');
  assert.equal(pdf.contentType, 'application/pdf');
  assert.ok(pdf.content.equals(ATT));
  assert.equal(pdf.size, ATT.length);
  assert.equal(pdf.inline, false);
  assert.equal(eml.id, '3');
  assert.equal(eml.filename, 'Mesaj inclus.eml');
  assert.match(eml.content.toString(), /Corp inclus\./);
  assert.ok(m.headers instanceof Map);
  assert.equal(m.headers.get('subject').length, 1);
});

test('multipart/related cu imagine inline cid si html ales din ramura principala', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const raw = crlf([
    'From: a@b.ro', 'Subject: inline', 'Content-Type: multipart/related; boundary="r"', '',
    '--r', 'Content-Type: multipart/alternative; boundary="a"', '',
    '--a', 'Content-Type: text/plain', '', 'text simplu',
    '--a', 'Content-Type: text/html; charset=utf-8', '', '<p>poza <img src="cid:img1@x"></p>',
    '--a--',
    '--r', 'Content-Type: image/png', 'Content-ID: <img1@x>', 'Content-Transfer-Encoding: base64', '',
    png.toString('base64'),
    '--r--', '',
  ]);
  const m = parse(raw);
  assert.equal(m.html, '<p>poza <img src="cid:img1@x"></p>');
  assert.equal(m.text, 'text simplu');
  assert.equal(m.attachments.length, 1);
  const a = m.attachments[0];
  assert.equal(a.id, '2');
  assert.equal(a.contentId, 'img1@x');
  assert.equal(a.inline, true);
  assert.ok(a.content.equals(png));
});

test('invitatie Outlook: text/calendar in alternative → calendar + atasament', () => {
  const ics = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nSUMMARY:Ședință\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const raw = crlf([
    'From: a@b.ro', 'Subject: Invitatie', 'Content-Type: multipart/mixed; boundary="m"', '',
    '--m', 'Content-Type: multipart/alternative; boundary="a"', '',
    '--a', 'Content-Type: text/plain; charset=utf-8', '', 'Sunteti invitat',
    '--a', 'Content-Type: text/html; charset=utf-8', '', '<p>Sunteti invitat</p>',
    '--a', 'Content-Type: text/calendar; charset=utf-8; method=REQUEST', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(ics).toString('base64'),
    '--a--',
    '--m', 'Content-Type: application/ics; name="invite.ics"', 'Content-Disposition: attachment; filename="invite.ics"',
    'Content-Transfer-Encoding: base64', '', Buffer.from(ics).toString('base64'),
    '--m--',
  ]);
  const m = parse(raw);
  assert.equal(m.text, 'Sunteti invitat');
  assert.equal(m.html, '<p>Sunteti invitat</p>');
  assert.equal(m.calendar.length, 2);
  assert.equal(m.calendar[0], ics);
  assert.deepEqual(m.attachments.map((a) => [a.id, a.contentType, a.filename]),
    [['1.3', 'text/calendar', 'part-1.3.ics'], ['2', 'application/ics', 'invite.ics']]);
});

// §4 charsets & bodies
test('text/plain QP windows-1250, fara html', () => {
  const raw = crlf([
    'From: =?windows-1250?Q?Bogdan_=AAerban?= <b@x.ro>', 'Subject: =?windows-1250?Q?Ofert=E3?=',
    'Content-Type: text/plain; charset=windows-1250', 'Content-Transfer-Encoding: quoted-printable', '',
    'Mul=FEumim pentru ofert=E3. =AAi pre=FEul e bun.=20', 'Linia 2',
  ]);
  const m = parse(raw);
  assert.equal(m.subject, 'Ofertă');
  assert.equal(m.from[0].name, 'Bogdan Şerban');
  assert.equal(m.html, null);
  assert.equal(m.text, 'Mulţumim pentru ofertă. Şi preţul e bun. \nLinia 2');
  assert.equal(m.attachments.length, 0);
});

test('fallback charset: utf-8 declarat dar invalid → latin1; 8bit fara charset; antete 8bit', () => {
  const raw = Buffer.concat([
    Buffer.from('Subject: Caf\xe9 cr\xe8me\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n', 'latin1'),
    Buffer.from('Pr\xe9sentation', 'latin1'),
  ]);
  const m = parse(raw);
  assert.equal(m.subject, 'Café crème');
  assert.equal(m.text, 'Présentation');
  const m2 = parse(Buffer.from('Subject: Țară\r\nContent-Type: text/html\r\n\r\n<p>Țară</p>', 'utf8'));
  assert.equal(m2.subject, 'Țară');
  assert.equal(m2.html, '<p>Țară</p>');
  assert.equal(m2.text, null);
  assert.equal(m2.date, null);
});

test('mesaj fara antete MIME si multipart fara boundary inchis', () => {
  const m = parse(Buffer.from('Subject: simplu\n\nCorp cu LF.\n'));
  assert.equal(m.text, 'Corp cu LF.\n');
  const raw = crlf(['Content-Type: multipart/mixed; boundary=z', '', '--z', 'Content-Type: text/plain', '', 'neterminat']);
  assert.equal(parse(raw).text, 'neterminat');
  const odd = parse(crlf(['Content-Type: application/octet-stream; name="=?UTF-8?B?yJlhYmxvbi5kb2N4?="', 'Content-Transfer-Encoding: base64', '', 'QUJD']));
  assert.equal(odd.attachments[0].filename, 'șablon.docx');
  assert.equal(odd.attachments[0].id, '1');
  assert.equal(odd.attachments[0].content.toString(), 'ABC');
});
