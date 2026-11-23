/* MAP
 * §1 data & tree builder                        L16-L54
 * §2 render account categories, accounts, FILTERED L55-L217
 * §3 drag & drop (accounts, messages, folders)  L218-L290
 */
// Folder tree: customizable account category accordions, drag-drop account ordering, colored chevrons, and global FILTERED accordion.
import { h, clear } from './mail-util.js';
import { icon, folderIcon } from './mail-icons.js';
import { S, LOCAL_ACC, ALL_INBOXES_ACC, emit, store, folderList, folderByPath, folderTitle, accountById, inboxUnread } from './mail-state.js';
import { api } from './mail-api.js';
import { openMenu, toast } from './mail-ui.js';
import { moveMessages } from './mail-actions.js';
import { editCategoryDialog, deleteCategory, bindGroupDrag, folderOp, accountMenu, folderMenu, emptyFolder, pickFolder } from './mail-tree-dialogs.js';
export { emptyFolder, pickFolder };

// §1 date & constructie arbore
const ORDER = { '\\Inbox': 0, '\\Drafts': 1, '\\Sent': 2, '\\Archive': 3, '\\Junk': 4, '\\Trash': 5 };
const expanded = store.get('tree', {});
const isOpen = (key, def) => (key in expanded ? expanded[key] : def);
function toggle(key, def) { expanded[key] = !isOpen(key, def); store.set('tree', expanded); emit('tree'); }
function setAllAccountsOpen(open) { for (const a of S.accounts) expanded[a.id] = open; store.set('tree', expanded); emit('tree'); }

export async function loadFolders(account, fresh) {
  const res = await api.folders(account, fresh);
  S.folders[account] = { delimiter: res.delimiter, folders: res.folders || [] };
  emit('tree');
  return S.folders[account];
}

const parentOf = f => { const d = f.delimiter || S.folders[f._acc]?.delimiter; const i = d ? f.path.lastIndexOf(d) : -1; return i > 0 ? f.path.slice(0, i) : ''; };

export function buildTree(acc) {
  const nodes = new Map();
  for (const f of folderList(acc)) nodes.set(f.path, { f: { ...f, _acc: acc }, kids: [] });
  const roots = [];
  for (const n of nodes.values()) {
    const p = parentOf(n.f);
    (p && nodes.has(p) ? nodes.get(p).kids : roots).push(n);
  }
  const sort = list => {
    list.sort((a, b) => (ORDER[a.f.specialUse] ?? 9) - (ORDER[b.f.specialUse] ?? 9) || a.f.name.localeCompare(b.f.name, 'en'));
    list.forEach(n => sort(n.kids));
    return list;
  };
  return sort(roots);
}

export function flatFolders(acc) {
  const out = [];
  const walk = (list, depth) => list.forEach(n => { out.push({ f: n.f, depth }); walk(n.kids, depth + 1); });
  walk(buildTree(acc), 0);
  return out;
}

// §2 randare categorii conturi, conturi si FILTERED
let dragAccId = null, dragGrpId = null;

