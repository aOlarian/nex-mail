/* MAP
 * §1 state & loading                 L16-L54
 * §2 toolbar                         L55-L86
 * §3 month view                      L87-L104
 * §4 week / day hourly grid          L105-L151
 * §5 list view (default on mobile)   L152-L166
 * §6 render                          L167-L184
 */
// Calendar: Month / Week / Day / List views, navigation, events from /api/mail/calendar.
import { h, clear, startOfDay, addDays, startOfWeek, sameDay, hhmm, MONTHS, DAYS_SHORT, capital, fmtDay } from './mail-util.js';
import { icon } from './mail-icons.js';
import { S, emit, on, store } from './mail-state.js';
import { api } from './mail-api.js';
import { showEvent, editEvent } from './mail-cal-dialog.js';

// §1 state & loading
export const cal = { view: store.get('calView', 'month'), date: startOfDay(new Date()), events: [], error: null, loading: false };
const HOUR_PX = 48;
let seq = 0, mainEl = null;

function range() {
  const d = cal.date;
  if (cal.view === 'month') { const s = startOfWeek(new Date(d.getFullYear(), d.getMonth(), 1)); return [s, addDays(s, 42)]; }
  if (cal.view === 'week') { const s = startOfWeek(d); return [s, addDays(s, 7)]; }
  if (cal.view === 'day') return [d, addDays(d, 1)];
  return [d, addDays(d, 31)];
}

export async function loadCalendar() {
  const my = ++seq;
  if (S.mobile && (cal.view === 'month' || cal.view === 'week')) cal.view = 'list';
  const [from, to] = range();
  cal.loading = true; cal.error = null;
  try {
    const r = await api.calendar(from, to);
    if (my !== seq) return;
    const list = (Array.isArray(r) ? r : (r.events || [])).filter(e => e.status !== 'detected' && e.status !== 'invited');
    cal.events = list.map(e => ({ ...e, _s: new Date(e.start), _e: new Date(e.end || e.start) }));
  } catch (e) { if (my === seq) cal.error = e.message; }
  cal.loading = false;
  emit('calendar');
}

export function setView(v) { cal.view = v; store.set('calView', v); loadCalendar(); }
export function goTo(d) { cal.date = startOfDay(d); loadCalendar(); }
function shift(n) {
  const d = new Date(cal.date);
  if (cal.view === 'month') { d.setDate(1); d.setMonth(d.getMonth() + n); } else d.setDate(d.getDate() + n * (cal.view === 'week' ? 7 : cal.view === 'list' ? 30 : 1));
  goTo(d);
}

const eventsOn = day => cal.events.filter(e => e._s < addDays(startOfDay(day), 1) && (e._e > startOfDay(day) || sameDay(e._s, day)))
  .sort((a, b) => (b.allDay - a.allDay) || (a._s - b._s));

// §2 toolbar
function title() {
  const d = cal.date;
  if (cal.view === 'month') return `${capital(MONTHS[d.getMonth()])} ${d.getFullYear()}`;
  if (cal.view === 'week') { const s = startOfWeek(d), e = addDays(s, 6); return `${s.getDate()} ${MONTHS[s.getMonth()]} - ${e.getDate()} ${MONTHS[e.getMonth()]} ${e.getFullYear()}`; }
  if (cal.view === 'day') return `${fmtDay(d)} ${d.getFullYear()}`;
  return `From ${fmtDay(d)}`;
}

function toolbar() {
  const views = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['list', 'List']];
  return h('div', { class: 'cal-bar' },
    h('button', { class: 'btn primary', on: { click: () => editEvent({ start: defaultStart(cal.date) }) } }, icon('calAdd', 16), h('span', { text: 'New Event' })),
    h('button', { class: 'btn', text: 'Today', on: { click: () => goTo(new Date()) } }),
    h('button', { class: 'icon-btn', title: 'Previous', 'aria-label': 'Previous period', on: { click: () => shift(-1) } }, icon('chevLeft')),
    h('button', { class: 'icon-btn', title: 'Next', 'aria-label': 'Next period', on: { click: () => shift(1) } }, icon('chevRight')),
    h('h2', { class: 'cal-title', text: title() }),
    h('div', { class: 'seg', role: 'tablist' }, views.map(([v, l]) => h('button', { class: 'seg-btn' + (cal.view === v ? ' on' : ''), role: 'tab', 'aria-selected': String(cal.view === v), text: l, on: { click: () => setView(v) } }))));
}

