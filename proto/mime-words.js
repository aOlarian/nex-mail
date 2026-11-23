/* MAP
 * §1 imports           L10-L11
 * §2 encoded-words     L13-L57
 * §3 headers & params  L59-L189
 * §4 dates & ids       L191-L215
 * §5 exports           L217-L218
 */
'use strict';

// §1 imports
const { decodeCharset, decodeBase64 } = require('./mime-decode');

// §2 encoded-words
const EW_RE = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;

function wordBytes(enc, data) {
  if (enc === 'B' || enc === 'b') return decodeBase64(data);
  const bytes = [];
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '_') bytes.push(0x20);
    else if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(data.substr(i + 1, 2))) { bytes.push(parseInt(data.substr(i + 1, 2), 16)); i += 2; }
    else bytes.push(data.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

// Cuvintele adiacente (separate doar de spatii) se lipesc; cele cu acelasi charset se unesc
// la nivel de octeti, ca un caracter UTF-8 rupt intre doua cuvinte sa iasa intreg.
function decodeWords(input) {
  if (input == null) return '';
  const s = String(input);
  if (s.indexOf('=?') < 0) return s;
  const segs = [];
  let last = 0;
  let m;
  EW_RE.lastIndex = 0;
  while ((m = EW_RE.exec(s))) {
    if (m.index > last) segs.push({ text: s.slice(last, m.index) });
    segs.push({ charset: m[1].replace(/\*.*$/, '').toLowerCase(), bytes: wordBytes(m[2], m[3]) });
    last = EW_RE.lastIndex;
  }
  if (last < s.length) segs.push({ text: s.slice(last) });
  const merged = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.text !== undefined) {
      const between = i > 0 && i < segs.length - 1 && segs[i - 1].bytes && segs[i + 1].bytes;
      if (!(between && /^\s*$/.test(seg.text))) merged.push(seg);
      continue;
    }
    const prev = merged[merged.length - 1];
    if (prev && prev.bytes && prev.charset === seg.charset) prev.bytes = Buffer.concat([prev.bytes, seg.bytes]);
    else merged.push({ charset: seg.charset, bytes: seg.bytes });
  }
  return merged.map((g) => (g.bytes ? decodeCharset(g.bytes, g.charset) : g.text)).join('');
}

// §3 headers & params
// Bloc de antete (Buffer) → Map lowercase → [valori despaturite, nedecodate].
function parseHeaders(buf) {
  const text = Buffer.isBuffer(buf) ? decodeCharset(buf, 'utf-8') : String(buf || '');
  const map = new Map();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let cur = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && cur) { cur.value += line; continue; }
    const idx = line.indexOf(':');
    if (idx <= 0) { cur = null; continue; }
    cur = { name: line.slice(0, idx).trim().toLowerCase(), value: line.slice(idx + 1) };
    if (!map.has(cur.name)) map.set(cur.name, []);
    map.get(cur.name).push(cur);
  }
  for (const [k, arr] of map) map.set(k, arr.map((h) => h.value.trim()));
  return map;
}

