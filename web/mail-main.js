/* MAP
 * §1 views & navigation           L27-L64
 * §2 counts, title, notifications   L65-L101
 * §3 event wiring                   L102-L162
 * §4 welcome & fatal states         L163-L180
 * §5 polling & boot                 L181-L232
 */
// App bootstrap: initial state, cross-module event wiring, views, polling, unread badge.
import { h, clear, $ } from './mail-util.js';
import { icon } from './mail-icons.js';
import { S, LOCAL_ACC, ALL_INBOXES_ACC, isVirtualAcc, on, emit, store, folderByUse, folderByPath, accountById, filteredById, inboxUnread } from './mail-state.js';
import { api } from './mail-api.js';
import { toast } from './mail-ui.js';
import { initLayout, markRail, setMobilePane, setSearchText } from './mail-layout.js';
import { renderTree, loadFolders } from './mail-tree.js';
import { initList, loadList, refreshList, selectOne } from './mail-list.js';
import { initReader, openMessage, closeMessage, flushPendingRead, render as renderReader } from './mail-reader.js';
import { initRightbar } from './mail-rightbar.js';
import { runAllFiltersNow } from './mail-filters.js';
import { openCompose } from './mail-compose.js';
import { initCalendar, renderCalendar, loadCalendar } from './mail-calendar.js';
import { renderSide as renderCalSide, editEvent } from './mail-cal-dialog.js';
import { initTasks, renderTasks, renderTaskSide, loadTasks } from './mail-tasks.js';
import { openSettings, applyAppearance } from './mail-settings.js';
import { initKeys } from './mail-keys.js';

// §1 views & navigation
const side = () => $('#side'), alt = () => $('#altview');

function setView(v) {
  if (v === 'rules') { openSettings({ tab: 'rules' }); return; }
  if (v !== 'mail') flushPendingRead();
  S.view = v;
  markRail(v);
  $('#mailview').hidden = v !== 'mail';
  alt().hidden = v === 'mail';
  $('#app').dataset.view = v;
  if (S.mobile) setMobilePane('list');
  if (v === 'mail') { renderTree(side()); return; }
  clear(alt());
  if (v === 'calendar') { renderCalSide(side()); renderCalendar(alt()); loadCalendar(); }
  if (v === 'tasks') { renderTaskSide(side()); renderTasks(alt()); loadTasks(); }
}

function openFolder({ account, folder }, keepSearch) {
  flushPendingRead();
  if (S.view !== 'mail') setView('mail');
  const changed = S.cur.account !== account || S.cur.folder !== folder;
  S.cur = { account, folder };
  store.set('cur', S.cur);
  if (!keepSearch) { S.list.q = ''; setSearchText(''); }
  if (changed) { S.list.filters.clear(); }
  renderTree(side());
  if (S.mobile) setMobilePane('list');
  return loadList(true);
}

const nextHour = () => { const d = new Date(); d.setHours(d.getHours() + 1, 0, 0, 0); return d; };

function openInbox(acc) {
  const inbox = folderByUse(acc, '\\Inbox') || folderByPath(acc, 'INBOX') || (S.folders[acc] && S.folders[acc].folders.find(f => !f.noselect));
  if (inbox) return openFolder({ account: acc, folder: inbox.path });
}

// §2 counts, title, notifications
function recomputeUnread() {
  const by = { ...(S.unread.byAccount || {}) };
  for (const a of S.accounts) if (S.folders[a.id]) by[a.id] = inboxUnread(a.id, false);
  S.unread.byAccount = by;
  S.unread.total = S.accounts.reduce((s, a) => s + (by[a.id] || 0), 0);
}

async function refreshCounts(all, fresh, only) {
  const accs = Array.isArray(only) ? only : (all === true || S.cur.account === ALL_INBOXES_ACC) ? S.accounts.map(a => a.id) : [S.cur.account].filter(id => id && !isVirtualAcc(id));
  await Promise.all(accs.map(id => loadFolders(id, !!fresh).catch(e => console.warn('[mail] folders', id, e.message))));
  recomputeUnread();
  if (S.view === 'mail') renderTree(side()); else if (S.view === 'tasks') renderTaskSide();
  notifyUnread();
}

function reconcileAllInboxes() {
  if (S.cur.account !== ALL_INBOXES_ACC || S.list.q) return;
  if (S.list.filters.size > 1 || (S.list.filters.size === 1 && !S.list.filters.has('unread'))) return;
  const subs = S.list.inboxesSubfolders !== false, excl = new Set(S.settings?.allInboxes?.excluded || []);
  const seenUnread = {};
  for (const it of S.list.items) if (!it.seen && it.account) seenUnread[it.account] = (seenUnread[it.account] || 0) + 1;
  const stale = S.accounts.filter(a => {
    if (excl.has(a.id)) return false;
    const have = inboxUnread(a.id, subs), listN = seenUnread[a.id] || 0;
    return listN > have || (!S.list.more && listN !== have);
  }).map(a => a.id);
  if (stale.length) refreshCounts(false, true, stale);
}

function notifyUnread() {
  const n = S.unread.total || 0;
  document.title = n ? `(${n}) Mail` : 'Mail';
  try { if (window.parent && window.parent !== window) window.parent.postMessage({ tip: 'mail-necitite', n }, location.origin); }
  catch (e) { console.warn('[mail] parent notify', e.message); }
}

