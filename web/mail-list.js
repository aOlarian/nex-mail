/* MAP
 * §1 loading & pagination               L17-L99
 * §2 list head: multi-filters, sort/grp L100-L169
 * §3 message rows & context menu        L170-L226
 * §4 selection                          L227-L261
 * §5 render list & grouping             L262-L299
 */
// Message list: paginated fetch, multi-scope search, combinable filters, Outlook arrange/group, context menu, drag-drop.
import { h, clear, fmtShort, initials, colorFor, displayName, groupMessages } from './mail-util.js';
import { icon } from './mail-icons.js';
import { S, LOCAL_ACC, ALL_INBOXES_ACC, isVirtualAcc, emit, on, store, curFolder, folderTitle, categoryById, filteredById, accountById, msgKey, parseKey } from './mail-state.js';
import { api } from './mail-api.js';
import { openMenu, toast } from './mail-ui.js';
import { toggleFlag, allTargets } from './mail-actions.js';
import { openMessageContextMenu, openGroupContextMenu } from './mail-context.js';

// §1 loading & pagination
let seq = 0;
const pageSize = () => Math.min(200, Math.max(25, S.settings.pageSize || 50));
const listPageSize = () => (S.cur.account === ALL_INBOXES_ACC ? Math.min(200, Math.max(100, pageSize())) : pageSize());

function listParams(page, size) {
  const filters = [...S.list.filters];
  const isAll = S.cur.account === ALL_INBOXES_ACC;
  const scope = isAll
    ? (S.list.q && ['inboxes', 'sent', 'everywhere'].includes(S.list.scope) ? S.list.scope : 'inboxes')
    : (S.list.q ? S.list.scope : 'folder');
  return {
    account: S.cur.account, folder: S.cur.folder, page, size,
    scope, sentName: S.list.sentName || 'Sent',
    ...(isAll ? { subfolders: S.list.inboxesSubfolders ? 1 : 0 } : {}),
    q: S.list.q, inBody: S.list.q && S.list.inBody ? 1 : 0,
    filter: filters.length === 1 ? filters[0] : 'all', filters: filters.join(','),
    sortBy: S.list.sortBy || 'date', sortDir: S.list.sortDir || 'desc',
  };
}

function setMoreBtn(loading) {
  const b = document.querySelector('#list .more');
  if (b) { b.textContent = loading ? 'Loading...' : 'Load more'; b.disabled = loading; }
}

function appendRows(added) {
  const body = document.getElementById('list');
  if (!body || !body.querySelector('.row')) return false;
  body.querySelector('.more')?.remove();
  for (const it of added) body.append(row(it));
  if (S.list.more) body.append(h('button', { class: 'btn ghost more', text: 'Load more', on: { click: loadMore } }));
  const cnt = document.querySelector('#listpane .list-count');
  if (cnt) cnt.textContent = S.list.total ? String(S.list.total) : '';
  return true;
}

export async function loadList(reset = true) {
  if (!S.cur.account || !S.cur.folder) return;
  const my = ++seq;
  if (reset) { S.list.page = 0; S.list.items = []; S.list.total = 0; S.sel.clear(); }
  S.list.loading = true; S.list.error = null;
  if (reset) emit('list'); else setMoreBtn(true);
  try {
    const res = await api.messages(listParams(S.list.page, listPageSize()));
    if (my !== seq) return;
    const have = new Set(S.list.items.map(msgKey));
    const added = (res.items || []).filter(i => !have.has(msgKey(i)));
    S.list.items = [...S.list.items, ...added];
    S.list.total = res.total || 0;
    S.list.more = S.list.items.length < S.list.total && (res.items || []).length > 0;
    S.list.loading = false;
    if (!reset && (S.list.groupBy || 'none') === 'none' && appendRows(added)) return;
  } catch (e) {
    if (my !== seq) return;
    S.list.loading = false;
    if (!reset && S.list.items.length) { setMoreBtn(false); toast('Could not load more: ' + e.message, { kind: 'err' }); return; }
    S.list.error = e.message;
  }
  emit('list'); if (!S.list.error) emit('listLoaded');
}