// Imparte pe separator in afara ghilimelelor.
function splitOutsideQuotes(s, sep) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && q && i + 1 < s.length) { cur += ch + s[++i]; continue; }
    if (ch === '"') q = !q;
    if (ch === sep && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function unquote(v) {
  v = String(v).trim();
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') return v.slice(1, -1).replace(/\\(.)/g, '$1');
  return v;
}

function percentBytes(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { bytes.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else for (const b of Buffer.from(s[i], 'utf8')) bytes.push(b);
  }
  return Buffer.from(bytes);
}

// "text/plain; charset=utf-8; name*0*=utf-8''%C8%98..." → { value, params } cu RFC 2231 si RFC 2047.
function parseParams(header) {
  const parts = splitOutsideQuotes(String(header || ''), ';');
  const value = parts.shift().trim().toLowerCase();
  const plain = {};
  const cont = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    const raw = p.slice(eq + 1).trim();
    const m = /^(.+?)\*(?:(\d+)(\*)?|)$/.exec(key);
    const star = /\*$/.test(key);
    if (!m) { plain[key] = unquote(raw); continue; }
    const name = m[1];
    const idx = m[2] !== undefined ? Number(m[2]) : 0;
    if (!cont[name]) cont[name] = [];
    cont[name].push({ idx, encoded: star, value: unquote(raw) });
  }
  for (const name of Object.keys(cont)) {
    const segs = cont[name].sort((a, b) => a.idx - b.idx);
    let charset = 'utf-8';
    const bufs = [];
    segs.forEach((seg, i) => {
      let v = seg.value;
      if (seg.encoded) {
        if (i === 0) {
          const q = /^([^']*)'[^']*'(.*)$/.exec(v);
          if (q) { charset = q[1] || 'utf-8'; v = q[2]; }
        }
        bufs.push(percentBytes(v));
      } else {
        bufs.push(Buffer.from(v, 'utf8'));
      }
    });
    plain[name] = decodeCharset(Buffer.concat(bufs), charset);
  }
  for (const k of Object.keys(plain)) plain[k] = decodeWords(plain[k]);
  return { value, params: plain };
}

// Adrese: "Nume, X" <a@b>, c@d (comentariu), grup: a@b, e@f; → [{name,address}].
function parseAddresses(input) {
  const s = String(input || '');
  const pieces = [];
  let cur = '';
  let q = false, angle = 0, comment = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && (q || comment) && i + 1 < s.length) { cur += ch + s[++i]; continue; }
    if (!comment && ch === '"') q = !q;
    else if (!q && ch === '(') comment++;
    else if (!q && ch === ')' && comment) comment--;
    else if (!q && !comment && ch === '<') angle++;
    else if (!q && !comment && ch === '>' && angle) angle--;
    else if (!q && !comment && !angle && (ch === ',' || ch === ';')) { pieces.push(cur); cur = ''; continue; }
    else if (!q && !comment && !angle && ch === ':' ) { cur = ''; continue; } // numele grupului
    cur += ch;
  }
  pieces.push(cur);
  const out = [];
  for (const piece of pieces) {
    const p = piece.trim();
    if (!p) continue;
    const a = /<([^<>]*)>\s*$/.exec(p) || /<([^<>]*)>/.exec(p);
    let name, address;
    if (a) {
      address = a[1].trim();
      name = (p.slice(0, a.index) + p.slice(a.index + a[0].length)).replace(/\((.*?)\)/g, '').trim();
      if (!name) { const c = /\((.*?)\)/.exec(p); name = c ? c[1] : ''; }
    } else {
      const c = /\((.*?)\)/.exec(p);
      address = p.replace(/\(.*?\)/g, '').trim();
      name = c ? c[1].trim() : '';
    }
    address = unquote(address).replace(/^mailto:/i, '').replace(/\s+/g, '');
    if (!address) continue;
    out.push({ name: decodeWords(unquote(name)).trim(), address });
  }
  return out;
}

// §4 dates & ids
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const ZONES = { UT: 0, UTC: 0, GMT: 0, Z: 0, EST: -500, EDT: -400, CST: -600, CDT: -500, MST: -700, MDT: -600, PST: -800, PDT: -700 };

// RFC 5322 / IMAP INTERNALDATE ("12-Nov-2026 10:00:00 +0200") → ISO sau null.
function parseDate(input) {
  if (!input) return null;
  const s = String(input).replace(/\([^)]*\)/g, ' ').trim();
  const m = /(\d{1,2})[\s-]+([A-Za-z]{3})[a-z]*[\s-]+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,5})?/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
    let year = Number(m[3]);
    if (year < 100) year += year < 50 ? 2000 : 1900;
    let off = 0;
    if (m[7]) off = /^[+-]/.test(m[7]) ? Number(m[7]) : (ZONES[m[7].toUpperCase()] || 0);
    const offMin = Math.sign(off) * (Math.floor(Math.abs(off) / 100) * 60 + (Math.abs(off) % 100));
    const t = Date.UTC(year, MONTHS[m[2].toLowerCase()], Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] || 0)) - offMin * 60000;
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function msgIds(input) {
  return String(input || '').match(/<[^<>\s]+>/g) || [];
}

// §5 exports
module.exports = { decodeWords, parseHeaders, parseParams, parseAddresses, parseDate, msgIds, unquote, splitOutsideQuotes };