export function renderTree(root) {
  const top = root.scrollTop;
  const ae = document.activeElement;
  const fAcc = ae && root.contains(ae) && ae.dataset?.acc;
  const fPath = fAcc && ae.dataset?.path;
  const frag = document.createDocumentFragment();
  if (S.accounts.length) {
    const active = S.view === 'mail' && S.cur.account === ALL_INBOXES_ACC;
    const ai = S.settings?.allInboxes || {};
    const excl = new Set(ai.excluded || []);
    const subs = S.list.inboxesSubfolders !== false;
    const totalUnread = S.accounts.reduce((s, a) => s + (excl.has(a.id) ? 0 : inboxUnread(a.id, subs)), 0);
    const allRow = h('div', {
      class: 'tree-row all-inboxes' + (active ? ' active' : '') + (totalUnread ? ' unread' : '') + (ai.color ? ' custom-accent' : ''),
      style: ai.color ? { '--all-accent': ai.color } : null,
      role: 'treeitem', tabindex: '0', dataset: { acc: ALL_INBOXES_ACC, path: 'INBOX' },
    }, icon('inbox', 17, 'tree-ic'), h('span', { class: 'tree-name', text: 'ALL INBOXES' }), totalUnread ? h('span', { class: 'count', text: String(totalUnread) }) : null);
    allRow.addEventListener('click', () => emit('openFolder', { account: ALL_INBOXES_ACC, folder: 'INBOX' }));
    allRow.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); emit('openFolder', { account: ALL_INBOXES_ACC, folder: 'INBOX' }); }
    });
    frag.append(allRow);
  }
  const topBar = h('div', { class: 'side-sec-bar' },
    h('span', { class: 'side-sec-lbl', text: 'Accounts' }),
    h('button', { class: 'icon-btn sm', title: 'Add account category', 'aria-label': 'Add account category', on: { click: () => editCategoryDialog(null) } }, icon('plus', 14)));
  topBar.addEventListener('dragover', e => { if (dragAccId) { e.preventDefault(); topBar.classList.add('drop'); } });
  topBar.addEventListener('dragleave', () => topBar.classList.remove('drop'));
  topBar.addEventListener('drop', e => { topBar.classList.remove('drop'); if (dragAccId) { e.preventDefault(); reorderAccount(dragAccId, null, null); } });
  frag.append(topBar);

  const groups = S.accountGroups || [];
  const groupIds = new Set(groups.map(g => g.id));
  for (const g of groups) {
    const gKey = 'grp:' + g.id, open = isOpen(gKey, true);
    const list = S.accounts.filter(a => a.groupId === g.id);
    const head = h('div', { class: 'cat-head', style: { '--cat-color': g.color || '#0078d4' }, role: 'treeitem', 'aria-expanded': String(open) },
      h('button', { class: 'tree-chev', 'aria-label': open ? 'Collapse' : 'Expand', on: { click: e => { e.stopPropagation(); toggle(gKey, true); } } }, icon(open ? 'chevDown' : 'chevRight', 13)),
      h('span', { class: 'tree-name', text: g.name, on: { click: () => toggle(gKey, true) } }),
      list.length ? h('span', { class: 'count', text: list.reduce((n, a) => n + ((S.unread.byAccount || {})[a.id] || 0), 0) || '' }) : null,
      h('span', { class: 'cat-acts' },
        h('button', { class: 'icon-btn sm', title: 'Edit category', on: { click: e => { e.stopPropagation(); editCategoryDialog(g); } } }, icon('edit', 13)),
        h('button', { class: 'icon-btn sm', title: 'Delete category', on: { click: e => { e.stopPropagation(); deleteCategory(g); } } }, icon('delete', 13))));
    head.addEventListener('dragover', e => { if (dragAccId) { e.preventDefault(); head.classList.add('drop'); } });
    head.addEventListener('dragleave', () => head.classList.remove('drop'));
    head.addEventListener('drop', e => { head.classList.remove('drop'); if (dragAccId) { e.preventDefault(); reorderAccount(dragAccId, g.id, null); } });
    const wrap = h('div', { class: 'cat-acc' }, head);
    bindGroupDrag(wrap, head, g, () => dragGrpId, v => { dragGrpId = v; });
    if (open) {
      const body = h('div', { class: 'cat-body' });
      list.forEach(a => renderAccountBlock(body, a));
      wrap.append(body);
    }
    frag.append(wrap);
  }
  for (const acc of S.accounts) if (!acc.groupId || !groupIds.has(acc.groupId)) renderAccountBlock(frag, acc);
  renderFilteredSection(frag);
  root.replaceChildren(frag);
  root.scrollTop = top;
  if (fAcc) {
    const sel = fPath ? `.tree-row[data-acc="${CSS.escape(fAcc)}"][data-path="${CSS.escape(fPath)}"]` : `.tree-acc[data-acc="${CSS.escape(fAcc)}"]`;
    root.querySelector(sel)?.focus({ preventScroll: true });
  }
  if (top > 0) queueMicrotask(() => { if (root.scrollTop === 0) root.scrollTop = top; });
}

