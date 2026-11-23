/* MAP
 * §1 charset       L9-L57
 * §2 transfer      L59-L101
 * §3 html to text  L103-L140
 * §4 exports       L142-L143
 */
'use strict';

// §1 charset
const ALIASES = {
  utf8: 'utf-8', 'utf-8': 'utf-8', 'us-ascii': 'utf-8', ascii: 'utf-8', 'ansi_x3.4-1968': 'utf-8',
  latin1: 'iso-8859-1', latin2: 'iso-8859-2', cp1250: 'windows-1250', cp1252: 'windows-1252',
  'x-unknown': 'utf-8', unknown: 'utf-8', 'unknown-8bit': 'utf-8', default: 'utf-8',
};
const decoders = new Map();

function normCharset(cs) {
  let c = String(cs || '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  c = c.replace(/\*.*$/, ''); // RFC 2231 "utf-8*ro"
  if (!c) return 'utf-8';
  if (ALIASES[c]) return ALIASES[c];
  const win = /^(?:x-)?(?:cp|windows)[-_]?(\d{3,4})$/.exec(c);
  if (win) return 'windows-' + win[1];
  const iso = /^iso[-_]?8859[-_]?(\d{1,2})$/.exec(c);
  if (iso) return 'iso-8859-' + iso[1];
  return c;
}

function getDecoder(label, fatal) {
  const key = label + (fatal ? '!' : '');
  if (decoders.has(key)) return decoders.get(key);
  let dec = null;
  try {
    dec = new TextDecoder(label, { fatal });
  } catch (e) {
    // eticheta necunoscuta pentru ICU: semnalam prin null, apelantul face fallback
    dec = null;
  }
  decoders.set(key, dec);
  return dec;
}

// utf-8 declarat (sau lipsa) dar invalid → windows-1252 (latin1 practic, fara gauri la 0x80-0x9f).
function decodeCharset(buf, charset) {
  if (!buf || !buf.length) return '';
  const label = normCharset(charset);
  if (label !== 'utf-8') {
    const dec = getDecoder(label, false);
    if (dec) return dec.decode(buf);
  }
  try {
    return getDecoder('utf-8', true).decode(buf);
  } catch (e) {
    // octeti invalizi in UTF-8: textul e de fapt intr-un charset vechi
    return getDecoder('windows-1252', false).decode(buf);
  }
}

// §2 transfer
function decodeBase64(input) {
  const s = Buffer.isBuffer(input) ? input.toString('latin1') : String(input || '');
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  return Buffer.from(clean.slice(0, clean.length - (clean.length % 4 === 1 ? 1 : 0)), 'base64');
}

function hexVal(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

function decodeQP(input) {
  const src = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ''), 'latin1');
  const out = Buffer.alloc(src.length);
  let o = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c !== 0x3d) { out[o++] = c; continue; }
    // "=" urmat de spatii optionale si sfarsit de rand = soft break
    let j = i + 1;
    while (j < src.length && (src[j] === 0x20 || src[j] === 0x09)) j++;
    if (j >= src.length) { i = j; continue; }
    if (src[j] === 0x0d || src[j] === 0x0a) {
      if (src[j] === 0x0d && src[j + 1] === 0x0a) j++;
      i = j;
      continue;
    }
    const h = hexVal(src[i + 1]), l = hexVal(src[i + 2]);
    if (h >= 0 && l >= 0) { out[o++] = (h << 4) | l; i += 2; continue; }
    out[o++] = c;
  }
  return out.subarray(0, o);
}

function decodeTransfer(buf, encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  if (enc === 'base64') return decodeBase64(buf);
  if (enc === 'quoted-printable') return decodeQP(buf);
  return Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'latin1');
}

// §3 html to text
const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", euro: '€', copy: '©', reg: '®',
  trade: '™', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“',
  rdquo: '”', lsquo: '‘', rsquo: '’', sbquo: '‚', bull: '•', middot: '·', deg: '°', times: '×',
  icirc: 'î', Icirc: 'Î', acirc: 'â', Acirc: 'Â', abreve: 'ă', Abreve: 'Ă', scedil: 'ş', Scedil: 'Ş',
  tcedil: 'ţ', Tcedil: 'Ţ', scaron: 'š', Scaron: 'Š', eacute: 'é', egrave: 'è', aacute: 'á',
  agrave: 'à', ouml: 'ö', uuml: 'ü', auml: 'ä', Ouml: 'Ö', Uuml: 'Ü', Auml: 'Ä', szlig: 'ß',
  ccedil: 'ç', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', zwnj: '', zwj: '', shy: '',
};

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (whole, ent) => {
    if (ent[0] === '#') {
      const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
      return cp === 160 ? ' ' : String.fromCodePoint(cp);
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, ent) ? ENTITIES[ent] : whole;
  });
}

function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(head|style|script|title|xml)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<br\b[^>]*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote|pre|section|article|header|footer)\s*>/gi, '\n');
  s = s.replace(/<(p|h[1-6]|table|ul|ol|blockquote)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/t[dh]\s*>/gi, ' ');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, '\n').replace(/[ \t ]+/g, ' ');
  s = s.split('\n').map((l) => l.trim()).join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// §4 exports
module.exports = { normCharset, decodeCharset, decodeBase64, decodeQP, decodeTransfer, decodeEntities, htmlToText };