export function loadMore() { if (!S.list.loading && S.list.more) { S.list.page++; loadList(false); } }

export async function refreshList() {
  if (!S.cur.account || S.list.loading || S.list.error) return;
  const my = ++seq;
  try {
    const step = listPageSize(), size = Math.min(200, Math.max(step, S.list.items.length));
    const res = await api.messages(listParams(0, size));
    if (my !== seq) return;
    const fresh = res.items || [], seen = new Set(fresh.map(msgKey));
    S.list.items = S.list.items.length > 200 ? [...fresh, ...S.list.items.slice(size).filter(i => !seen.has(msgKey(i)))] : fresh;
    S.list.total = res.total || 0;
    S.list.more = S.list.items.length < S.list.total;
    S.list.page = Math.max(0, Math.ceil(S.list.items.length / step) - 1);
    const live = new Set(S.list.items.map(msgKey)), prevSel = S.sel.size;
    for (const k of S.sel) if (!live.has(k)) S.sel.delete(k);
    emit('list'); emit('listLoaded');
    if (S.sel.size !== prevSel) emit('selection');
  } catch (e) { console.warn('[mail] list refresh', e.message); }
}

// §2 list head: multi-filters, sort/group
const FILTER_PILLS = [['unread', 'Unread'], ['flagged', 'Flagged'], ['attachments', 'Attachments']];
const SORTS = [['date', 'Date'], ['subject', 'Subject'], ['from', 'From'], ['to', 'To']];
const GROUPS = [['date', 'By Date'], ['sender', 'By Sender'], ['subject', 'By Subject'], ['none', 'No Grouping']];
const SCOPE_LABEL = () => ({ folder: 'Current folder', mailbox: 'Current mailbox', inboxes: 'All Inboxes', sent: `All "${S.list.sentName || 'Sent'}" folders`, everywhere: 'Everywhere' })[S.list.scope] || 'Current folder';