function renderAccountBlock(parent, acc) {
  const key = acc.id, open = isOpen(key, true);
  const unread = (S.unread.byAccount || {})[acc.id] || 0;
  const head = h('div', {
    class: 'tree-acc', role: 'treeitem', 'aria-expanded': String(open), draggable: 'true',
    dataset: { acc: acc.id }, style: { '--acc-color': acc.color || '#0f6cbd' },
  },
  h('button', { class: 'tree-chev', 'aria-label': open ? 'Collapse' : 'Expand', on: { click: () => toggle(key, true) } }, icon(open ? 'chevDown' : 'chevRight', 14)),
  h('span', { class: 'tree-name', text: acc.email, title: `${acc.name} <${acc.email}> (drag to reorder)`, on: { click: () => toggle(key, true) } }),
  acc.status && acc.status.ok === false ? h('span', { class: 'tree-err', title: acc.status.error || 'Sync error' }, icon('warn', 14)) : null,
  unread ? h('span', { class: 'count', text: unread }) : null,
  h('button', { class: 'icon-btn sm tree-more', title: 'More actions', 'aria-label': 'Account actions', on: { click: e => { e.stopPropagation(); accountMenu(e.currentTarget, acc, reorderAccount, setAllAccountsOpen); } } }, icon('more', 16)));
  head.addEventListener('contextmenu', e => { e.preventDefault(); accountMenu({ x: e.clientX, y: e.clientY }, acc, reorderAccount, setAllAccountsOpen); });
  head.addEventListener('dragstart', e => {
    dragAccId = acc.id;
    e.dataTransfer.setData('application/x-nexmail-acc', acc.id);
    e.dataTransfer.effectAllowed = 'move';
    head.classList.add('dragging');
  });
  head.addEventListener('dragend', () => { dragAccId = null; head.classList.remove('dragging'); });
  accountDropTarget(head, acc);
  parent.append(head);
  if (!open) return;
  const box = h('div', { class: 'tree-group', role: 'group' });
  if (!S.folders[acc.id]) box.append(h('div', { class: 'tree-loading', text: 'Loading folders…' }));
  else buildTree(acc.id).forEach(n => renderNode(box, acc, n, 0));
  parent.append(box);
}

function renderFilteredSection(root) {
  const open = isOpen('filtered:root', true);
  const wrap = h('div', { class: 'filtered-acc' },
    h('div', { class: 'filtered-head', role: 'treeitem', 'aria-expanded': String(open), on: { click: () => toggle('filtered:root', true) } },
      h('button', { class: 'tree-chev', 'aria-label': open ? 'Collapse' : 'Expand' }, icon(open ? 'chevDown' : 'chevRight', 13)),
      h('span', { class: 'tree-name', text: 'FILTERED' }),
      h('button', { class: 'icon-btn sm', title: 'Manage filter folders', on: { click: e => { e.stopPropagation(); emit('openFilters'); } } }, icon('edit', 13))));
  if (open) {
    const box = h('div', { class: 'tree-group', role: 'group' });
    for (const f of S.filteredFolders || []) {
      const active = S.view === 'mail' && S.cur.account === LOCAL_ACC && S.cur.folder === f.id;
      const row = h('div', {
        class: 'tree-row' + (active ? ' active' : '') + (f.unread ? ' unread' : ''),
        role: 'treeitem', tabindex: '0', style: { paddingLeft: '4px' }, dataset: { acc: LOCAL_ACC, path: f.id },
      },
      icon('folder', 17, 'tree-ic'),
      h('span', { class: 'tree-name', text: f.name }),
      f.total ? h('span', { class: 'count', text: f.unread ? `${f.unread}/${f.total}` : String(f.total) }) : null);
      row.addEventListener('click', () => emit('openFolder', { account: LOCAL_ACC, folder: f.id }));
      row.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('application/x-nexmail-msgs')) { e.preventDefault(); row.classList.add('drop'); } });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', e => {
        row.classList.remove('drop');
        const msgs = e.dataTransfer.getData('application/x-nexmail-msgs');
        if (!msgs) return;
        e.preventDefault();
        const d = JSON.parse(msgs);
        moveMessages(d, f.id, LOCAL_ACC);
      });
      box.append(row);
    }
    wrap.append(box);
  }
  root.append(wrap);
}

const nodeUnseen = n => (n.f.unseen || 0) + n.kids.reduce((s, k) => s + nodeUnseen(k), 0);

function renderNode(box, acc, n, depth) {
  const f = n.f, key = acc.id + '|' + f.path, open = isOpen(key, false);
  const unseen = nodeUnseen(n);
  const active = S.view === 'mail' && S.cur.account === acc.id && S.cur.folder === f.path;
  const row = h('div', {
    class: 'tree-row' + (active ? ' active' : '') + (f.noselect ? ' noselect' : '') + (unseen ? ' unread' : ''),
    role: 'treeitem', tabindex: '0', draggable: !f.specialUse ? 'true' : 'false', title: f.path,
    style: { paddingLeft: (2 + depth * 10) + 'px' }, dataset: { acc: acc.id, path: f.path },
  },
  n.kids.length ? h('button', { class: 'tree-chev', 'aria-label': open ? 'Collapse' : 'Expand', on: { click: e => { e.stopPropagation(); toggle(key, false); } } }, icon(open ? 'chevDown' : 'chevRight', 14)) : h('span', { class: 'tree-chev' }),
  icon(folderIcon(f.specialUse), 18, 'tree-ic'),
  h('span', { class: 'tree-name', text: folderTitle(f) }),
  unseen ? h('span', { class: 'count', text: unseen }) : null,
  h('button', { class: 'icon-btn sm tree-more', title: 'More', 'aria-label': 'Folder actions', on: { click: e => { e.stopPropagation(); folderMenu(e.currentTarget, acc, f); } } }, icon('more', 16)));
  const openIt = () => { if (!f.noselect) emit('openFolder', { account: acc.id, folder: f.path }); else toggle(key, false); };
  row.addEventListener('click', openIt);
  row.addEventListener('keydown', e => { if (e.key === 'Enter') openIt(); });
  row.addEventListener('contextmenu', e => { e.preventDefault(); folderMenu({ x: e.clientX, y: e.clientY }, acc, f); });
  row.addEventListener('dragstart', e => {
    e.dataTransfer.setData('application/x-nexmail-folder', JSON.stringify({ account: acc.id, path: f.path }));
    e.dataTransfer.effectAllowed = 'move';
  });
  dropTarget(row, acc.id, f.path, f.noselect);
  box.append(row);
  if (open) n.kids.forEach(k => renderNode(box, acc, k, depth + 1));
}

