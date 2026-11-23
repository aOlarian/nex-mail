/* MAP
 * §1 constructor DOM  L9-L47
 * §2 date  L48-L100
 * §3 adrese si persoane  L101-L133
 * §4 diverse  L134-L201
 */
// Utilitare comune: constructor DOM sigur (fara innerHTML), date, adrese, culori.

// §1 constructor DOM
// h('div', { class, text, on: { click }, ... }, ...copii) — textul intra mereu prin text node
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'style' && typeof v === 'object') {
        // variabilele CSS (--x) merg doar prin setProperty
        for (const [p, val] of Object.entries(v)) if (p.startsWith('--')) el.style.setProperty(p, val); else el.style[p] = val;
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// §2 date
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export { MONTHS, DAYS, DAYS_SHORT };

const pad = n => String(n).padStart(2, '0');
export const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();
// week starts Monday
export const startOfWeek = d => { const x = startOfDay(d); return addDays(x, -((x.getDay() + 6) % 7)); };
export const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export function parseIsoDate(s) { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); }
export const capital = s => s.charAt(0).toUpperCase() + s.slice(1);

// short list date: today = HH:MM, this week = Day HH:MM, same year = Mon DD, else MM/DD/YYYY
export function fmtShort(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  if (sameDay(d, now)) return hhmm(d);
  if (d >= startOfWeek(now) && d < now) return `${DAYS_SHORT[d.getDay()]} ${hhmm(d)}`;
  if (d.getFullYear() === now.getFullYear()) return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
}

export function fmtFull(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${hhmm(d)}`;
}

export function fmtDay(d) { return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`; }

export function groupLabel(iso) {
  const d = new Date(iso), now = new Date();
  if (sameDay(d, now)) return 'Today';
  if (sameDay(d, addDays(now, -1))) return 'Yesterday';
  if (d >= startOfWeek(now)) return 'This week';
  return 'Older';
}

export function fmtDue(due) {
  if (!due) return 'No due date';
  const d = parseIsoDate(due), now = startOfDay(new Date());
  if (sameDay(d, now)) return 'Today';
  if (sameDay(d, addDays(now, 1))) return 'Tomorrow';
  if (sameDay(d, addDays(now, -1))) return 'Yesterday';
  return `${DAYS_SHORT[d.getDay()]} ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

// §3 adrese si persoane
export function displayName(a) { return a ? (a.name || a.address || '') : ''; }
export function fmtAddr(a) { return a ? (a.name ? `${a.name} <${a.address}>` : a.address) : ''; }

export function initials(a) {
  const s = (a && (a.name || a.address)) || '?';
  const parts = s.replace(/[<>"@._-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

const AVATAR_COLORS = ['#0f6cbd', '#c239b3', '#038387', '#8764b8', '#ca5010', '#498205', '#d13438', '#005b70', '#986f0b', '#4f6bed', '#a4262c', '#00666d'];
export function colorFor(str) {
  let x = 0;
  for (const c of String(str || '')) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[x % AVATAR_COLORS.length];
}

// „Nume <a@b>, c@d" → [{name,address}]
export function parseAddrList(s) {
  const out = [];
  for (const raw of String(s || '').split(/[,;\n]+/)) {
    const t = raw.trim();
    if (!t) continue;
    const m = t.match(/^(.*?)<([^>]+)>$/);
    if (m) out.push({ name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim() });
    else out.push({ name: '', address: t });
  }
  return out;
}

export const validEmail = s => /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(String(s || ''));

// §4 diverse
export function fmtSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// prefixe de raspuns fara dublare (Re:, RE:, Fw:, Fwd:, RE[2]: ...)
export function stripSubjectPrefixes(subject) {
  return String(subject || '').replace(/^\s*((re|fw|fwd|răsp|tr)(\[\d+\])?\s*:\s*)+/i, '').trim();
}

export function prefixSubject(prefix, subject) {
  return `${prefix} ${stripSubjectPrefixes(subject)}`.trim();
}

const DATE_GROUP_ORDER = { Today: 0, Yesterday: 1, 'This week': 2, Earlier: 3 };

function groupInfoFor(it, mode) {
  if (mode === 'sender') {
    const addr = String(it.from?.address || '').trim().toLowerCase();
    const name = String(it.from?.name || '').trim();
    const key = addr || name.toLowerCase() || '(no sender)';
    const label = addr ? (name && name.toLowerCase() !== addr ? `${name} <${addr}>` : addr) : (name || '(No sender)');
    return { key, label };
  }
  if (mode === 'subject') {
    const clean = stripSubjectPrefixes(it.subject);
    const label = clean || '(No subject)';
    return { key: label.toLowerCase(), label };
  }
  const label = groupLabel(it.date);
  return { key: label, label };
}

export function groupMessages(items, mode, sortDir = 'desc', byCount = false) {
  if (!mode || mode === 'none') return [['', items]];
  const map = new Map();
  for (const it of items) {
    const { key, label } = groupInfoFor(it, mode);
    let bucket = map.get(key);
    if (!bucket) { bucket = { label, items: [] }; map.set(key, bucket); }
    bucket.items.push(it);
  }
  const entries = [...map.values()].map(b => [b.label, b.items]);
  if (mode === 'date') {
    const mul = sortDir === 'asc' ? -1 : 1;
    entries.sort((a, b) => mul * ((DATE_GROUP_ORDER[a[0]] ?? 9) - (DATE_GROUP_ORDER[b[0]] ?? 9)));
  } else if (byCount) {
    entries.sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]));
  }
  return entries;
}

export function fileKind(name, type) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (/^image\//.test(type) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'fileImg';
  if (type === 'application/pdf' || ext === 'pdf') return 'filePdf';
  if (['zip', 'rar', '7z', 'gz'].includes(ext)) return 'fileZip';
  if (['ics'].includes(ext) || type === 'text/calendar') return 'calendar';
  return 'file';
}