function renderHead(head) {
  clear(head);
  const f = curFolder();
  const isLocal = S.cur.account === LOCAL_ACC, isAll = S.cur.account === ALL_INBOXES_ACC;
  const allColor = isAll && !S.list.q ? (S.settings?.allInboxes?.color || '') : '';
  head.classList.toggle('all-inboxes-head', !!allColor);
  if (allColor) head.style.setProperty('--all-accent', allColor); else head.style.removeProperty('--all-accent');
  const title = S.list.q ? 'Search Results' : (isAll ? 'ALL INBOXES' : isLocal ? (filteredById(S.cur.folder)?.name || 'Filtered') : (folderTitle(f) || 'Inbox'));
  const allSel = S.list.items.length > 0 && S.list.items.every(i => S.sel.has(msgKey(i)));
  const selAll = h('input', { type: 'checkbox', class: 'chk', title: 'Select all', 'aria-label': 'Select all', checked: allSel });
  selAll.addEventListener('change', () => { S.sel = new Set(selAll.checked ? S.list.items.map(msgKey) : []); emit('list'); emit('selection'); });

  const sortLbl = SORTS.find(x => x[0] === S.list.sortBy)?.[1] || 'Date';
  const sortBtn = h('button', { class: 'btn ghost sm', 'aria-haspopup': 'menu', title: 'Arrange by' },
    h('span', { text: `Arrange: ${sortLbl} ${S.list.sortDir === 'asc' ? '↑' : '↓'}` }), icon('chevDown', 13));
  sortBtn.addEventListener('click', () => openMenu(sortBtn, [
    { header: 'Arrange by' },
    ...SORTS.map(([k, l]) => ({
      label: l, checked: S.list.sortBy === k,
      onClick: () => { S.list.sortDir = S.list.sortBy === k ? (S.list.sortDir === 'asc' ? 'desc' : 'asc') : (k === 'date' ? 'desc' : 'asc'); S.list.sortBy = k; loadList(); },
    })),
    { sep: true },
    { label: S.list.sortDir === 'asc' ? 'Descending' : 'Ascending', onClick: () => { S.list.sortDir = S.list.sortDir === 'asc' ? 'desc' : 'asc'; loadList(); } },
  ]));

  const grpLbl = GROUPS.find(x => x[0] === S.list.groupBy)?.[1] || 'By Date';
  const grpBtn = h('button', { class: 'btn ghost sm', 'aria-haspopup': 'menu', title: 'Group by' },
    h('span', { text: grpLbl }), icon('chevDown', 13));
  grpBtn.addEventListener('click', () => openMenu(grpBtn, [
    { header: 'Group messages' },
    ...GROUPS.map(([k, l]) => ({ label: l, checked: S.list.groupBy === k, onClick: () => { S.list.groupBy = k; emit('list'); } })),
    { sep: true },
    { label: 'Most messages first', checked: !!S.list.groupByCount, onClick: () => { S.list.groupByCount = !S.list.groupByCount; store.set('groupByCount', S.list.groupByCount); if (S.list.groupByCount && (S.list.groupBy === 'date' || S.list.groupBy === 'none')) S.list.groupBy = 'sender'; emit('list'); } },
  ]));

  const pills = h('div', { class: 'list-pills' },
    h('button', {
      class: 'filter-pill' + (S.list.filters.size === 0 ? ' on' : ''), text: 'All',
      on: { click: () => { if (S.list.filters.size) { S.list.filters.clear(); loadList(); } } },
    }),
    ...FILTER_PILLS.map(([k, l]) => h('button', {
      class: 'filter-pill' + (S.list.filters.has(k) ? ' on' : ''), text: l,
      on: { click: () => { if (S.list.filters.has(k)) S.list.filters.delete(k); else S.list.filters.add(k); loadList(); } },
    })),
    isAll ? h('button', {
      class: 'filter-pill' + (S.list.inboxesSubfolders ? ' on' : ''), text: 'Subfolders',
      title: 'Include Inbox subfolders',
      on: { click: () => { S.list.inboxesSubfolders = !S.list.inboxesSubfolders; store.set('inboxesSubfolders', S.list.inboxesSubfolders); emit('tree'); loadList(); } },
    }) : null);

  head.append(
    h('div', { class: 'list-title' }, selAll, h('h2', { text: title }),
      isLocal ? h('span', { class: 'badge', text: 'Local' }) : null,
      h('span', { class: 'list-sel-count', hidden: S.sel.size <= 1, text: S.sel.size > 1 ? `${S.sel.size} selected` : '' }),
      h('span', { class: 'list-count', text: S.list.total ? String(S.list.total) : '' })),
    h('div', { class: 'list-controls' }, pills, h('span', { class: 'list-controls-sep' }), sortBtn, grpBtn));

  if (S.list.q) {
    head.append(h('div', { class: 'list-search' },
      h('span', { text: `"${S.list.q}" in ${SCOPE_LABEL()}${S.list.inBody ? ' (+ body)' : ''}` }),
      h('button', { class: 'btn link sm', text: 'Clear search', on: { click: () => emit('clearSearch') } })));
  }
}

// §3 message rows & context menu
const isSentLike = it => {
  const f = (it.folder || S.cur.folder || '').toLowerCase();
  if (curFolder()?.specialUse && ['\\Sent', '\\Drafts'].includes(curFolder().specialUse) && !S.list.q) return true;
  return f === 'sent' || f.startsWith('sent/') || f === 'drafts';
};

