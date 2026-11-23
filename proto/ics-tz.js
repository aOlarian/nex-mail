/* MAP
 * §1 windows zones  L9-L37
 * §2 resolve zone   L39-L66
 * §3 offsets        L68-L98
 * §4 exports        L100-L101
 */
'use strict';

// §1 windows zones
// Zonele Windows trimise de Outlook/Exchange → IANA (subset uzual pentru clientii nostri).
const WINDOWS = {
  'gtb standard time': 'Europe/Bucharest',
  'e. europe standard time': 'Europe/Bucharest',
  'fle standard time': 'Europe/Kiev',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'utc': 'UTC',
  'coordinated universal time': 'UTC',
  'russian standard time': 'Europe/Moscow',
  'turkey standard time': 'Europe/Istanbul',
  'israel standard time': 'Asia/Jerusalem',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
  'arabian standard time': 'Asia/Dubai',
  'india standard time': 'Asia/Kolkata',
  'china standard time': 'Asia/Shanghai',
  'tokyo standard time': 'Asia/Tokyo',
  'aus eastern standard time': 'Australia/Sydney',
};

const DEFAULT_ZONE = 'Europe/Bucharest';

// §2 resolve zone
const valid = new Map();

function isZone(tz) {
  if (valid.has(tz)) return valid.get(tz);
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    ok = true;
  } catch (e) {
    // RangeError: zona nu exista in ICU; o marcam invalida
    ok = false;
  }
  valid.set(tz, ok);
  return ok;
}

// TZID poate fi IANA, nume Windows, "/mozilla.org/.../Europe/Bucharest" sau ghilimele.
function resolveZone(tzid) {
  if (!tzid) return DEFAULT_ZONE;
  const t = String(tzid).replace(/^"|"$/g, '').trim();
  const win = WINDOWS[t.toLowerCase()];
  if (win) return win;
  if (isZone(t)) return t;
  const m = /([A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)$/.exec(t);
  if (m && isZone(m[1])) return m[1];
  return DEFAULT_ZONE;
}

// §3 offsets
const formatters = new Map();

function formatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(tz);
}

// Offsetul zonei (ms) la momentul UTC dat.
function offsetAt(ts, tz) {
  const parts = {};
  for (const p of formatter(tz).formatToParts(new Date(ts))) parts[p.type] = p.value;
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(ts / 1000) * 1000;
}

// Ora locala din zona → moment UTC; a doua iteratie corecteaza trecerile DST.
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = offsetAt(guess, tz);
  let t = guess - off1;
  const off2 = offsetAt(t, tz);
  if (off2 !== off1) t = guess - off2;
  return t;
}

// §4 exports
module.exports = { resolveZone, zonedToUtc, offsetAt, DEFAULT_ZONE };
