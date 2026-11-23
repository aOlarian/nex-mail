/* MAP
 * §1 state & loading      L15-L31
 * §2 grouping by due date L32-L44
 * §3 actions              L45-L74
 * §4 render               L75-L136
 */
// Tasks view: flagged messages with editable due date and completion checkbox (task.done metadata).
import { h, clear, fmtDue, parseIsoDate, startOfDay, addDays, startOfWeek, displayName, fmtShort, isoDate } from './mail-util.js';
import { icon } from './mail-icons.js';
import { S, emit, on, accountById, categoryById } from './mail-state.js';
import { api } from './mail-api.js';
import { openMenu, promptDialog, toast } from './mail-ui.js';
import { quickDue, refreshCounts } from './mail-actions.js';

// §1 state & loading
const T = { done: false, items: [], loading: false, error: null, counts: { open: null } };
let seq = 0, mainEl = null, sideEl = null;

export async function loadTasks() {
  const my = ++seq;
  T.loading = true; T.error = null; render();
  try {
    const r = await api.tasks(T.done);
    if (my !== seq) return;
    T.items = r.items || [];
    if (!T.done) T.counts.open = T.items.length;
  } catch (e) { if (my === seq) T.error = e.message; }
  T.loading = false;
  render();
}

// §2 grouping by due date
function bucket(it) {
  if (T.done) return 'Completed';
  if (!it.due) return 'No Date';
  const d = parseIsoDate(it.due), today = startOfDay(new Date());
  if (d < today) return 'Overdue';
  if (+d === +today) return 'Today';
  if (+d === +addDays(today, 1)) return 'Tomorrow';
  if (d < addDays(startOfWeek(today), 7)) return 'This Week';
  return 'Later';
}
const ORDER = ['Overdue', 'Today', 'Tomorrow', 'This Week', 'Later', 'No Date', 'Completed'];

// §3 actions
async function update(it, task, okText) {
  try {
    await api.meta({ account: it.account, folder: it.folder, uids: [it.uid], task });
    if (okText) toast(okText, { kind: 'ok', ms: 2500 });
    refreshCounts();
    emit('flaggedChanged');
    const li = S.list.items.find(i => i.uid === it.uid && (i.account || S.cur.account) === it.account && (i.folder || S.cur.folder) === it.folder);
    if (li) { li.task = task; li.flagged = !!task; }
  } catch (e) { toast(e.message, { kind: 'err' }); }
  loadTasks();
}

function dueMenu(anchor, it) {
  const set = due => update(it, { due, done: it.done }, null);
  openMenu(anchor, [
    { label: 'Today', onClick: () => set(quickDue('today')) },
    { label: 'Tomorrow', onClick: () => set(quickDue('tomorrow')) },
    { label: 'This Week', onClick: () => set(quickDue('thisWeek')) },
    { label: 'Next Week', onClick: () => set(quickDue('nextWeek')) },
    { label: 'No Date', onClick: () => set(null) },
    { label: 'Custom Date...', icon: 'calendar', onClick: async () => {
      const d = await promptDialog({ title: 'Due Date', label: 'Date', type: 'date', value: (it.due || '').slice(0, 10) || isoDate(new Date()), ok: 'Set' });
      if (d) set(d);
    } },
    { sep: true },
    { label: 'Clear Flag', icon: 'close', onClick: () => update(it, null, 'Flag cleared') },
  ]);
}