// §3 event wiring
function wire() {
  on('view', setView);
  on('openFolder', ref => openFolder(ref));
  on('openMessage', ref => { openMessage(ref); if (S.mobile) setMobilePane('reader'); });
  on('openSource', async src => {
    await openFolder({ account: src.account, folder: src.folder });
    if (S.list.items.some(i => i.uid === src.uid && (i.account || S.cur.account) === src.account)) selectOne(src);
    else openMessage(src);
    if (S.mobile) setMobilePane('reader');
  });
  on('removedOpen', next => { if (next != null) selectOne(next); else { closeMessage(); if (S.mobile) setMobilePane('list'); } });
  on('compose', async opts => {
    if (S.view !== 'mail') setView('mail');
    await openCompose({ ...opts, ref: opts.ref || S.open });
    if (S.mobile) setMobilePane('reader');
  });
  on('composeChanged', () => {
    $('#app').classList.toggle('composing', !!S.compose);
    if (!S.compose) { renderReader(); if (S.mobile) setMobilePane(S.open ? 'reader' : 'list'); }
  });
  on('tree', () => { if (S.view === 'mail') renderTree(side()); });
  on('filteredChanged', () => { if (S.view === 'mail') renderTree(side()); });
  on('refreshCounts', refreshCounts);
  on('listLoaded', reconcileAllInboxes);
  on('reloadList', () => refreshList());
  on('search', v => { if (S.view !== 'mail') setView('mail'); S.list.q = v; loadList(true); });
  on('setSearch', ({ q, scope }) => {
    if (S.view !== 'mail') setView('mail');
    S.list.q = q || '';
    setSearchText(q || '', scope);
    loadList(true);
  });
  on('clearSearch', () => { S.list.q = ''; setSearchText(''); loadList(true); });
  on('openSettings', opts => openSettings(opts));
  on('openFilters', () => openSettings({ tab: 'filters' }));
  on('runFiltersAll', () => runAllFiltersNow());
  on('newEvent', ev => editEvent({ ...ev, start: ev.start || nextHour() }));
  on('mobileBack', () => { S.sel.clear(); emit('selection'); setMobilePane('list'); });
  on('mobileSide', () => setMobilePane('side'));
  on('settings', () => { restartPolling(); emit('list'); });
  on('foldersChanged', acc => { if (acc === S.cur.account && !folderByPath(acc, S.cur.folder)) openInbox(acc); });
  on('accountsChanged', onAccountsChanged);
  on('sync', async acc => {
    const t = toast('Syncing...', { kind: 'busy' });
    try { await api.sync(acc); t.update('Sync started', 'ok'); }
    catch (e) { t.update('Sync failed: ' + e.message, 'err'); return; }
    setTimeout(() => { refreshCounts(true, true); if (S.view === 'mail') refreshList(); }, 2500);
  });
  on('mobile', m => { $('#app').classList.toggle('mobile', m); });
}

async function onAccountsChanged(id) {
  if (!S.accounts.length) { S.cur = { account: null, folder: null }; closeMessage(); showWelcome(); renderTree(side()); return; }
  $('#app').classList.remove('welcome');
  if (id && accountById(id)) await loadFolders(id).catch(e => toast(e.message, { kind: 'err' }));
  if (!accountById(S.cur.account) && !isVirtualAcc(S.cur.account)) { setView('mail'); await openInbox(id || S.accounts[0].id); }
  if (S.view === 'mail') renderTree(side());
  refreshCounts();
}

// §4 welcome & fatal states
function showWelcome() {
  setView('mail');
  $('#app').classList.add('welcome');
  $('#mailview').hidden = true;
  alt().hidden = false;
  clear(alt()).append(h('div', { class: 'welcome-card' }, icon('mail', 64),
    h('h1', { text: 'Welcome to Nex Mail' }),
    h('p', { text: 'Add an email account (IMAP) to view your messages, calendar, and tasks in one place.' }),
    h('button', { class: 'btn primary lg', on: { click: () => openSettings({ tab: 'accounts', add: true }) } }, icon('plus', 18), h('span', { text: 'Add your first account' }))));
}

function showFatal(msg) {
  $('#mailview').hidden = true;
  alt().hidden = false;
  clear(alt()).append(h('div', { class: 'state err' }, icon('warn', 40), h('p', { text: msg }), h('button', { class: 'btn', text: 'Retry', on: { click: boot } })));
}

// §5 polling & boot
let pollTimer = 0, ticks = 0;
function restartPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.hidden || !S.accounts.length) return;
    refreshCounts(++ticks % 5 === 0);
    if (S.view === 'mail' && !S.compose) refreshList();
  }, 60000);
}

async function boot() {
  let st;
  try { st = await api.state(); }
  catch (e) { showFatal(e.message); return; }
  Object.assign(S, {
    user: st.user,
    accounts: st.accounts || [],
    accountGroups: st.accountGroups || [],
    filteredFolders: st.filteredFolders || [],
    settings: st.settings || {},
    categories: st.categories || [],
    signatures: st.signatures || [],
    unread: st.unread || { total: 0, byAccount: {} },
  });
  applyAppearance();
  notifyUnread();
  if (!S.accounts.length) { showWelcome(); renderTree(side()); return; }
  $('#app').classList.remove('welcome');
  setView('mail');
  await Promise.all(S.accounts.map(a => loadFolders(a.id).catch(e => toast(`${a.email}: ${e.message}`, { kind: 'err' }))));
  recomputeUnread();
  notifyUnread();
  const last = store.get('cur', null);
  const validAll = last && last.account === ALL_INBOXES_ACC;
  const validLocal = last && last.account === LOCAL_ACC && filteredById(last.folder);
  const validImap = last && accountById(last.account) && folderByPath(last.account, last.folder);
  if (validAll || validLocal || validImap) await openFolder(last);
  else await openInbox(S.accounts[0].id);
  restartPolling();
}

initLayout();
initList($('#listpane'));
initReader();
initRightbar($('#rightbar'));
initCalendar();
initTasks();
initKeys();
wire();
renderReader();
boot();