function row(it) {
  const acc = it.account || S.cur.account, folder = it.folder || S.cur.folder;
  const key = msgKey(it), sent = isSentLike(it);
  const who = sent ? (it.to && it.to[0]) || it.from : it.from;
  const flagged = it.flagged || (it.task && !it.task.done);
  const openMatch = S.open && S.open.uid === it.uid && S.open.folder === folder && S.open.account === acc;
  const r = h('div', {
    class: 'row' + (it.seen ? '' : ' unread') + (S.sel.has(key) ? ' selected' : '') + (openMatch ? ' open' : '') + (flagged ? ' flagged' : ''),
    role: 'option', 'aria-selected': String(S.sel.has(key)), draggable: 'true', dataset: { key, uid: it.uid }, tabindex: '-1',
  });
  const cats = (it.categories || []).map(categoryById).filter(Boolean);
  const t = { account: acc, folder, uids: [it.uid] };
  const flagBtn = h('button', {
    class: 'icon-btn sm row-flag' + (flagged ? ' on' : ''),
    title: flagged ? 'Clear flag' : 'Flag message', 'aria-label': 'Flag',
    on: { click: e => { e.stopPropagation(); toggleFlag(t); } },
  }, icon(flagged ? 'flagFill' : 'flag', 16));

  const showSrc = (S.list.q && S.list.scope !== 'folder') || isVirtualAcc(S.cur.account);
  const accObj = accountById(acc);
  const srcLabel = acc === LOCAL_ACC ? (filteredById(folder)?.name || 'Filtered') : `${accObj?.email || accObj?.name || acc} · ${folder}`;
  const catBar = cats.length ? h('div', { class: 'row-catbar' }, cats.map(c => h('span', { class: 'row-catseg', style: { background: c.color }, title: c.name }))) : null;

  r.append(
    h('div', { class: 'avatar', style: { background: colorFor(who && who.address) }, text: initials(who) }),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-l1' },
        h('span', { class: 'row-from', text: (sent ? 'To: ' : '') + (displayName(who) || '(no sender)') }),
        showSrc ? h('span', { class: 'row-src-badge', text: srcLabel, title: srcLabel }) : null,
        it.answered ? icon('reply', 14, 'row-ic') : null,
        it.hasAttachments ? icon('attach', 14, 'row-ic') : null,
        h('span', { class: 'row-date', text: fmtShort(it.date) })),
      h('div', { class: 'row-l2' },
        h('span', { class: 'row-subj', text: it.subject || '(no subject)' }),
        h('span', { class: 'row-cats' }, cats.map(c => h('span', { class: 'cat-dot', title: c.name, style: { background: c.color } }))),
        flagBtn),
      h('div', { class: 'row-l3', text: it.preview || '' })),
    ...(catBar ? [catBar] : []));
  r.addEventListener('click', e => clickRow(e, key));
  r.addEventListener('contextmenu', e => openMessageContextMenu(e, it, selectHighlightOnly));
  r.addEventListener('dragstart', e => {
    if (!S.sel.has(key)) { S.sel = new Set([key]); markSel(); }
    const targets = allTargets();
    const first = targets[0] || t;
    e.dataTransfer.setData('application/x-nexmail-msgs', JSON.stringify({ account: first.account, folder: first.folder, uids: first.uids, targets }));
    e.dataTransfer.effectAllowed = 'move';
  });
  return r;
}

// §4 selection
const selectHighlightOnly = key => { S.sel = new Set([key]); S.anchor = key; markSel(); emit('selection'); };
const toggleSel = key => { if (S.sel.has(key)) S.sel.delete(key); else S.sel.add(key); S.anchor = key; markSel(); emit('selection'); if (!S.sel.size && S.open && msgKey(S.open) === key) emit('removedOpen', null); };

function clickRow(e, key) {
  if (e.ctrlKey || e.metaKey) { toggleSel(key); return; }
  if (e.shiftKey && S.anchor != null) {
    const ids = [...document.querySelectorAll('#list .row')].map(el => el.dataset.key);
    const [a, b] = [ids.indexOf(String(S.anchor)), ids.indexOf(key)].sort((x, y) => x - y);
    if (a >= 0 && b >= 0) { S.sel = new Set(ids.slice(a, b + 1)); markSel(); emit('selection'); return; }
  }
  selectOne(key);
}

export function selectOne(targetRef) {
  const key = typeof targetRef === 'string' && targetRef.includes('|') ? targetRef
    : (typeof targetRef === 'object' && targetRef ? msgKey(targetRef) : msgKey({ account: S.cur.account, folder: S.cur.folder, uid: targetRef }));
  S.sel = new Set([key]);
  S.anchor = key;
  markSel();
  emit('openMessage', parseKey(key));
}

