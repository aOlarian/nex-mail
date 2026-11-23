/* MAP
 * §1 period computation & calendar box  L15-L92
 * §2 flagged messages box               L93-L142
 * §3 init & reactive refresh            L143-L194
 */
// Collapsible right sidebar: upcoming Calendar events by flexible range + live Flagged messages list.
import { h, clear, isoDate, addDays, startOfWeek, startOfDay, fmtShort, displayName } from './mail-util.js';
import { icon } from './mail-icons.js';
import { S, on, emit, accountById, store } from './mail-state.js';
import { api } from './mail-api.js';
import { selectEl } from './mail-ui.js';
import { toggleFlag } from './mail-actions.js';
import { showEvent } from './mail-cal-dialog.js';

// §1 period computation & calendar box
const PERIODS = [
  ['today', 'Today'],
  ['week', 'This week'],
  ['7d', 'Next 7 days'],
  ['15d', 'Next 15 days'],
  ['15w', 'Next 15 weeks'],
  ['month', 'This month'],
  ['30d', 'Next 30 days'],
  ['60d', 'Next 60 days'],
  ['year', 'This year'],
];

function periodRange(kind) {
  const now = startOfDay(new Date());
  if (kind === 'today') return [now, addDays(now, 1)];
  if (kind === 'week') { const s = startOfWeek(now); return [s, addDays(s, 7)]; }
  if (kind === '7d') return [now, addDays(now, 7)];
  if (kind === '15d') return [now, addDays(now, 15)];
  if (kind === '15w') return [now, addDays(now, 15 * 7)];
  if (kind === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 1)];
  if (kind === '30d') return [now, addDays(now, 30)];
  if (kind === '60d') return [now, addDays(now, 60)];
  if (kind === 'year') return [new Date(now.getFullYear(), 0, 1), new Date(now.getFullYear() + 1, 0, 1)];
  return [now, addDays(now, 7)];
}

let calBox = null, flagBox = null;
let curPeriod = store.get('rightPeriod', 'week');

async function loadRightCalendar() {
  if (!calBox || !S.rightOpen) return;
  const body = calBox.querySelector('.rb-body');
  clear(body);
  body.append(h('p', { class: 'rb-empty', text: 'Loading...' }));
  const [from, to] = periodRange(curPeriod);
  try {
    const raw = await api.calendar(from, to, true);
    const list = Array.isArray(raw) ? raw : (raw.events || []);
    clear(body);
    if (!list.length) {
      body.append(h('p', { class: 'rb-empty', text: 'No events in this period.' }));
      return;
    }
    const isPend = e => e.status === 'detected' || e.status === 'invited';
    const sorted = [...list].sort((a, b) => (isPend(b) - isPend(a)) || (new Date(a.start) - new Date(b.start)));
    for (const ev of sorted.slice(0, 40)) {
      const d = ev.start ? new Date(ev.start) : null;
      const pend = isPend(ev);
      const when = d && !isNaN(d) ? (ev.allDay ? fmtShort(ev.start) : `${fmtShort(ev.start)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`) : '';
      body.append(h('button', {
        class: 'rb-ev' + (pend ? ' rb-ev-pending' : ''),
        style: pend ? null : { borderLeftColor: ev.color || 'var(--accent)' },
        on: { click: () => showEvent({ ...ev, _s: d || new Date(), _e: new Date(ev.end || ev.start || Date.now()) }) },
      },
      h('div', { class: 'rb-ev-info' },
        h('div', { class: 'rb-ev-title', text: ev.title || '(Untitled)' }),
        h('div', { class: 'rb-ev-time', text: when + (ev.location ? ` · ${ev.location}` : '') }),
        pend ? h('span', { class: 'rb-ev-badge', text: 'Pending approval' }) : null)));
    }
  } catch (e) {
    clear(body);
    body.append(h('p', { class: 'rb-empty', text: 'Failed to load calendar.' }));
  }
}

function buildCalSection() {
  const perSel = selectEl(PERIODS, curPeriod, { class: 'rb-period', 'aria-label': 'Calendar period' });
  perSel.addEventListener('change', () => { curPeriod = perSel.value; store.set('rightPeriod', curPeriod); loadRightCalendar(); });
  calBox = h('section', { class: 'rb-sec rb-cal' },
    h('div', { class: 'rb-head' },
      icon('calendar', 15),
      h('h3', { text: 'Calendar' }),
      perSel),
    h('div', { class: 'rb-body' }));
  return calBox;
}

