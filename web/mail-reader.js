/* MAP
 * §1 load message                 L19-L76
 * §2 render message               L77-L159
 * §3 detected events / invites    L160-L191
 * §4 more menu, multi-sel, source L192-L228
 */
// Reading pane: header, actions, categories, remote image banner, detected events, attachments, body.
import { h, clear, fmtDue, fmtFull, initials, colorFor, fmtAddr, displayName, fmtSize, fileKind, addDays, hhmm, fmtDay } from './mail-util.js';
import { icon } from './mail-icons.js';
import { S, LOCAL_ACC, emit, on, categoryById, folderByPath, selectedItems } from './mail-state.js';
import { api, attachmentUrl } from './mail-api.js';
import { openMenu, openDialog, toast } from './mail-ui.js';
import { mountHtml, mountText } from './mail-frame.js';
import { setSeen, setCategory, deleteMessages, archiveMessages, blockSender, toggleFlag } from './mail-actions.js';
import { moveMenu, categoriesMenu, taskMenu } from './mail-commands.js';
import { openCustomFilterModal } from './mail-filters.js';
import { buildAutoFilterSub } from './mail-context.js';

// §1 load message
let seq = 0, readTimer = 0, allowImages = false, pendingRead = null;
const host = () => document.getElementById('reader');
const sameMsg = (a, b) => !!a && !!b && a.account === b.account && a.folder === b.folder && a.uid === b.uid;

export function flushPendingRead(nextRef) {
  clearTimeout(readTimer);
  const p = pendingRead;
  if (!p || sameMsg(p, nextRef)) return;
  pendingRead = null;
  const it = S.list.items.find(i => (i.account || S.cur.account) === p.account && (i.folder || S.cur.folder) === p.folder && i.uid === p.uid);
  if (it && it.seen) return;
  setSeen({ account: p.account, folder: p.folder, uids: [p.uid] }, true);
}

export async function openMessage(ref) {
  flushPendingRead(ref);
  const my = ++seq;
  clearTimeout(readTimer);
  S.open = { account: ref.account, folder: ref.folder, uid: ref.uid };
  S.msg = null;
  allowImages = false;
  emit('openChanged');
  render({ loading: true });
  try {
    const m = await api.message(ref.account, ref.folder, ref.uid);
    if (my !== seq) return;
    S.msg = m;
    render();
    scheduleRead(m);
  } catch (e) {
    if (my !== seq) return;
    render({ error: e.message, ref });
  }
}

export function closeMessage() {
  flushPendingRead();
  seq++; clearTimeout(readTimer);
  S.open = null; S.msg = null;
  emit('openChanged');
  render();
}

function scheduleRead(m) {
  if (m.seen || !S.open || S.open.account === LOCAL_ACC) { pendingRead = null; return; }
  const t = { account: S.open.account, folder: S.open.folder, uid: S.open.uid };
  pendingRead = t;
  if (S.list.filters.has('unread')) return;
  const secs = Math.max(0, Math.min(30, Number(S.settings.markReadSeconds ?? 2)));
  readTimer = setTimeout(() => {
    if (sameMsg(S.open, t) && S.msg && !S.msg.seen && !S.list.filters.has('unread')) {
      pendingRead = null;
      setSeen({ account: t.account, folder: t.folder, uids: [t.uid] }, true);
    }
  }, secs * 1000);
}

