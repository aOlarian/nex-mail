/* MAP
 * §1 event details                        L15-L82
 * §2 event form (new or edit)             L83-L122
 * §3 left side panel: mini-cal & upcoming L123-L163
 */
// Event dialogs (details, edit, delete) and Calendar left panel (mini-calendar, upcoming events).
import { h, clear, isoDate, hhmm, addDays, startOfDay, startOfWeek, sameDay, fmtDay, MONTHS, DAYS_SHORT, capital, parseIsoDate } from './mail-util.js';
import { icon } from './mail-icons.js';
import { S, emit } from './mail-state.js';
import { api } from './mail-api.js';
import { openDialog, confirmDialog, toast, field } from './mail-ui.js';
import { PALETTE } from './mail-editor.js';
import { cal, goTo, loadCalendar } from './mail-calendar.js';

// §1 event details
const STATUS = { confirmed: 'Confirmed', tentative: 'Tentative', detected: 'Detected in email', invited: 'Invite' };

function when(e) {
  const s = new Date(e.start), en = new Date(e.end || e.start);
  if (e.allDay) return sameDay(s, addDays(en, -1)) || sameDay(s, en) ? `${fmtDay(s)}, all day` : `${fmtDay(s)} - ${fmtDay(addDays(en, -1))}`;
  return `${fmtDay(s)}, ${hhmm(s)}-${hhmm(en)}`;
}

export function showEvent(e) {
  const pending = e.status === 'detected' || e.status === 'invited';
  const sendChk = h('input', { type: 'checkbox', checked: true });
  const toInp = h('input', { class: 'inp', placeholder: 'Confirmation recipient email (optional)' });
  const noteInp = h('input', { class: 'inp', placeholder: 'Confirmation note (optional)' });
  const replyWrap = h('div', { class: 'ev-reply' },
    h('label', { class: 'check' }, sendChk, h('span', { text: 'Send confirmation email on approve' })),
    toInp,
    noteInp);
  if (pending && e.source && e.id) {
    api.calendarReplyTarget(e.id).then(r => { if (r && r.to && !toInp.value) toInp.value = r.to; }).catch(() => {});
  }
  sendChk.addEventListener('change', () => { toInp.disabled = !sendChk.checked; noteInp.disabled = !sendChk.checked; });
  const body = h('div', { class: 'ev-detail' },
    h('div', { class: 'ev-line' }, h('span', { class: 'dot lg', style: { background: pending ? 'var(--danger)' : (e.color || '#0f6cbd') } }), h('strong', { class: 'ev-dtitle', text: e.title || '(untitled)' })),
    h('div', { class: 'ev-line' }, icon('clock', 16), h('span', { text: when(e) })),
    e.location ? h('div', { class: 'ev-line' }, icon('location', 16), h('span', { text: e.location })) : null,
    h('div', { class: 'ev-line' }, icon('tag', 16), h('span', { class: `chip ev-st ev-${e.status || 'confirmed'}`, text: STATUS[e.status] || 'Confirmed' })),
    e.source ? h('div', { class: 'ev-line' }, icon('mail', 16), h('span', { text: `From email: ${e.source.subject || ''}` })) : null,
    e.notes ? h('p', { class: 'ev-notes', text: e.notes }) : null,
    pending ? replyWrap : null);
  const buttons = [];
  if (pending) {
    buttons.push({ label: 'Approve', kind: 'primary', onClick: async d => {
      try {
        const res = await api.calendarRespond({ id: e.id, decision: 'approve', sendConfirmation: sendChk.checked, to: toInp.value.trim(), note: noteInp.value.trim() });
        d.close(true);
        toast(res && res.confirmationSent ? `Approved & confirmation sent to ${res.to}` : 'Appointment approved', { kind: 'ok' });
        afterChange();
      } catch (err) { toast(err.message, { kind: 'err' }); }
    } });
    buttons.push({ label: 'Reject', kind: 'danger', onClick: async d => {
      try { await api.calendarRespond({ id: e.id, decision: 'reject' }); d.close(true); toast('Appointment rejected', { kind: 'ok' }); afterChange(); }
      catch (err) { toast(err.message, { kind: 'err' }); }
    } });
  } else if (e.status === 'tentative') {
    buttons.push({ label: 'Confirm', onClick: d => save({ ...strip(e), status: 'confirmed' }, d) });
  }
  if (e.source) buttons.push({ label: 'Open email', onClick: d => { d.close(); emit('openSource', e.source); } });
  buttons.push({ label: 'Edit', onClick: d => { d.close(); editEvent(e); } });
  if (!pending) {
    buttons.push({ label: 'Delete', kind: 'danger', onClick: async d => {
      if (!(await confirmDialog(`Delete "${e.title}" from calendar?`, { ok: 'Delete', danger: true }))) return;
      try { await api.deleteEvent(e.id); d.close(); toast('Event deleted', { kind: 'ok' }); afterChange(); }
      catch (err) { toast(err.message, { kind: 'err' }); }
    } });
  }
  openDialog({ title: pending ? 'Pending Appointment' : 'Event', body, cls: 'small', buttons });
}