// §2 flagged messages box
async function loadRightFlagged() {
  if (!flagBox || !S.rightOpen) return;
  const body = flagBox.querySelector('.rb-body');
  const cnt = flagBox.querySelector('.rb-count');
  try {
    const res = await api.flagged(80);
    const items = res.items || [];
    if (cnt) cnt.textContent = items.length ? String(items.length) : '';
    clear(body);
    if (!items.length) {
      body.append(h('p', { class: 'rb-empty', text: 'No flagged messages.' }));
      return;
    }
    for (const it of items) {
      const accName = accountById(it.account)?.name || it.account;
      const unflag = h('button', {
        class: 'icon-btn sm rb-unflag', title: 'Clear flag', 'aria-label': 'Clear flag',
        on: { click: e => { e.stopPropagation(); toggleFlag({ account: it.account, folder: it.folder, uids: [it.uid] }); } },
      }, icon('flagFill', 13));
      body.append(h('div', {
        class: 'rb-flag' + (it.seen ? '' : ' unread'),
        role: 'button', tabindex: '0',
        on: {
          click: () => emit('openSource', { account: it.account, folder: it.folder, uid: it.uid }),
          keydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); emit('openSource', { account: it.account, folder: it.folder, uid: it.uid }); } },
        },
      },
      h('div', { class: 'rb-flag-top' },
        h('span', { class: 'rb-flag-from', text: displayName(it.from) || it.from?.address || '(no sender)' }),
        h('span', { text: fmtShort(it.date) }),
        unflag),
      h('div', { class: 'rb-flag-subj', text: `${it.subject || '(no subject)'} · ${accName}` })));
    }
  } catch (e) {
    clear(body);
    body.append(h('p', { class: 'rb-empty', text: 'Could not load flagged messages.' }));
  }
}

function buildFlagSection() {
  flagBox = h('section', { class: 'rb-sec rb-flagged' },
    h('div', { class: 'rb-head' },
      icon('flagFill', 15, 'rb-flag-ic'),
      h('h3', { text: 'Flagged' }),
      h('span', { class: 'badge rb-count' })),
    h('div', { class: 'rb-body' }));
  return flagBox;
}

// §3 init & reactive refresh
const clampRatio = r => Math.min(0.82, Math.max(0.18, Number(r) || 0.48));
const applyRatio = (box, r) => { box.style.flex = `0 0 ${Math.round(clampRatio(r) * 1000) / 10}%`; };

function buildSplit(el, cal) {
  const sp = h('div', { class: 'rb-splitter', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize Calendar and Flagged sections', title: 'Drag to resize' });
  let ratio = clampRatio(store.get('rightCalRatio', 0.48));
  applyRatio(cal, ratio);
  sp.addEventListener('pointerdown', e => {
    const r = el.getBoundingClientRect(), avail = Math.max(200, r.height - sp.offsetHeight);
    sp.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing-v');
    const move = ev => {
      const px = Math.min(avail - 90, Math.max(90, ev.clientY - r.top));
      ratio = clampRatio(px / avail);
      applyRatio(cal, ratio);
    };
    const up = () => {
      sp.removeEventListener('pointermove', move);
      document.body.classList.remove('resizing-v');
      store.set('rightCalRatio', ratio);
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up, { once: true });
    sp.addEventListener('pointercancel', up, { once: true });
  });
  return sp;
}

export function refreshRightbar() {
  if (!S.rightOpen) return;
  loadRightCalendar();
  loadRightFlagged();
}

export function initRightbar(el) {
  if (!el) return;
  clear(el);
  const cal = buildCalSection(), flg = buildFlagSection();
  el.append(cal, buildSplit(el, cal), flg);
  el.hidden = !S.rightOpen;
  document.getElementById('app')?.setAttribute('data-right', S.rightOpen ? 'open' : 'closed');
  if (S.rightOpen) refreshRightbar();
  on('rightbarToggle', open => {
    el.hidden = !open;
    document.getElementById('app')?.setAttribute('data-right', open ? 'open' : 'closed');
    if (open) refreshRightbar();
  });
  on('flaggedChanged', loadRightFlagged);
  on('calendarChanged', loadRightCalendar);
  on('refreshCounts', refreshRightbar);
}