// §4 render
function row(it) {
  const acc = accountById(it.account);
  const overdue = !it.done && it.due && parseIsoDate(it.due) < startOfDay(new Date());
  const chk = h('input', { type: 'checkbox', class: 'chk round', checked: !!it.done, title: it.done ? 'Mark incomplete' : 'Mark complete', 'aria-label': 'Complete' });
  chk.addEventListener('click', e => { e.stopPropagation(); update(it, { due: it.due || null, done: chk.checked }, chk.checked ? 'Task completed' : 'Task reopened'); });
  const due = h('button', { class: 'chip due' + (overdue ? ' late' : '') + (it.due ? '' : ' none'), title: 'Change due date' }, icon('flag', 14), fmtDue(it.due));
  due.addEventListener('click', e => { e.stopPropagation(); dueMenu(due, it); });
  const r = h('div', { class: 'task-row' + (it.done ? ' done' : ''), role: 'listitem', tabindex: '0' },
    chk,
    h('span', { class: 'acc-color-chip', style: { background: acc ? acc.color : '#888' }, title: acc ? acc.email : '' }),
    h('div', { class: 'task-main' },
      h('div', { class: 'task-subj', text: it.subject || '(no subject)' }),
      h('div', { class: 'task-meta muted' }, h('span', { text: displayName(it.from) }), h('span', { text: ' · ' + fmtShort(it.date) }),
        (it.categories || []).map(categoryById).filter(Boolean).map(c => h('span', { class: 'cat-dot', title: c.name, style: { background: c.color } })))),
    due);
  const open = () => emit('openSource', { account: it.account, folder: it.folder, uid: it.uid });
  r.addEventListener('click', open);
  r.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
  return r;
}

export function renderTasks(main) {
  mainEl = main || mainEl;
  if (!mainEl || S.view !== 'tasks') return;
  clear(mainEl);
  const list = h('div', { class: 'task-list', role: 'list' });
  if (T.error) list.append(h('div', { class: 'state err' }, icon('warn', 32), h('p', { text: T.error }), h('button', { class: 'btn', text: 'Retry', on: { click: loadTasks } })));
  else if (T.loading && !T.items.length) for (let i = 0; i < 5; i++) list.append(h('div', { class: 'task-row skel' }, h('i'), h('i')));
  else if (!T.items.length) list.append(h('div', { class: 'state' }, icon('tasks', 44), h('p', { text: T.done ? 'No completed tasks' : 'No open tasks. Flag a message to add it here.' })));
  else {
    const groups = new Map();
    for (const it of T.items) { const b = bucket(it); if (!groups.has(b)) groups.set(b, []); groups.get(b).push(it); }
    for (const b of ORDER) if (groups.has(b)) {
      list.append(h('div', { class: 'list-group' + (b === 'Overdue' ? ' late' : ''), text: `${b} (${groups.get(b).length})` }));
      groups.get(b).sort((x, y) => String(x.due || '9').localeCompare(String(y.due || '9')) || new Date(y.date) - new Date(x.date)).forEach(it => list.append(row(it)));
    }
  }
  mainEl.append(h('div', { class: 'tasks' },
    h('div', { class: 'tasks-head' },
      h('button', { class: 'icon-btn mobile-only', 'aria-label': 'Folders', on: { click: () => emit('mobileSide') } }, icon('menu')),
      h('h2', { text: 'Tasks' }),
      h('div', { class: 'seg' },
        h('button', { class: 'seg-btn' + (!T.done ? ' on' : ''), text: 'To Do', on: { click: () => { T.done = false; loadTasks(); } } }),
        h('button', { class: 'seg-btn' + (T.done ? ' on' : ''), text: 'Completed', on: { click: () => { T.done = true; loadTasks(); } } }))),
    list));
  renderTaskSide();
}

export function renderTaskSide(side) {
  sideEl = side || sideEl;
  if (!sideEl || S.view !== 'tasks') return;
  clear(sideEl);
  const item = (done, label, ic) => h('button', { class: 'tree-row' + (T.done === done ? ' active' : ''), style: { width: '100%', paddingLeft: '10px', border: 0, background: 'none' }, on: { click: () => { T.done = done; loadTasks(); } } },
    icon(ic, 18), h('span', { class: 'tree-name', text: label }), !done && T.counts.open ? h('span', { class: 'badge', text: String(T.counts.open) }) : null);
  sideEl.append(h('div', { class: 'side-title', text: 'Tasks' }), item(false, 'To Do', 'flag'), item(true, 'Completed', 'check'),
    h('p', { class: 'muted small side-hint', text: 'Flag any message (Insert key or flag icon) to track it here.' }));
}

function render() { renderTasks(); }

export function initTasks() { on('tasksChanged', () => { if (S.view === 'tasks') loadTasks(); }); }
