/* MAP
 * §1 imports   L12-L13
 * §2 lines     L15-L46
 * §3 values    L48-L61
 * §4 dates     L63-L92
 * §5 events    L94-L126
 * §6 parseIcs  L128-L151
 * §7 exports   L153-L154
 */
'use strict';

// §1 imports
const { resolveZone, zonedToUtc } = require('./ics-tz');

// §2 lines
// Despaturire (CRLF + spatiu/tab) si impartire NAME;PARAM=..:valoare cu ghilimele in parametri.
function unfold(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter((l) => l.trim());
}

function parseLine(line) {
  let i = 0, q = false;
  for (; i < line.length; i++) {
    if (line[i] === '"') q = !q;
    else if (line[i] === ':' && !q) break;
  }
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const segs = [];
  let cur = '';
  q = false;
  for (const ch of head) {
    if (ch === '"') q = !q;
    if (ch === ';' && !q) { segs.push(cur); cur = ''; continue; }
    cur += ch;
  }
  segs.push(cur);
  const name = segs.shift().toUpperCase();
  const params = {};
  for (const s of segs) {
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    params[s.slice(0, eq).toUpperCase()] = s.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

// §3 values
function unescapeText(v) {
  return String(v || '').replace(/\\([nN,;\\])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

function person(prop) {
  if (!prop) return null;
  const address = String(prop.value || '').replace(/^mailto:/i, '').trim();
  const out = { name: prop.params.CN ? unescapeText(prop.params.CN) : '', address };
  if (prop.params.PARTSTAT) out.partstat = prop.params.PARTSTAT.toUpperCase();
  if (prop.params.ROLE) out.role = prop.params.ROLE.toUpperCase();
  if (prop.params.RSVP) out.rsvp = /^true$/i.test(prop.params.RSVP);
  return out;
}

// §4 dates
// → { iso, allDay, ms } ; data simpla = 'YYYY-MM-DD' (zi intreaga, fara fus).
function parseDateProp(prop) {
  if (!prop) return null;
  const v = String(prop.value || '').trim();
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (d || (prop.params.VALUE || '').toUpperCase() === 'DATE') {
    const m = d || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { allDay: true, iso: `${m[1]}-${m[2]}-${m[3]}`, ms: Date.UTC(+m[1], +m[2] - 1, +m[3]) };
  }
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/i.exec(v);
  if (!t) return null;
  const [y, mo, da, h, mi, s] = [+t[1], +t[2], +t[3], +t[4], +t[5], +(t[6] || 0)];
  // ora fara Z si fara TZID = ora flotanta; o interpretam in Europe/Bucharest
  const ms = t[7] ? Date.UTC(y, mo - 1, da, h, mi, s) : zonedToUtc(y, mo, da, h, mi, s, resolveZone(prop.params.TZID));
  return { allDay: false, iso: new Date(ms).toISOString(), ms };
}

// "P1DT2H30M", "-PT15M", "P2W" → milisecunde (null daca invalid).
function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(v || '').trim());
  if (!m) return null;
  const ms = ((+(m[2] || 0) * 7 + +(m[3] || 0)) * 86400 + +(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

function dayIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// §5 events
function buildEvent(props) {
  const one = (n) => (props[n] ? props[n][0] : null);
  const text = (n) => (one(n) ? unescapeText(one(n).value) : '');
  const start = parseDateProp(one('DTSTART'));
  let end = parseDateProp(one('DTEND')) || parseDateProp(one('DUE'));
  if (!end && start) {
    const dur = one('DURATION') ? parseDuration(one('DURATION').value) : null;
    if (start.allDay) {
      const ms = start.ms + (dur != null ? dur : 86400000);
      end = { allDay: true, iso: dayIso(ms), ms };
    } else {
      const ms = start.ms + (dur || 0);
      end = { allDay: false, iso: new Date(ms).toISOString(), ms };
    }
  }
  const seq = one('SEQUENCE') ? parseInt(one('SEQUENCE').value, 10) : 0;
  return {
    uid: one('UID') ? one('UID').value.trim() : null,
    summary: text('SUMMARY'),
    description: text('DESCRIPTION'),
    location: text('LOCATION'),
    start: start ? start.iso : null,
    end: end ? end.iso : null,
    allDay: !!(start && start.allDay),
    organizer: person(one('ORGANIZER')),
    attendees: (props.ATTENDEE || []).map(person),
    status: one('STATUS') ? one('STATUS').value.trim().toLowerCase() : null,
    sequence: Number.isFinite(seq) ? seq : 0,
    rrule: one('RRULE') ? one('RRULE').value.trim() : null,
    recurrenceId: one('RECURRENCE-ID') ? (parseDateProp(one('RECURRENCE-ID')) || {}).iso || null : null,
  };
}

// §6 parseIcs
function parseIcs(text) {
  const out = { method: null, events: [] };
  const stack = [];
  let props = null;
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (p.name === 'BEGIN') {
      stack.push(p.value.trim().toUpperCase());
      if (stack[stack.length - 1] === 'VEVENT' && !props) props = {};
      continue;
    }
    if (p.name === 'END') {
      const comp = stack.pop();
      if (comp === 'VEVENT' && props) { out.events.push(buildEvent(props)); props = null; }
      continue;
    }
    const top = stack[stack.length - 1];
    if (top === 'VCALENDAR' && p.name === 'METHOD') out.method = p.value.trim().toUpperCase();
    // doar proprietatile directe ale VEVENT (nu si ale VALARM din interior)
    if (top === 'VEVENT' && props) (props[p.name] = props[p.name] || []).push(p);
  }
  return out;
}

// §7 exports
module.exports = { parseIcs, parseDuration };
