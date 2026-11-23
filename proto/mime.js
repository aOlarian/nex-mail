/* MAP
 * §1 imports          L12-L21
 * §2 entity tree      L23-L62
 * §3 multipart split  L64-L96
 * §4 body selection   L98-L166
 * §5 attachments      L168-L185
 * §6 parse            L187-L213
 * §7 exports          L215-L216
 */
'use strict';

// §1 imports
const W = require('./mime-words');
const D = require('./mime-decode');

const MAX_DEPTH = 40;
const EXT = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'text/plain': 'txt', 'text/html': 'html', 'text/calendar': 'ics', 'application/zip': 'zip',
  'message/rfc822': 'eml', 'message/delivery-status': 'txt', 'text/rfc822-headers': 'txt',
};

// §2 entity tree
function splitHead(buf) {
  let a = buf.indexOf('\r\n\r\n');
  let b = buf.indexOf('\n\n');
  if (buf.length && (buf[0] === 0x0a || (buf[0] === 0x0d && buf[1] === 0x0a))) return { head: Buffer.alloc(0), body: buf.subarray(buf[0] === 0x0a ? 1 : 2) };
  if (a < 0 && b < 0) return { head: buf, body: Buffer.alloc(0) };
  if (a >= 0 && (b < 0 || a < b)) return { head: buf.subarray(0, a), body: buf.subarray(a + 4) };
  return { head: buf.subarray(0, b), body: buf.subarray(b + 2) };
}

function first(headers, name) {
  const v = headers.get(name);
  return v && v.length ? v[0] : null;
}

// Arbore de entitati; id in stil IMAP: radacina ne-multipart = '1', copiii multipart = '1', '1.2' ...
function parseEntity(buf, id, depth, defaultType) {
  const { head, body } = splitHead(buf);
  const headers = W.parseHeaders(head);
  const ct = W.parseParams(first(headers, 'content-type') || defaultType || 'text/plain');
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(ct.value)) ct.value = 'text/plain';
  const disp = first(headers, 'content-disposition') ? W.parseParams(first(headers, 'content-disposition')) : null;
  const node = {
    id, headers, type: ct.value, params: ct.params,
    disposition: disp ? disp.value : null, dispParams: disp ? disp.params : {},
    encoding: String(first(headers, 'content-transfer-encoding') || '7bit').trim().toLowerCase(),
    contentId: (first(headers, 'content-id') || '').replace(/^\s*<|>\s*$/g, '').trim() || null,
    body, children: null,
  };
  if (node.type.startsWith('multipart/') && depth < MAX_DEPTH) {
    const parts = splitMultipart(body, node.params.boundary);
    if (parts) {
      const childDefault = node.type === 'multipart/digest' ? 'message/rfc822' : 'text/plain';
      node.children = parts.map((p, i) => parseEntity(p, id ? `${id}.${i + 1}` : String(i + 1), depth + 1, childDefault));
    } else {
      node.type = 'text/plain'; // multipart fara boundary valid: aratam corpul ca text
    }
  }
  return node;
}

// §3 multipart split
// Delimitatorul e valid doar la inceput de rand; CRLF dinaintea lui apartine delimitatorului.
function splitMultipart(body, boundary) {
  if (!boundary) return null;
  const delim = Buffer.from('--' + boundary);
  const starts = [];
  let pos = 0;
  for (;;) {
    const i = body.indexOf(delim, pos);
    if (i < 0) break;
    if (i === 0 || body[i - 1] === 0x0a) {
      const closing = body[i + delim.length] === 0x2d && body[i + delim.length + 1] === 0x2d;
      starts.push({ i, closing });
      if (closing) break;
    }
    pos = i + delim.length;
  }
  if (!starts.length) return null;
  const parts = [];
  for (let k = 0; k < starts.length; k++) {
    if (starts[k].closing) break;
    let s = body.indexOf(0x0a, starts[k].i);
    if (s < 0) break;
    s += 1;
    let e = k + 1 < starts.length ? starts[k + 1].i : body.length;
    if (k + 1 < starts.length) {
      if (body[e - 1] === 0x0a) e--;
      if (body[e - 1] === 0x0d) e--;
    }
    parts.push(body.subarray(s, Math.max(s, e)));
  }
  return parts;
}

// §4 body selection
function filenameOf(node) {
  return node.dispParams.filename || node.params.name || null;
}

function isBodyText(node) {
  return (node.type === 'text/plain' || node.type === 'text/html') && node.disposition !== 'attachment' && !filenameOf(node);
}

function isCalendar(node) {
  return node.type === 'text/calendar' || node.type === 'application/ics' || /\.ics$/i.test(filenameOf(node) || '');
}

