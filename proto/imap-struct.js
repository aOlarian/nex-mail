/* MAP
 * §1 imports        L11-L14
 * §2 envelope       L16-L47
 * §3 bodystructure  L49-L90
 * §4 attachments    L92-L119
 * §5 preview        L121-L155
 * §6 exports        L157-L158
 */
'use strict';

// §1 imports
const { str } = require('./imap-parse');
const { decodeWords, parseDate, msgIds } = require('./mime-words');
const { decodeCharset, decodeTransfer, htmlToText } = require('./mime-decode');

// §2 envelope
// Adresele vin ca liste (name adl mailbox host); grupurile au host NIL si se sar.
function envAddresses(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    if (!Array.isArray(a)) continue;
    const mailbox = str(a[2]);
    const host = str(a[3]);
    if (host == null) continue; // inceput/sfarsit de grup
    const name = decodeWords(str(a[0]) || '').trim();
    out.push({ name, address: mailbox ? `${mailbox}@${host}` : host });
  }
  return out;
}

function parseEnvelope(env) {
  if (!Array.isArray(env)) return null;
  const firstId = (v) => (msgIds(str(v))[0] || (str(v) ? str(v).trim() : null));
  return {
    date: parseDate(str(env[0])),
    subject: decodeWords(str(env[1]) || '').replace(/\s*\r?\n\s*/g, ' ').trim(),
    from: envAddresses(env[2]),
    sender: envAddresses(env[3]),
    replyTo: envAddresses(env[4]),
    to: envAddresses(env[5]),
    cc: envAddresses(env[6]),
    bcc: envAddresses(env[7]),
    inReplyTo: firstId(env[8]),
    messageId: firstId(env[9]),
  };
}

// §3 bodystructure
function paramList(v) {
  const out = {};
  if (!Array.isArray(v)) return out;
  for (let i = 0; i + 1 < v.length; i += 2) out[String(str(v[i])).toLowerCase()] = str(v[i + 1]);
  return out;
}

function dispositionOf(v) {
  if (!Array.isArray(v) || !v.length) return null;
  return { type: String(str(v[0]) || '').toLowerCase(), params: paramList(v[1]) };
}

// Normalizeaza BODYSTRUCTURE in arbore cu sectiuni IMAP ('1', '1.2', ...).
function parseBodyStructure(bs, part) {
  if (!Array.isArray(bs)) return null;
  if (Array.isArray(bs[0])) {
    const children = [];
    let i = 0;
    while (i < bs.length && Array.isArray(bs[i])) {
      const sec = part ? `${part}.${children.length + 1}` : String(children.length + 1);
      children.push(parseBodyStructure(bs[i], sec));
      i++;
    }
    return {
      part: part || '', multipart: true, type: 'multipart/' + String(str(bs[i]) || 'mixed').toLowerCase(),
      params: paramList(bs[i + 1]), disposition: dispositionOf(bs[i + 2]), children,
    };
  }
  const type = `${String(str(bs[0]) || 'text').toLowerCase()}/${String(str(bs[1]) || 'plain').toLowerCase()}`;
  const node = {
    part: part || '1', multipart: false, type, params: paramList(bs[2]), id: str(bs[3]),
    encoding: String(str(bs[5]) || '7bit').toLowerCase(), size: Number(str(bs[6])) || 0,
  };
  // extensii: text/* are "lines" la 7; message/rfc822 are envelope, body, lines la 7..9
  let ext = 7;
  if (type.startsWith('text/')) ext = 8;
  else if (type === 'message/rfc822') ext = 10;
  node.disposition = dispositionOf(bs[ext + 1]);
  if (!part) node.root = true;
  return node;
}

// §4 attachments
function filenameOf(node) {
  const d = node.disposition && node.disposition.params;
  const name = (d && (d.filename || d['filename*'])) || node.params.name || null;
  return name ? decodeWords(name) : null;
}

function isAttachment(node, parentType) {
  const disp = node.disposition ? node.disposition.type : null;
  if (disp === 'attachment') return true;
  if (node.type === 'message/rfc822') return true;
  if (disp === 'inline' && node.id) return false;
  if (parentType === 'multipart/related' && node.id) return false;
  const named = !!filenameOf(node);
  if (node.type === 'text/plain' || node.type === 'text/html') return named && disp !== 'inline';
  if (node.type === 'text/calendar' || node.type.startsWith('multipart/')) return false;
  if (node.type === 'application/pkcs7-signature' || node.type === 'application/pgp-signature') return false;
  return named || node.type.startsWith('application/') || node.type.startsWith('image/') || node.type.startsWith('audio/') || node.type.startsWith('video/');
}

function hasAttachments(tree) {
  const walk = (node, parentType) => {
    if (!node) return false;
    if (node.multipart) return node.children.some((c) => walk(c, node.type));
    return isAttachment(node, parentType);
  };
  return walk(tree, null);
}

// §5 preview
// Prima parte text/plain din corp (nu atasament), altfel text/html.
function previewPart(tree) {
  let plain = null, html = null;
  const walk = (node, parentType) => {
    if (!node || (plain && html)) return;
    if (node.multipart) { node.children.forEach((c) => walk(c, node.type)); return; }
    if (isAttachment(node, parentType)) return;
    if (node.type === 'text/plain' && !plain) plain = node;
    else if (node.type === 'text/html' && !html) html = node;
  };
  walk(tree, null);
  const node = plain || html;
  if (!node) return null;
  // mesaj ne-multipart: sectiunea TEXT e corpul, mai sigura decat '1' pe unele servere
  return { section: node.root ? 'TEXT' : node.part, node };
}

// Decodeaza un fragment trunchiat dintr-o parte; '' daca nu iese text curat.
function decodePreview(buf, node, max) {
  if (!buf || !buf.length) return '';
  let raw = buf;
  if (node.encoding === 'base64') {
    const s = raw.toString('latin1').replace(/[^A-Za-z0-9+/]/g, '');
    raw = Buffer.from(s.slice(0, s.length - (s.length % 4)), 'latin1');
  } else if (node.encoding === 'quoted-printable') {
    raw = Buffer.from(raw.toString('latin1').replace(/=[0-9A-Fa-f]?$/, ''), 'latin1');
  }
  let text = decodeCharset(decodeTransfer(raw, node.encoding), node.params.charset);
  text = text.replace(/�+$/, '');
  if (node.type === 'text/html') text = htmlToText(text.replace(/<[^>]*$/, ''));
  text = text.replace(/\s+/g, ' ').trim();
  if (/^(Content-|MIME-Version|--)/i.test(text) || /=\?[^?]+\?[BQ]\?/i.test(text) || /�{3,}/.test(text)) return '';
  return text.slice(0, max || 200);
}

// §6 exports
module.exports = { parseEnvelope, envAddresses, parseBodyStructure, hasAttachments, isAttachment, filenameOf, previewPart, decodePreview };