function defaultStart(day) { const d = new Date(day); const now = new Date(); d.setHours(sameDay(d, now) ? Math.min(22, now.getHours() + 1) : 9, 0, 0, 0); return d; }

function evChip(e, withTime = true) {
  const lbl = e.status === 'detected' ? 'detected in email' : e.status === 'invited' ? 'invite' : '';
  const el = h('button', { class: `ev ev-${e.status || 'confirmed'}`, style: { '--ev': e.color || '#0f6cbd' }, title: `${e.title}${lbl ? ' (' + lbl + ')' : ''}` },
    withTime && !e.allDay ? h('span', { class: 'ev-time', text: hhmm(e._s) }) : null,
    h('span', { class: 'ev-title', text: e.title || '(untitled)' }),
    lbl ? h('span', { class: 'ev-tag', text: lbl }) : null);
  el.addEventListener('click', ev => { ev.stopPropagation(); showEvent(e); });
  return el;
}

// §3 month view
function monthView() {
  const [from] = range(), m = cal.date.getMonth(), today = new Date();
  const grid = h('div', { class: 'cal-month' });
  for (let i = 0; i < 7; i++) grid.append(h('div', { class: 'cal-dow', text: capital(DAYS_SHORT[(i + 1) % 7]) }));
  for (let i = 0; i < 42; i++) {
    const d = addDays(from, i), evs = eventsOn(d);
    const cell = h('div', { class: 'cal-cell' + (d.getMonth() !== m ? ' other' : '') + (sameDay(d, today) ? ' today' : ''), role: 'gridcell', tabindex: '0', 'aria-label': fmtDay(d) },
      h('span', { class: 'cal-num', text: d.getDate() === 1 ? `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}.` : String(d.getDate()) }));
    evs.slice(0, 3).forEach(e => cell.append(evChip(e)));
    if (evs.length > 3) cell.append(h('button', { class: 'ev-more', text: `+${evs.length - 3} more`, on: { click: ev => { ev.stopPropagation(); cal.date = d; setView('day'); } } }));
    cell.addEventListener('click', () => editEvent({ start: defaultStart(d) }));
    cell.addEventListener('keydown', ev => { if (ev.key === 'Enter') editEvent({ start: defaultStart(d) }); });
    grid.append(cell);
  }
  return grid;
}