// §2 render message
export function render(st = {}) {
  const root = host();
  if (!root || S.compose) return;
  clear(root);
  if (S.view === 'mail' && S.sel.size > 1) return renderMulti(root);
  if (st.loading) {
    root.append(h('div', { class: 'rd skel-rd' }, h('i', { class: 'l1' }), h('i', { class: 'l2' }), h('i', { class: 'l3' }), h('i', { class: 'l4' })));
    return;
  }
  if (st.error) {
    root.append(h('div', { class: 'state err' }, icon('warn', 32), h('p', { text: st.error }),
      h('button', { class: 'btn', text: 'Retry', on: { click: () => openMessage(st.ref) } })));
    return;
  }
  const m = S.msg;
  if (!m) {
    root.append(h('div', { class: 'state empty-reader' }, icon('mail', 56), h('p', { text: 'Select a message to read' })));
    return;
  }
  const t = { account: S.open.account, folder: S.open.folder, uids: [m.uid] };
  const isLocal = t.account === LOCAL_ACC;
  const f = !isLocal ? folderByPath(t.account, t.folder) : null;
  const flagged = m.flagged || (m.task && !m.task.done);
  const actions = h('div', { class: 'rd-actions' },
    f && f.specialUse === '\\Drafts' ? h('button', { class: 'btn primary sm', on: { click: () => emit('compose', { mode: 'draft', msg: m }) } }, icon('edit', 16), h('span', { text: 'Continue editing' })) : null,
    h('button', { class: 'btn ghost sm', title: 'Reply (Ctrl+R)', on: { click: () => emit('compose', { mode: 'reply', msg: m }) } }, icon('reply', 16), h('span', { text: 'Reply' })),
    h('button', { class: 'btn ghost sm', title: 'Reply All (Ctrl+Shift+R)', on: { click: () => emit('compose', { mode: 'replyAll', msg: m }) } }, icon('replyAll', 16), h('span', { text: 'Reply All' })),
    h('button', { class: 'btn ghost sm', title: 'Forward (Ctrl+Shift+F)', on: { click: () => emit('compose', { mode: 'forward', msg: m }) } }, icon('forward', 16), h('span', { text: 'Forward' })),
    h('span', { class: 'cmd-sep' }),
    iconBtn('delete', 'Delete', () => deleteMessages(t)),
    !isLocal ? iconBtn('archive', 'Archive', () => archiveMessages(t)) : null,
    iconBtn('move', 'Move to', b => moveMenu(b, t)),
    iconBtn('tag', 'Categories', b => categoriesMenu(b, t)),
    iconBtn(flagged ? 'flagFill' : 'flag', flagged ? 'Flagged (right-click for due date)' : 'Flag message', () => toggleFlag(t), flagged ? 'on' : '', b => taskMenu(b, t)),
    iconBtn('more', 'More actions', b => moreMenu(b, m, t)));
  const who = m.from || {};
  const cats = (m.categories || []).map(categoryById).filter(Boolean);
  const card = h('article', { class: 'rd-card' },
    h('div', { class: 'rd-head' },
      h('div', { class: 'avatar lg', style: { background: colorFor(who.address) }, text: initials(who) }),
      h('div', { class: 'rd-who' },
        h('div', { class: 'rd-from' }, h('strong', { text: displayName(who) }), who.name ? h('span', { class: 'muted', text: ` <${who.address}>` }) : null),
        addrLine('To', m.to), addrLine('Cc', m.cc),
        h('div', { class: 'rd-date muted', text: fmtFull(m.date) })),
      m.task && m.task.due ? h('span', { class: 'chip due', title: 'Task due date' }, icon('flag', 14), fmtDue(m.task.due)) : null),
    cats.length ? h('div', { class: 'rd-cats' }, cats.map(c => h('span', { class: 'chip cat', style: { '--cat': c.color } },
      h('span', { class: 'dot', style: { background: c.color } }), h('span', { text: c.name }),
      h('button', { class: 'chip-x', title: 'Remove category', 'aria-label': `Remove ${c.name}`, on: { click: () => setCategory(t, c.id, false) } }, icon('close', 12))))) : null);
  const remote = m.hasRemoteImages && S.settings.showImages !== 'always' && !allowImages;
  if (remote) {
    card.append(h('div', { class: 'bar-warn' }, icon('image', 16), h('span', { text: 'Remote images have been blocked for your privacy.' }),
      h('button', { class: 'btn link sm', text: 'Show images', on: { click: () => { allowImages = true; render(); } } })));
  }
  const evs = (m.events || []).length ? m.events.map(e => ({ ...e, _kind: 'invited' })) : (m.suggestions || []).map(e => ({ ...e, _kind: 'detected' }));
  if (evs.length) card.append(eventCards(evs, m, t));
  const atts = (m.attachments || []).filter(a => !a.inline);
  if (atts.length) card.append(h('div', { class: 'atts' }, atts.map(a => h('a', { class: 'att', href: attachmentUrl(t.account, t.folder, m.uid, a.id), download: a.filename || 'attachment', title: `Download ${a.filename}` },
    icon(fileKind(a.filename, a.contentType), 22), h('span', { class: 'att-name', text: a.filename || 'attachment' }), h('span', { class: 'att-size muted', text: fmtSize(a.size) })))));
  const body = h('div', { class: 'rd-body' });
  card.append(body);
  root.append(h('div', { class: 'rd' },
    h('div', { class: 'rd-top' },
      h('button', { class: 'icon-btn mobile-only', title: 'Back to list', 'aria-label': 'Back', on: { click: () => emit('mobileBack') } }, icon('back')),
      h('h1', { class: 'rd-subject', text: m.subject || '(no subject)' })),
    actions, card));
  const onMailto = addr => emit('compose', { mode: 'new', to: addr });
  if (m.html) mountHtml(body, m.html, { allowRemote: !remote, onMailto });
  else mountText(body, m.text || '', { onMailto });
}

function iconBtn(ic, title, fn, cls = '', ctx) {
  const b = h('button', { class: 'icon-btn ' + cls, title, 'aria-label': title }, icon(ic, 18));
  b.addEventListener('click', () => fn(b));
  if (ctx) b.addEventListener('contextmenu', e => { e.preventDefault(); ctx(b); });
  return b;
}

function addrLine(label, list) {
  if (!list || !list.length) return null;
  return h('div', { class: 'rd-addr muted' }, h('span', { text: label + ': ' }), h('span', { text: list.map(fmtAddr).join('; ') }));
}

