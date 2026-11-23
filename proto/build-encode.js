/* MAP
 * §1 header words    L11-L36
 * §2 addresses       L38-L52
 * §3 params          L54-L72
 * §4 body encodings  L74-L102
 * §5 date            L104-L117
 * §6 exports         L119-L120
 */
'use strict';

// §1 header words
// CR/LF din valori ar permite injectie de antete; le inlocuim cu spatiu.
function clean(s) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim();
}

function isAsciiPrintable(s) {
  return /^[\x20-\x7e]*$/.test(s);
}

// RFC 2047 B: cuvinte de max 75 caractere, taiate pe granita de caracter.
function encodeWords(s) {
  const v = clean(s);
  if (isAsciiPrintable(v)) return v;
  const words = [];
  let cur = [];
  let len = 0;
  for (const ch of v) {
    const b = Buffer.from(ch, 'utf8');
    if (len + b.length > 39) { words.push(Buffer.concat(cur)); cur = []; len = 0; }
    cur.push(b);
    len += b.length;
  }
  if (cur.length) words.push(Buffer.concat(cur));
  return words.map((w) => `=?UTF-8?B?${w.toString('base64')}?=`).join('\r\n ');
}

// §2 addresses
function formatAddress(a) {
  if (!a) return '';
  const addr = typeof a === 'string' ? a : a.address;
  const address = clean(addr).replace(/[<>\s,;"]/g, '');
  const name = typeof a === 'string' ? '' : clean(a.name);
  if (!name) return address;
  if (!isAsciiPrintable(name)) return `${encodeWords(name)} <${address}>`;
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(name)) return `${name} <${address}>`;
  return `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>`;
}

function formatAddressList(list) {
  return (list || []).filter((a) => a && (typeof a === 'string' ? a : a.address)).map(formatAddress).join(',\r\n ');
}

// §3 params
// Valoare de parametru: citata daca e ASCII; altfel RFC 2231 (cu continuari la nume lungi).
function param(key, value) {
  const v = clean(value);
  if (isAsciiPrintable(v)) return `;\r\n ${key}="${v.replace(/(["\\])/g, '\\$1')}"`;
  const enc = encodeURIComponent(v).replace(/['()*!]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  if (enc.length <= 50) return `;\r\n ${key}*=UTF-8''${enc}`;
  const chunks = [];
  let i = 0;
  while (i < enc.length) {
    let end = Math.min(i + 50, enc.length);
    // nu taiem o secventa %XX
    if (enc[end - 1] === '%') end -= 1;
    else if (enc[end - 2] === '%') end -= 2;
    chunks.push(enc.slice(i, end));
    i = end;
  }
  return chunks.map((c, n) => `;\r\n ${key}*${n}*=${n === 0 ? "UTF-8''" : ''}${c}`).join('');
}

// §4 body encodings
function base64Lines(buf) {
  const s = buf.toString('base64');
  const out = [];
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
  return out.join('\r\n');
}

// Quoted-printable UTF-8: linii <= 76 cu soft break "=", spatiu final codat, CRLF.
function encodeQP(text) {
  const lines = String(text == null ? '' : text).split(/\r\n|\r|\n/);
  const out = [];
  for (const line of lines) {
    const bytes = Buffer.from(line, 'utf8');
    let cur = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      let tok;
      if ((b === 0x20 || b === 0x09) && !last) tok = String.fromCharCode(b);
      else if (b >= 33 && b <= 126 && b !== 0x3d && !(b === 0x2e && cur === '')) tok = String.fromCharCode(b);
      else tok = '=' + b.toString(16).toUpperCase().padStart(2, '0');
      if (cur.length + tok.length > 75) { out.push(cur + '='); cur = ''; }
      cur += tok;
    }
    out.push(cur);
  }
  return out.join('\r\n');
}

// §5 date
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function rfc5322Date(input) {
  const d = input ? new Date(input) : new Date();
  const dt = Number.isFinite(d.getTime()) ? d : new Date();
  const p = (n) => String(n).padStart(2, '0');
  const off = -dt.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${DAYS[dt.getDay()]}, ${dt.getDate()} ${MONS[dt.getMonth()]} ${dt.getFullYear()} `
    + `${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())} ${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}

// §6 exports
module.exports = { clean, encodeWords, formatAddress, formatAddressList, param, base64Lines, encodeQP, rfc5322Date };