// §4 week / day hourly grid
function timeView(days) {
  const today = new Date();
  const head = h('div', { class: 'tg-head', style: { gridTemplateColumns: `56px repeat(${days.length}, 1fr)` } }, h('div'));
  const allDay = h('div', { class: 'tg-allday', style: { gridTemplateColumns: `56px repeat(${days.length}, 1fr)` } }, h('div', { class: 'tg-lbl', text: 'All day' }));
  const body = h('div', { class: 'tg-body', style: { gridTemplateColumns: `56px repeat(${days.length}, 1fr)` } });
  const hours = h('div', { class: 'tg-hours' });
  for (let i = 0; i < 24; i++) hours.append(h('div', { class: 'tg-hour', style: { height: HOUR_PX + 'px' }, text: `${String(i).padStart(2, '0')}:00` }));
  body.append(hours);
  for (const d of days) {
    head.append(h('div', { class: 'tg-day' + (sameDay(d, today) ? ' today' : '') }, h('span', { text: capital(DAYS_SHORT[d.getDay()]) }), h('strong', { text: d.getDate() })));
    const evs = eventsOn(d);
    allDay.append(h('div', { class: 'tg-allcell' }, evs.filter(e => e.allDay || !sameDay(e._s, e._e)).map(e => evChip(e, false))));
    const col = h('div', { class: 'tg-col' + (sameDay(d, today) ? ' today' : ''), style: { height: 24 * HOUR_PX + 'px' } });
    for (let i = 0; i < 48; i++) col.append(h('div', { class: 'tg-slot' + (i % 2 ? ' half' : ''), style: { height: HOUR_PX / 2 + 'px' } }));
    col.addEventListener('click', e => {
      const min = Math.floor((e.offsetY + (e.target === col ? 0 : e.target.offsetTop)) / (HOUR_PX / 2)) * 30;
      const s = new Date(d); s.setHours(0, min, 0, 0);
      editEvent({ start: s });
    });
    layoutTimed(evs.filter(e => !e.allDay && sameDay(e._s, e._e)), col, d);
    if (sameDay(d, today)) col.append(h('div', { class: 'tg-now', style: { top: (today.getHours() * 60 + today.getMinutes()) / 60 * HOUR_PX + 'px' } }));
    body.append(col);
  }
  const scroller = h('div', { class: 'tg-scroll' }, body);
  setTimeout(() => { scroller.scrollTop = 7 * HOUR_PX; }, 0);
  return h('div', { class: 'cal-time' }, head, allDay, scroller);
}

function layoutTimed(evs, col, day) {
  const cols = [];
  evs.sort((a, b) => a._s - b._s).forEach(e => {
    let c = cols.findIndex(end => end <= e._s);
    if (c < 0) { c = cols.length; cols.push(0); }
    cols[c] = e._e; e._col = c;
  });
  const n = Math.max(1, cols.length);
  for (const e of evs) {
    const top = (e._s - startOfDay(day)) / 3600000 * HOUR_PX;
    const hgt = Math.max(HOUR_PX / 2 - 2, (e._e - e._s) / 3600000 * HOUR_PX - 2);
    const chip = evChip(e);
    chip.classList.add('timed');
    Object.assign(chip.style, { top: top + 'px', height: hgt + 'px', left: `calc(${(e._col / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 4px)` });
    col.append(chip);
  }
}

// §5 list view (default on mobile)
function listView() {
  const box = h('div', { class: 'cal-list' });
  let any = false;
  for (let i = 0; i < 31; i++) {
    const d = addDays(cal.date, i), evs = eventsOn(d);
    if (!evs.length) continue;
    any = true;
    box.append(h('div', { class: 'cal-list-day' + (sameDay(d, new Date()) ? ' today' : ''), text: fmtDay(d) }));
    evs.forEach(e => box.append(h('div', { class: 'cal-list-row' }, h('span', { class: 'cal-list-time', text: e.allDay ? 'All day' : `${hhmm(e._s)}-${hhmm(e._e)}` }), evChip(e, false))));
  }
  if (!any) box.append(h('div', { class: 'state' }, icon('calendar', 40), h('p', { text: 'No events in the next 30 days' })));
  return box;
}

// §6 render
export function renderCalendar(main) {
  mainEl = main || mainEl;
  if (!mainEl || S.view !== 'calendar') return;
  clear(mainEl);
  const content = cal.error
    ? h('div', { class: 'state err' }, icon('warn', 32), h('p', { text: cal.error }), h('button', { class: 'btn', text: 'Retry', on: { click: loadCalendar } }))
    : cal.view === 'month' ? monthView()
      : cal.view === 'week' ? timeView([...Array(7)].map((_, i) => addDays(startOfWeek(cal.date), i)))
        : cal.view === 'day' ? timeView([cal.date]) : listView();
  mainEl.append(h('div', { class: 'cal' + (cal.loading ? ' loading' : '') }, toolbar(), content));
}

export function initCalendar() {
  if (S.mobile && !store.get('calView', null)) cal.view = 'list';
  on('calendar', () => renderCalendar());
  on('calendarChanged', () => { if (S.view === 'calendar') loadCalendar(); });
}