const strip = e => { const o = { ...e }; for (const k of Object.keys(o)) if (k.startsWith('_')) delete o[k]; return o; };

async function save(ev, d) {
  try { await api.saveEvent(ev); d.close(true); toast('Event saved', { kind: 'ok' }); afterChange(); }
  catch (err) { toast(err.message, { kind: 'err' }); }
}

function afterChange() { emit('calendarChanged'); if (S.view === 'calendar') loadCalendar(); renderSide(); }

// §2 event form (new or edit)
export function editEvent(e = {}) {
  const s = e.start ? new Date(e.start) : new Date();
  const en = e.end ? new Date(e.end) : new Date(s.getTime() + 3600000);
  const title = h('input', { class: 'inp', value: e.title || '', placeholder: 'Add a title', autofocus: true });
  const allDay = h('input', { type: 'checkbox', checked: !!e.allDay });
  const date = h('input', { class: 'inp', type: 'date', value: isoDate(s) });
  const t1 = h('input', { class: 'inp', type: 'time', value: hhmm(s), step: 900 });
  const t2 = h('input', { class: 'inp', type: 'time', value: hhmm(en), step: 900 });
  const loc = h('input', { class: 'inp', value: e.location || '', placeholder: 'e.g., Office, Zoom, address' });
  const notes = h('textarea', { class: 'inp', rows: 4, text: e.notes || '' });
  let color = e.color || PALETTE[8];
  const sw = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Color' });
  const paint = () => { clear(sw); PALETTE.slice(0, 12).filter(c => c !== '#ffffff').forEach(c => sw.append(h('button', { type: 'button', class: 'swatch' + (c === color ? ' on' : ''), role: 'radio', 'aria-checked': String(c === color), 'aria-label': c, style: { background: c }, on: { click: () => { color = c; paint(); } } }))); };
  paint();
  const times = h('div', { class: 'row2', hidden: allDay.checked }, field('Start time', t1), field('End time', t2));
  allDay.addEventListener('change', () => { times.hidden = allDay.checked; });
  t1.addEventListener('change', () => { if (t2.value <= t1.value) { const [hh, mm] = t1.value.split(':').map(Number); t2.value = `${String(Math.min(23, hh + 1)).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; } });
  const body = h('div', { class: 'form' }, field('Title', title),
    h('div', { class: 'row2' }, field('Date', date), h('label', { class: 'check' }, allDay, h('span', { text: 'All day' }))),
    times, field('Location', loc), field('Notes', notes), h('div', { class: 'field' }, h('span', { text: 'Color' }), sw));
  openDialog({ title: e.id ? 'Edit Event' : 'New Event', body, buttons: [
    { label: 'Save', kind: 'primary', onClick: d => {
      if (!title.value.trim()) { toast('Add a title.', { kind: 'err' }); title.focus(); return; }
      if (!date.value) { toast('Choose a date.', { kind: 'err' }); return; }
      const day = parseIsoDate(date.value);
      let start, end;
      if (allDay.checked) { start = day; end = addDays(day, 1); } else {
        const [a, b] = t1.value.split(':').map(Number), [c, dd] = t2.value.split(':').map(Number);
        start = new Date(day); start.setHours(a, b, 0, 0);
        end = new Date(day); end.setHours(c, dd, 0, 0);
        if (end <= start) { toast('End time must be after start time.', { kind: 'err' }); return; }
      }
      save({ ...strip(e), title: title.value.trim(), start: start.toISOString(), end: end.toISOString(), allDay: allDay.checked,
        location: loc.value.trim(), notes: notes.value.trim(), color, status: e.status || 'confirmed', source: e.source || null }, d);
    } },
    { label: 'Cancel', onClick: d => d.close() },
  ] });
}

// §3 left side panel: mini-cal & upcoming
let sideEl = null, miniMonth = null;
export function renderSide(el) {
  sideEl = el || sideEl;
  if (!sideEl || S.view !== 'calendar') return;
  clear(sideEl);
  miniMonth = miniMonth || new Date(cal.date.getFullYear(), cal.date.getMonth(), 1);
  const m = miniMonth, first = startOfWeek(m), today = new Date();
  const grid = h('div', { class: 'mini-grid' });
  for (let i = 0; i < 7; i++) grid.append(h('span', { class: 'mini-dow', text: capital(DAYS_SHORT[(i + 1) % 7]).slice(0, 2) }));
  for (let i = 0; i < 42; i++) {
    const d = addDays(first, i);
    const has = cal.events.some(e => sameDay(e._s, d));
    grid.append(h('button', { class: 'mini-day' + (d.getMonth() !== m.getMonth() ? ' other' : '') + (sameDay(d, today) ? ' today' : '') + (sameDay(d, cal.date) ? ' sel' : '') + (has ? ' has' : ''),
      text: d.getDate(), 'aria-label': fmtDay(d), on: { click: () => goTo(d) } }));
  }
  const nav = n => { miniMonth = new Date(m.getFullYear(), m.getMonth() + n, 1); renderSide(); };
  const up = h('div', { class: 'upcoming' }, h('h3', { text: 'Upcoming Events' }), h('div', { class: 'muted small', text: 'Loading...' }));
  sideEl.append(h('div', { class: 'mini' },
    h('div', { class: 'mini-head' },
      h('button', { class: 'icon-btn sm', 'aria-label': 'Previous month', on: { click: () => nav(-1) } }, icon('chevLeft', 14)),
      h('strong', { text: `${capital(MONTHS[m.getMonth()])} ${m.getFullYear()}` }),
      h('button', { class: 'icon-btn sm', 'aria-label': 'Next month', on: { click: () => nav(1) } }, icon('chevRight', 14))),
    grid), up);
  const now = new Date();
  api.calendar(startOfDay(now), addDays(now, 14)).then(r => {
    const raw = (Array.isArray(r) ? r : (r.events || [])).filter(e => e.status !== 'detected' && e.status !== 'invited');
    const list = raw.filter(e => new Date(e.end || e.start) >= now).sort((a, b) => new Date(a.start) - new Date(b.start)).slice(0, 8);
    up.lastChild.remove();
    if (!list.length) up.append(h('p', { class: 'muted small', text: 'No events in the next 14 days.' }));
    for (const e of list) {
      const s = new Date(e.start);
      up.append(h('button', { class: 'up-row', style: { '--ev': e.color || '#0f6cbd' }, on: { click: () => showEvent({ ...e, _s: s, _e: new Date(e.end || e.start) }) } },
        h('span', { class: 'up-when', text: `${sameDay(s, now) ? 'Today' : fmtDay(s)}${e.allDay ? '' : ', ' + hhmm(s)}` }),
        h('span', { class: 'up-title', text: e.title || '(untitled)' }),
        e.status === 'detected' ? h('span', { class: 'ev-tag', text: 'detected in email' }) : null));
    }
  }).catch(err => { up.lastChild.textContent = err.message; });
}

export function setMiniMonth(d) { miniMonth = new Date(d.getFullYear(), d.getMonth(), 1); }