// §3 detected events / invites
function eventCards(evs, m, t) {
  const box = h('div', { class: 'ev-cards' });
  const from = new Date(Math.min(...evs.map(e => +new Date(e.start || Date.now())))), to = new Date(Math.max(...evs.map(e => +new Date(e.end || e.start || Date.now()))));
  const known = api.calendar(addDays(from, -1), addDays(to, 1)).then(r => {
    const list = Array.isArray(r) ? r : (r.events || []);
    return list.filter(e => e.source && e.source.account === t.account && (e.source.uid === m.uid || (m.messageId && e.source.messageId === m.messageId)));
  }).catch(e => { console.warn('[mail] calendar check', e.message); return []; });
  evs.forEach((ev, index) => {
    const title = ev.title || ev.summary || m.subject || 'Event';
    const s = ev.start ? new Date(ev.start) : null;
    const when = s ? `${fmtDay(s)}${ev.allDay ? ', all day' : ', ' + hhmm(s)}${ev.end && !ev.allDay ? '-' + hhmm(new Date(ev.end)) : ''}` : '';
    const slot = h('div', { class: 'ev-act' });
    const card = h('div', { class: 'ev-card ' + ev._kind }, icon('calendar', 22),
      h('div', { class: 'ev-info' },
        h('strong', { text: (ev._kind === 'invited' ? 'Invite: ' : 'Detected event: ') + title }),
        h('span', { class: 'muted', text: [when, ev.location].filter(Boolean).join(' · ') })), slot);
    box.append(card);
    known.then(list => {
      const hit = list.find(k => !s || Math.abs(new Date(k.start) - s) < 60000);
      if (hit) { slot.append(h('span', { class: 'chip ok' }, icon('check', 14), 'Already in calendar')); return; }
      const b = h('button', { class: 'btn sm', on: { click: async () => {
        b.disabled = true;
        try { await api.eventFromMessage(t.account, t.folder, m.uid, index); clear(slot).append(h('span', { class: 'chip ok' }, icon('check', 14), 'Added to calendar')); toast('Event added to calendar', { kind: 'ok' }); emit('calendarChanged'); }
        catch (e) { b.disabled = false; toast(e.message, { kind: 'err' }); }
      } } }, icon('calAdd', 16), h('span', { text: 'Add to calendar' }));
      slot.append(b);
    });
  });
  return box;
}

// §4 more menu, multi-sel, source
function moreMenu(b, m, t) {
  openMenu(b, [
    t.account !== LOCAL_ACC ? { label: m.seen ? 'Mark as Unread' : 'Mark as Read', icon: m.seen ? 'mail' : 'mailOpen', onClick: () => setSeen(t, !m.seen) } : null,
    { label: 'View source', icon: 'code', onClick: () => showSource(t) },
    { label: 'Print', icon: 'print', onClick: () => window.print() },
    { label: 'Add to calendar', icon: 'calAdd', onClick: () => emit('newEvent', { title: m.subject || '', notes: m.preview || '', source: { account: t.account, folder: t.folder, uid: m.uid, messageId: m.messageId, subject: m.subject } }) },
    { label: 'AutoFilter...', icon: 'rules', onClick: () => openCustomFilterModal({ ...m, account: t.account, folder: t.folder }) },
    { sep: true },
    { label: 'Block sender', icon: 'block', danger: true, onClick: () => blockSender(t) },
  ]);
}

async function showSource(t) {
  const pre = h('pre', { class: 'src', text: 'Loading...' });
  openDialog({ title: 'Message source', body: pre, cls: 'wide', buttons: [{ label: 'Close', onClick: d => d.close() }] });
  try { const s = await api.source(t.account, t.folder, t.uids[0]); pre.textContent = typeof s === 'string' ? s : JSON.stringify(s, null, 2); }
  catch (e) { pre.textContent = e.message; }
}

function renderMulti(root) {
  const n = S.sel.size;
  root.append(h('div', { class: 'state multi-sel' }, icon('mail', 48), h('p', { text: `${n} messages selected` }),
    h('div', { class: 'row-btns' },
      h('button', { class: 'btn', on: { click: () => deleteMessages() } }, icon('delete', 16), 'Delete'),
      h('button', { class: 'btn', on: { click: () => archiveMessages() } }, icon('archive', 16), 'Archive'),
      h('button', { class: 'btn', on: { click: e => moveMenu(e.currentTarget) } }, icon('move', 16), 'Move'),
      h('button', { class: 'btn', on: { click: () => setSeen(null, true) } }, icon('mailOpen', 16), 'Mark as Read'),
      h('button', { class: 'btn', on: { click: e => openMenu(e.currentTarget, buildAutoFilterSub(selectedItems())) } }, icon('rules', 16), 'AutoFilter')),
    h('button', { class: 'btn link', text: 'Clear selection', on: { click: () => { S.sel.clear(); emit('selection'); emit('list'); closeMessage(); } } })));
}

export function initReader() {
  on('msg', () => { if (S.msg) render(); });
  on('settings', () => { if (S.msg && !S.compose) render(); });
  on('selection', () => render());
  on('cancelPendingRead', ts => {
    if (pendingRead && (ts || []).some(g => g.account === pendingRead.account && g.folder === pendingRead.folder && g.uids.includes(pendingRead.uid))) {
      clearTimeout(readTimer);
      pendingRead = null;
    }
  });
}