// §3 drag & drop (conturi, mesaje, foldere)
function accountDropTarget(head, targetAcc) {
  head.addEventListener('dragover', e => {
    if (dragAccId && dragAccId !== targetAcc.id) {
      e.preventDefault();
      const r = head.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      head.classList.toggle('drop-above', before);
      head.classList.toggle('drop-below', !before);
      return;
    }
    if (e.dataTransfer.types.includes('application/x-nexmail-folder')) { e.preventDefault(); head.classList.add('drop'); }
  });
  head.addEventListener('dragleave', () => head.classList.remove('drop', 'drop-above', 'drop-below'));
  head.addEventListener('drop', e => {
    const before = head.classList.contains('drop-above');
    head.classList.remove('drop', 'drop-above', 'drop-below');
    if (dragAccId && dragAccId !== targetAcc.id) {
      e.preventDefault();
      reorderAccount(dragAccId, targetAcc.groupId || null, targetAcc.id, before);
      return;
    }
    const fold = e.dataTransfer.getData('application/x-nexmail-folder');
    if (fold) {
      e.preventDefault();
      const d = JSON.parse(fold);
      if (d.account !== targetAcc.id) { toast('Folders can only be moved within the same account.', { kind: 'err' }); return; }
      folderOp(() => api.moveFolder(targetAcc.id, d.path, ''), targetAcc.id, 'Folder moved');
    }
  });
}

async function reorderAccount(srcId, newGroupId, targetId, insertBefore = true) {
  const list = S.accounts.slice();
  const fromIdx = list.findIndex(a => a.id === srcId);
  if (fromIdx < 0) return;
  const [moved] = list.splice(fromIdx, 1);
  if (newGroupId) moved.groupId = newGroupId; else delete moved.groupId;
  if (targetId) {
    let toIdx = list.findIndex(a => a.id === targetId);
    if (toIdx < 0) list.push(moved);
    else list.splice(insertBefore ? toIdx : toIdx + 1, 0, moved);
  } else {
    list.push(moved);
  }
  S.accounts = list;
  emit('tree');
  try {
    S.accounts = await api.reorderAccounts(list.map(a => ({ id: a.id, groupId: a.groupId || null })));
  } catch (e) { toast(e.message, { kind: 'err' }); }
}

function dropTarget(el, acc, path, noselect) {
  const accepts = e => e.dataTransfer.types.includes('application/x-nexmail-folder') || (path && !noselect && e.dataTransfer.types.includes('application/x-nexmail-msgs'));
  el.addEventListener('dragover', e => { if (accepts(e)) { e.preventDefault(); el.classList.add('drop'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', async e => {
    el.classList.remove('drop');
    const msgs = e.dataTransfer.getData('application/x-nexmail-msgs');
    const fold = e.dataTransfer.getData('application/x-nexmail-folder');
    e.preventDefault();
    if (msgs && path) {
      const d = JSON.parse(msgs);
      if (d.account !== acc) { toast('Moving messages between different IMAP accounts is not supported.', { kind: 'err' }); return; }
      if (d.folder !== path) moveMessages(d, path);
    } else if (fold) {
      const d = JSON.parse(fold);
      if (d.account !== acc) { toast('Folders can only be moved within the same account.', { kind: 'err' }); return; }
      if (path === d.path || path.startsWith(d.path + (S.folders[acc]?.delimiter || '/'))) return;
      folderOp(() => api.moveFolder(acc, d.path, path), acc, 'Folder moved');
    }
  });
}