function decodeText(node) {
  const bytes = D.decodeTransfer(node.body, node.encoding);
  let cs = node.params.charset;
  if (!cs && node.type === 'text/html') {
    const m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(bytes.toString('latin1', 0, Math.min(bytes.length, 4096)));
    if (m) cs = m[1];
  }
  const text = D.decodeCharset(bytes, cs);
  // corpul text ajunge la UI si la reguli: randuri normalizate la LF
  return node.type === 'text/plain' ? text.replace(/\r\n?/g, '\n') : text;
}

// slot = { html, text } de completat; null = corpul e deja ales, totul devine atasament.
function walk(node, res, slot, parentType) {
  if (node.children) {
    if (node.type === 'multipart/alternative' && slot) {
      for (const ch of node.children) {
        const sub = { html: null, text: null };
        walk(ch, res, sub, node.type);
        if (sub.html != null) slot.html = sub.html; // ultima alternativa = cea mai bogata
        if (sub.text != null && slot.text == null) slot.text = sub.text;
      }
      return;
    }
    if (node.type === 'multipart/related') {
      const start = node.params.start ? node.params.start.replace(/^<|>$/g, '') : null;
      const mainIdx = Math.max(0, start ? node.children.findIndex((c) => c.contentId === start) : 0);
      node.children.forEach((ch, i) => walk(ch, res, i === mainIdx ? slot : null, node.type));
      return;
    }
    let filled = false;
    for (const ch of node.children) {
      const empty = slot && slot.html == null && slot.text == null;
      if (slot && empty && !filled) { walk(ch, res, slot, node.type); filled = slot.html != null || slot.text != null; continue; }
      // parti text suplimentare in mixed (Apple Mail: text, poza, text) se lipesc la corp
      if (slot && filled && !ch.children && isBodyText(ch) && ch.disposition !== 'attachment') {
        const t = decodeText(ch);
        if (ch.type === 'text/html' && slot.html != null) { slot.html += t; continue; }
        if (ch.type === 'text/plain' && slot.text != null) { slot.text += '\n' + t; continue; }
      }
      walk(ch, res, null, node.type);
    }
    return;
  }
  if (isCalendar(node)) {
    res.calendar.push(decodeText(node));
    addAttachment(node, res, parentType);
    return;
  }
  if (slot && isBodyText(node)) {
    if (node.type === 'text/html') { if (slot.html == null) slot.html = decodeText(node); }
    else if (slot.text == null) slot.text = decodeText(node);
    return;
  }
  addAttachment(node, res, parentType);
}

// §5 attachments
function addAttachment(node, res, parentType) {
  const content = node.type === 'message/rfc822' || node.type.startsWith('multipart/')
    ? (/^(base64|quoted-printable)$/.test(node.encoding) ? D.decodeTransfer(node.body, node.encoding) : Buffer.from(node.body))
    : D.decodeTransfer(node.body, node.encoding);
  let filename = filenameOf(node);
  if (!filename && node.type === 'message/rfc822') {
    const inner = W.parseHeaders(splitHead(content).head);
    const subj = W.decodeWords((inner.get('subject') || [''])[0]).replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').trim();
    filename = (subj || 'mesaj').slice(0, 80) + '.eml';
  }
  if (!filename) filename = `part-${node.id}.${EXT[node.type] || 'bin'}`;
  const inline = !!node.contentId && node.disposition !== 'attachment' && (node.disposition === 'inline' || parentType === 'multipart/related');
  res.attachments.push({
    id: node.id, filename, contentType: node.type, size: content.length,
    contentId: node.contentId, inline, content: Buffer.from(content),
  });
}

// §6 parse
function addrs(headers, name) {
  const all = headers.get(name);
  return all ? all.flatMap((v) => W.parseAddresses(v)) : [];
}

function parse(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ''), 'utf8');
  const root = parseEntity(buf, '', 0, null);
  if (!root.children) root.id = '1';
  const res = { attachments: [], calendar: [] };
  const slot = { html: null, text: null };
  walk(root, res, slot, null);
  const h = root.headers;
  const subject = first(h, 'subject');
  return {
    headers: h,
    subject: subject == null ? '' : W.decodeWords(subject).replace(/\s*[\r\n]+\s*/g, ' ').trim(),
    from: addrs(h, 'from'), to: addrs(h, 'to'), cc: addrs(h, 'cc'), bcc: addrs(h, 'bcc'), replyTo: addrs(h, 'reply-to'),
    date: W.parseDate(first(h, 'date')),
    messageId: W.msgIds(first(h, 'message-id'))[0] || null,
    inReplyTo: W.msgIds(first(h, 'in-reply-to'))[0] || null,
    references: (h.get('references') || []).flatMap((v) => W.msgIds(v)),
    html: slot.html, text: slot.text,
    attachments: res.attachments, calendar: res.calendar,
  };
}

// §7 exports
module.exports = { parse, decodeWords: W.decodeWords, parseAddresses: W.parseAddresses, htmlToText: D.htmlToText };
