/* MAP
 * §1 imports    L10-L13
 * §2 parts      L15-L53
 * §3 structure  L55-L67
 * §4 build      L69-L108
 * §5 exports    L110-L111
 */
'use strict';

// §1 imports
const crypto = require('crypto');
const E = require('./build-encode');
const { htmlToText } = require('./mime-decode');

// §2 parts
// O parte = { headers: [linii], body: string|Buffer } sau multipart { type, children }.
function boundary() {
  return '----=_Nex_' + crypto.randomBytes(12).toString('hex');
}

function textPart(type, text) {
  return {
    headers: [`Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: quoted-printable'],
    body: E.encodeQP(text),
  };
}

function filePart(att, inline) {
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(String(att.contentType || '')) ? att.contentType.toLowerCase() : 'application/octet-stream';
  const name = E.clean(att.filename) || 'atasament';
  const content = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content || '');
  const headers = [
    `Content-Type: ${type}${E.param('name', name)}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: ${inline ? 'inline' : 'attachment'}${E.param('filename', name)}`,
  ];
  if (inline) headers.push(`Content-ID: <${E.clean(att.contentId).replace(/^<|>$/g, '')}>`);
  return { headers, body: E.base64Lines(content) };
}

function multipart(subtype, children) {
  if (children.length === 1) return children[0];
  return { multipart: subtype, boundary: boundary(), children };
}

// Serializare cu CRLF; fiecare parte se termina cu CRLF inaintea delimitatorului.
function serialize(part) {
  if (!part.multipart) return [part.headers.join('\r\n'), '', part.body].join('\r\n');
  const out = [`Content-Type: multipart/${part.multipart};\r\n boundary="${part.boundary}"`, '', 'This is a multi-part message in MIME format.'];
  for (const ch of part.children) out.push(`--${part.boundary}`, serialize(ch));
  out.push(`--${part.boundary}--`, '');
  return out.join('\r\n');
}

// §3 structure
// mixed( related( alternative(text, html), inline... ), atasamente... )
function structure(opts) {
  const html = opts.html != null && String(opts.html).trim() !== '' ? String(opts.html) : null;
  const text = opts.text != null ? String(opts.text) : html ? htmlToText(html) : '';
  const atts = Array.isArray(opts.attachments) ? opts.attachments : [];
  const inline = html ? atts.filter((a) => a && a.contentId) : [];
  const regular = atts.filter((a) => a && !inline.includes(a));
  let body = html ? multipart('alternative', [textPart('text/plain', text), textPart('text/html', html)]) : textPart('text/plain', text);
  if (inline.length) body = multipart('related', [body, ...inline.map((a) => filePart(a, true))]);
  if (regular.length) body = multipart('mixed', [body, ...regular.map((a) => filePart(a, false))]);
  return body;
}

// §4 build
function normId(id) {
  const v = E.clean(id).replace(/[<>\s]/g, '');
  return v ? `<${v}>` : null;
}

function asList(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function build(opts) {
  const o = opts || {};
  const from = o.from || {};
  const fromAddr = E.clean(typeof from === 'string' ? from : from.address);
  if (!fromAddr) throw new Error('build: lipseste adresa expeditorului (from.address)');
  const domain = (fromAddr.split('@')[1] || 'localhost').replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  const messageId = normId(o.messageId) || `<${crypto.randomBytes(12).toString('hex')}.${Date.now().toString(36)}@${domain}>`;
  const to = asList(o.to), cc = asList(o.cc), bcc = asList(o.bcc);
  const headers = [`From: ${E.formatAddress(from)}`];
  if (to.length) headers.push(`To: ${E.formatAddressList(to)}`);
  if (cc.length) headers.push(`Cc: ${E.formatAddressList(cc)}`);
  headers.push(`Subject: ${E.encodeWords(o.subject || '')}`);
  headers.push(`Date: ${E.rfc5322Date(o.date)}`);
  headers.push(`Message-ID: ${messageId}`);
  const inReplyTo = normId(o.inReplyTo);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  const refs = asList(o.references).map(normId).filter(Boolean);
  if (refs.length) headers.push(`References: ${refs.join('\r\n ')}`);
  if (o.replyTo) headers.push(`Reply-To: ${E.formatAddressList(asList(o.replyTo))}`);
  headers.push('MIME-Version: 1.0');
  const raw = headers.join('\r\n') + '\r\n' + serialize(structure(o));
  const seen = new Set();
  const recipients = [];
  for (const a of [...to, ...cc, ...bcc]) {
    const addr = E.clean(typeof a === 'string' ? a : a && a.address);
    if (addr && !seen.has(addr.toLowerCase())) { seen.add(addr.toLowerCase()); recipients.push(addr); }
  }
  return { raw: Buffer.from(raw.endsWith('\r\n') ? raw : raw + '\r\n', 'utf8'), messageId, recipients };
}

// §5 exports
module.exports = { build };
