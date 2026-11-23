/* MAP
 * §1 tokenizer         L9-L77
 * §2 response parsing  L79-L119
 * §3 helpers           L121-L152
 * §4 exports           L154-L155
 */
'use strict';

// §1 tokenizer
// Lucreaza pe Buffer: literalii {n} pot contine binar (BODY[]), deci nu convertim la string.
const SP = 0x20, LP = 0x28, RP = 0x29, DQ = 0x22, BS = 0x5c, LB = 0x7b, RB = 0x7d;
const CR = 0x0d, LF = 0x0a, LSQ = 0x5b, RSQ = 0x5d;

function tokenize(buf, start) {
  const root = [];
  const stack = [root];
  let i = start || 0;
  const n = buf.length;
  while (i < n) {
    const c = buf[i];
    const cur = stack[stack.length - 1];
    if (c === SP || c === CR || c === LF) { i++; continue; }
    if (c === LP) { const list = []; cur.push(list); stack.push(list); i++; continue; }
    if (c === RP) { if (stack.length > 1) stack.pop(); i++; continue; }
    if (c === DQ) { const r = readQuoted(buf, i + 1); cur.push(r.value); i = r.next; continue; }
    if (c === LB) {
      const r = readLiteral(buf, i);
      if (r) { cur.push(r.value); i = r.next; continue; }
    }
    const r = readAtom(buf, i);
    cur.push(r.value);
    i = r.next;
  }
  return root;
}

function readQuoted(buf, i) {
  const bytes = [];
  while (i < buf.length) {
    const c = buf[i];
    if (c === BS && i + 1 < buf.length) { bytes.push(buf[i + 1]); i += 2; continue; }
    if (c === DQ) { i++; break; }
    bytes.push(c);
    i++;
  }
  return { value: Buffer.from(bytes).toString('utf8'), next: i };
}

function readLiteral(buf, i) {
  let j = i + 1;
  let num = '';
  while (j < buf.length && buf[j] >= 0x30 && buf[j] <= 0x39) num += String.fromCharCode(buf[j++]);
  if (buf[j] === 0x2b) j++; // LITERAL+ "{n+}"
  if (!num || buf[j] !== RB) return null;
  j++;
  if (buf[j] === CR) j++;
  if (buf[j] === LF) j++;
  const len = Number(num);
  const value = buf.subarray(j, j + len);
  return { value: Buffer.from(value), next: j + len };
}

// Atomii pot contine [..] cu spatii si paranteze: BODY[HEADER.FIELDS (SUBJECT)]<0>.
function readAtom(buf, i) {
  const s = i;
  let depth = 0;
  while (i < buf.length) {
    const c = buf[i];
    if (c === LSQ) depth++;
    else if (c === RSQ && depth > 0) depth--;
    else if (depth === 0 && (c === SP || c === LP || c === RP || c === CR || c === LF)) break;
    else if (c === CR || c === LF) break;
    i++;
  }
  const text = buf.toString('latin1', s, i);
  return { value: text.toUpperCase() === 'NIL' ? null : text, next: i };
}

// §2 response parsing
const STATUS_WORDS = new Set(['OK', 'NO', 'BAD', 'BYE', 'PREAUTH']);

// Primul rand ca text (pana la CRLF sau la primul literal) pentru cuvinte de stare si coduri.
function firstLine(buf) {
  let end = buf.indexOf(LF);
  if (end < 0) end = buf.length;
  return buf.toString('utf8', 0, end).replace(/\r$/, '');
}

function parseStatusText(rest) {
  const m = /^\[([^\]]*)\]\s?(.*)$/.exec(rest);
  if (!m) return { code: null, args: [], text: rest };
  const parts = m[1].trim().split(/\s+/);
  return { code: parts[0].toUpperCase(), args: parts.slice(1), raw: m[1], text: m[2] };
}

// Intoarce { kind:'continue'|'untagged'|'tagged', tag, type, num, data, status, code, args, text }.
function parseResponse(buf) {
  const line = firstLine(buf);
  if (line.startsWith('+')) return { kind: 'continue', text: line.slice(1).trim() };
  const sp = line.indexOf(' ');
  const tag = sp < 0 ? line : line.slice(0, sp);
  const after = sp < 0 ? '' : line.slice(sp + 1);
  const wsp = after.indexOf(' ');
  const word = (wsp < 0 ? after : after.slice(0, wsp));
  const wordUp = word.toUpperCase();
  const tail = wsp < 0 ? '' : after.slice(wsp + 1);
  if (tag !== '*') {
    return Object.assign({ kind: 'tagged', tag, status: wordUp }, parseStatusText(tail));
  }
  if (STATUS_WORDS.has(wordUp)) {
    return Object.assign({ kind: 'untagged', type: wordUp, status: wordUp }, parseStatusText(tail));
  }
  const tokens = tokenize(buf, 0);
  // tokens[0] = '*'
  if (/^\d+$/.test(word)) {
    return { kind: 'untagged', num: Number(word), type: String(tokens[2] || '').toUpperCase(), data: tokens.slice(3) };
  }
  return { kind: 'untagged', type: wordUp, data: tokens.slice(2) };
}

// §3 helpers
// Lista plata de perechi FETCH (cheie valoare ...) → obiect cu chei in majuscule.
function fetchAttrs(list) {
  const out = {};
  if (!Array.isArray(list)) return out;
  for (let i = 0; i + 1 < list.length; i += 2) {
    const key = typeof list[i] === 'string' ? list[i].toUpperCase() : String(list[i]);
    out[key] = list[i + 1];
  }
  return out;
}

// Valoare de token → string (literalii vin ca Buffer).
function str(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return String(v);
}

// Cauta sfarsitul unui raspuns complet in buf (cu literali); -1 daca e incomplet.
function responseEnd(buf, from) {
  let i = from || 0;
  for (;;) {
    const lf = buf.indexOf(LF, i);
    if (lf < 0) return -1;
    const head = buf.toString('latin1', Math.max(i, lf - 24), lf + 1);
    const m = /\{(\d+)\+?\}\r?\n$/.exec(head);
    if (!m) return lf + 1;
    i = lf + 1 + Number(m[1]);
    if (i > buf.length) return -1;
  }
}

// §4 exports
module.exports = { tokenize, parseResponse, parseStatusText, fetchAttrs, str, responseEnd, firstLine };