function markSel() {
  for (const el of document.querySelectorAll('#list .row')) {
    const key = el.dataset.key, p = parseKey(key), sel = S.sel.has(key);
    el.classList.toggle('selected', sel);
    el.setAttribute('aria-selected', String(sel));
    el.classList.toggle('open', !!S.open && S.open.uid === p.uid && S.open.folder === p.folder && S.open.account === p.account);
  }
  document.getElementById('list')?.classList.toggle('multi', S.sel.size > 1);
  const sc = document.querySelector('#listpane .list-sel-count'), sa = document.querySelector('#listpane .list-title .chk');
  if (sc) { sc.hidden = S.sel.size <= 1; if (S.sel.size > 1) sc.textContent = `${S.sel.size} selected`; }
  if (sa) sa.checked = S.list.items.length > 0 && S.list.items.every(i => S.sel.has(msgKey(i)));
}

// §5 render list & grouping
const collapsedGroups = new Set();

export function renderList(pane) {
  const head = pane.querySelector('.list-head'), body = pane.querySelector('#list');
  const top = body.scrollTop;
  const ae = document.activeElement, fKey = ae && body.contains(ae) && ae.dataset?.key;
  renderHead(head);
  const frag = document.createDocumentFragment();
  body.classList.toggle('multi', S.sel.size > 1);
  if (S.list.error) { body.replaceChildren(h('div', { class: 'state err' }, icon('warn', 32), h('p', { text: S.list.error }), h('button', { class: 'btn', text: 'Retry', on: { click: () => loadList() } }))); return; }
  if (!S.list.items.length && S.list.loading) { for (let i = 0; i < 9; i++) frag.append(h('div', { class: 'row skel' }, h('div', { class: 'avatar' }), h('div', { class: 'row-main' }, h('i'), h('i'), h('i')))); body.replaceChildren(frag); return; }
  if (!S.list.items.length) { body.replaceChildren(h('div', { class: 'state' }, icon('inbox', 40), h('p', { text: S.list.q ? 'No results matching search' : 'No messages here' }))); return; }
  const mode = S.list.groupBy || 'date', buckets = groupMessages(S.list.items, mode, S.list.sortDir, S.list.groupByCount);
  const allKeys = buckets.filter(([g]) => g).map(([g]) => `${mode}|${g}`);
  for (const [grp, items] of buckets) {
    const k = `${mode}|${grp}`, collapsed = grp && collapsedGroups.has(k);
    if (grp) frag.append(h('button', { type: 'button', class: 'list-group', 'aria-expanded': String(!collapsed), on: {
      click: () => { if (collapsed) collapsedGroups.delete(k); else collapsedGroups.add(k); renderList(pane); },
      contextmenu: e => openGroupContextMenu(e, { grp, items, key: k, collapsed, allKeys, collapsedGroups, redraw: () => renderList(pane), onSelect: () => { items.forEach(it => S.sel.add(msgKey(it))); markSel(); emit('selection'); } }),
    } }, icon(collapsed ? 'chevRight' : 'chevDown', 13), h('span', { class: 'list-group-name', text: grp }), h('span', { class: 'list-group-count', text: String(items.length) })));
    if (!collapsed) for (const it of items) frag.append(row(it));
  }
  if (S.list.more) frag.append(h('button', { class: 'btn ghost more', text: S.list.loading ? 'Loading...' : 'Load more', disabled: S.list.loading, on: { click: loadMore } }));
  body.replaceChildren(frag);
  body.scrollTop = top;
  if (fKey) body.querySelector(`.row[data-key="${CSS.escape(fKey)}"]`)?.focus({ preventScroll: true });
  if (top > 0) queueMicrotask(() => { if (body.scrollTop === 0) body.scrollTop = top; });
}

export function initList(pane) {
  const body = pane.querySelector('#list');
  body.addEventListener('scroll', () => { if (body.scrollTop + body.clientHeight > body.scrollHeight - 120) loadMore(); });
  on('list', () => renderList(pane));
  on('selection', markSel);
  on('openChanged', markSel);
  on('reloadAllInboxes', () => { if (S.cur.account === ALL_INBOXES_ACC && !S.list.q) loadList(); });
}
