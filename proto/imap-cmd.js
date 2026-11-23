/* MAP
 * §1 imports      L11-L12
 * §2 arguments    L14-L37
 * §3 sets         L39-L59
 * §4 search       L61-L102
 * §5 special-use  L104-L130
 * §6 exports      L132-L133
 */
'use strict';

// §1 imports
const utf7 = require('./utf7');

// §2 arguments
// String IMAP: citat daca e ASCII fara CR/LF, altfel literal (Buffer UTF-8).
function astring(s) {
  const v = String(s == null ? '' : s);
  if (/^[\x01-\x09\x0b\x0c\x0e-\x7f]*$/.test(v)) return '"' + v.replace(/(["\\])/g, '\\$1') + '"';
  return { literal: Buffer.from(v, 'utf8') };
}

function isAscii(s) {
  return /^[\x00-\x7f]*$/.test(String(s));
}

// Numele de folder: UTF-8 → modified UTF-7, mereu citat.
function mailbox(path) {
  const v = String(path);
  const enc = /^inbox$/i.test(v) ? 'INBOX' : utf7.encode(v);
  return '"' + enc.replace(/(["\\])/g, '\\$1') + '"';
}

function flagList(flags) {
  const list = (Array.isArray(flags) ? flags : flags ? [flags] : []).map(String);
  for (const f of list) if (!/^\\?[A-Za-z0-9$_.\-]+$/.test(f)) throw Object.assign(new Error(`Flag invalid: ${f}`), { code: 'BAD' });
  return '(' + list.join(' ') + ')';
}

// §3 sets
// [1,3,5,6,7,8,9] → "1,3,5:9"
function compactSet(uids) {
  const list = [...new Set((uids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    out.push(i === j ? String(list[i]) : `${list[i]}:${list[j]}`);
    i = j;
  }
  return out.join(',');
}

// Loturi de UID-uri ca linia de comanda sa ramana scurta (unele servere taie la ~8 KB).
function chunkUids(uids, size) {
  const list = [...new Set((uids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// §4 search
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function imapDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dt.getTime())) throw Object.assign(new Error('Data invalida in cautare'), { code: 'BAD' });
  return `${dt.getDate()}-${MON[dt.getMonth()]}-${dt.getFullYear()}`;
}

// Obiect de cautare → { pieces, utf8 }; termenii sunt combinati AND (implicit in IMAP).
function buildSearch(q) {
  if (q == null || q === '') return { pieces: ['ALL'], utf8: false };
  if (typeof q === 'string') return { pieces: [q], utf8: false };
  const pieces = [];
  let utf8 = false;
  const push = (key, value) => {
    const v = String(value);
    if (!isAscii(v)) utf8 = true;
    pieces.push(key + ' ', astring(v), ' ');
  };
  if (q.text) {
    pieces.push('OR OR ');
    push('SUBJECT', q.text);
    push('FROM', q.text);
    push('TO', q.text);
  }
  if (q.subject) push('SUBJECT', q.subject);
  if (q.from) push('FROM', q.from);
  if (q.to) push('TO', q.to);
  if (q.body) push('BODY', q.body);
  if (q.unseen === true) pieces.push('UNSEEN ');
  if (q.unseen === false) pieces.push('SEEN ');
  if (q.flagged === true) pieces.push('FLAGGED ');
  if (q.flagged === false) pieces.push('UNFLAGGED ');
  if (q.since) pieces.push(`SINCE ${imapDate(q.since)} `);
  if (q.before) pieces.push(`BEFORE ${imapDate(q.before)} `);
  if (q.uid) pieces.push(`UID ${String(q.uid).replace(/[^0-9:*,]/g, '')} `);
  if (!pieces.length) pieces.push('ALL');
  const last = pieces[pieces.length - 1];
  if (typeof last === 'string') pieces[pieces.length - 1] = last.replace(/ $/, '');
  return { pieces, utf8 };
}

// §5 special-use
const SPECIAL = ['\\Sent', '\\Drafts', '\\Trash', '\\Junk', '\\Archive'];
const GUESS = [
  ['\\Sent', ['sent', 'sent items', 'sent messages', 'sent mail', 'trimise', 'mesaje trimise', 'elemente trimise']],
  ['\\Drafts', ['drafts', 'draft', 'ciorne', 'schite']],
  ['\\Trash', ['trash', 'deleted items', 'deleted messages', 'deleted', 'cos', 'cos de gunoi', 'gunoi', 'elemente sterse', 'bin']],
  ['\\Junk', ['junk', 'spam', 'junk e-mail', 'junk email', 'bulk mail', 'nedorite', 'mesaje nedorite']],
  ['\\Archive', ['archive', 'archives', 'arhiva']],
];

function fold(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function specialFromFlags(flags) {
  for (const f of flags) {
    const hit = SPECIAL.find((s) => s.toLowerCase() === String(f).toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function guessSpecial(name) {
  const n = fold(name);
  for (const [use, names] of GUESS) if (names.includes(n)) return use;
  return null;
}

// §6 exports
module.exports = { astring, isAscii, mailbox, flagList, compactSet, chunkUids, buildSearch, imapDate, specialFromFlags, guessSpecial };
