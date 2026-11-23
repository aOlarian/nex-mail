/* MAP
 * §1 account category dialogs & dnd L13-L89
 * §2 account & folder menus         L90-L196
 */
// Context menus and modal dialogs for folder tree and account categories.
import { h } from './mail-util.js';
import { icon, folderIcon } from './mail-icons.js';
import { S, emit, folderList, folderByPath, folderTitle, accountById } from './mail-state.js';
import { api } from './mail-api.js';
import { openMenu, openDialog, promptDialog, confirmDialog, toast, field } from './mail-ui.js';
import { confirmDeleteAccount } from './mail-accounts.js';

// §1 account category dialogs
export async function editCategoryDialog(existing) {
  const nameIn = h('input', { class: 'inp', value: existing ? existing.name : '', placeholder: 'e.g. Sereni, Qbits, Personal', autofocus: true });
  const colorIn = h('input', { type: 'color', value: (existing && existing.color) || '#0078d4', style: { width: '48px', height: '32px', border: '1px solid var(--border)', borderRadius: '4px' } });
  const d = openDialog({
    title: existing ? 'Edit Account Category' : 'New Account Category', cls: 'small',
    body: h('div', { class: 'form' }, field('Category name', nameIn), field('Left bar color', colorIn)),
    buttons: [
      { label: 'Cancel', onClick: x => x.close(true) },
      { label: 'Save', kind: 'primary', onClick: async x => {
        const name = nameIn.value.trim();
        if (!name) { toast('Enter a category name', { kind: 'err' }); return; }
        const list = (S.accountGroups || []).map(g => ({ ...g }));
        if (existing) Object.assign(list.find(g => g.id === existing.id), { name, color: colorIn.value });
        else list.push({ id: '', name, color: colorIn.value });
        try {
          S.accountGroups = await api.saveAccountGroups(list);
          emit('tree');
          x.close(true);
        } catch (err) { toast(err.message, { kind: 'err' }); }
      } },
    ],
  });
  return d;
}

export async function deleteCategory(g) {
  if (!(await confirmDialog(`Delete category "${g.name}"? Accounts inside become ungrouped.`, { ok: 'Delete', danger: true }))) return;
  try {
    S.accountGroups = await api.saveAccountGroups((S.accountGroups || []).filter(x => x.id !== g.id));
    for (const a of S.accounts) if (a.groupId === g.id) delete a.groupId;
    emit('tree');
  } catch (e) { toast(e.message, { kind: 'err' }); }
}

export async function reorderGroup(srcId, targetId, insertBefore = true) {
  if (!srcId || !targetId || srcId === targetId) return;
  const prev = S.accountGroups || [];
  const list = prev.map(g => ({ ...g }));
  const fromIdx = list.findIndex(g => g.id === srcId);
  if (fromIdx < 0) return;
  const [moved] = list.splice(fromIdx, 1);
  const toIdx = list.findIndex(g => g.id === targetId);
  if (toIdx < 0) return;
  list.splice(insertBefore ? toIdx : toIdx + 1, 0, moved);
  S.accountGroups = list;
  emit('tree');
  try { S.accountGroups = await api.saveAccountGroups(list); }
  catch (e) { S.accountGroups = prev; emit('tree'); toast(e.message, { kind: 'err' }); }
}

export function bindGroupDrag(wrap, head, g, getDrag, setDrag) {
  head.draggable = true; head.dataset.grp = g.id; wrap.dataset.grp = g.id;
  head.addEventListener('dragstart', e => {
    if (e.target.closest('button')) { e.preventDefault(); return; }
    e.stopPropagation(); setDrag(g.id);
    e.dataTransfer?.setData('application/x-nexmail-grp', g.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    wrap.classList.add('dragging');
  });
  head.addEventListener('dragend', () => { setDrag(null); wrap.classList.remove('dragging', 'drop-above', 'drop-below'); });
  wrap.addEventListener('dragover', e => {
    const src = getDrag(); if (!src || src === g.id) return;
    e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const r = wrap.getBoundingClientRect(), before = e.clientY < r.top + r.height / 2;
    wrap.classList.toggle('drop-above', before); wrap.classList.toggle('drop-below', !before);
  });
  wrap.addEventListener('dragleave', e => { if (!e.relatedTarget || !wrap.contains(e.relatedTarget)) wrap.classList.remove('drop-above', 'drop-below'); });
  wrap.addEventListener('drop', e => {
    const src = getDrag(); if (!src || src === g.id) return;
    const r = wrap.getBoundingClientRect();
    const before = wrap.classList.contains('drop-above') || (!wrap.classList.contains('drop-below') && e.clientY < r.top + r.height / 2);
    wrap.classList.remove('drop-above', 'drop-below');
    e.preventDefault(); e.stopPropagation(); setDrag(null); reorderGroup(src, g.id, before);
  });
}

// §2 account & folder menus
const ORDER = { '\\Inbox': 0, '\\Drafts': 1, '\\Sent': 2, '\\Archive': 3, '\\Junk': 4, '\\Trash': 5 };
const parentOf = (acc, f) => { const d = f.delimiter || S.folders[acc]?.delimiter; const i = d ? f.path.lastIndexOf(d) : -1; return i > 0 ? f.path.slice(0, i) : ''; };

function flatLocal(acc) {
  const nodes = new Map(), roots = [], out = [];
  for (const f of folderList(acc)) nodes.set(f.path, { f, kids: [] });
  for (const n of nodes.values()) { const p = parentOf(acc, n.f); (p && nodes.has(p) ? nodes.get(p).kids : roots).push(n); }
  const walk = (list, depth) => {
    list.sort((a, b) => (ORDER[a.f.specialUse] ?? 9) - (ORDER[b.f.specialUse] ?? 9) || a.f.name.localeCompare(b.f.name, 'en'));
    for (const n of list) { out.push({ f: n.f, depth }); walk(n.kids, depth + 1); }
  };
  walk(roots, 0);
  return out;
}

export async function folderOp(fn, acc, okText) {
  try { await fn(); toast(okText, { kind: 'ok' }); }
  catch (e) { toast(e.message, { kind: 'err' }); }
  try {
    const res = await api.folders(acc);
    S.folders[acc] = { delimiter: res.delimiter, folders: res.folders || [] };
    emit('tree');
  } catch (e) { toast(e.message, { kind: 'err' }); }
  emit('foldersChanged', acc);
}

export function accountMenu(at, acc, onMoveGroup, onToggleAll) {
  const grpItems = (S.accountGroups || []).map(g => ({
    label: `Group: ${g.name}`, swatch: g.color, checked: acc.groupId === g.id,
    onClick: () => onMoveGroup(acc.id, acc.groupId === g.id ? null : g.id, null),
  }));
  openMenu(at, [
    { label: 'New folder', icon: 'folderAdd', onClick: () => newFolder(acc, '') },
    { label: 'Sync now', icon: 'sync', onClick: () => emit('sync', acc.id) },
    { label: 'Account settings', icon: 'settings', onClick: () => emit('openSettings', { tab: 'accounts', edit: acc.id }) },
    onToggleAll ? { sep: true } : null,
    onToggleAll ? { label: 'Expand all accounts', icon: 'chevDown', onClick: () => onToggleAll(true) } : null,
    onToggleAll ? { label: 'Collapse all accounts', icon: 'chevRight', onClick: () => onToggleAll(false) } : null,
    { sep: true },
    { label: 'Delete account', icon: 'delete', danger: true, onClick: () => confirmDeleteAccount(acc) },
    grpItems.length ? { sep: true } : null,
    ...grpItems,
  ]);
}

export function folderMenu(at, acc, f) {
  const special = !!f.specialUse;
  openMenu(at, [
    { label: 'New subfolder', icon: 'folderAdd', onClick: () => newFolder(acc, f.path) },
    !special && { label: 'Rename', icon: 'edit', onClick: () => renameFolder(acc, f) },
    !special && { label: 'Move', icon: 'move', onClick: () => moveFolderDialog(acc, f) },
    (f.specialUse === '\\Trash' || f.specialUse === '\\Junk') && { label: 'Empty folder', icon: 'broom', onClick: () => emptyFolder(acc.id, f.path) },
    !special && { sep: true },
    !special && { label: 'Delete folder', icon: 'delete', danger: true, onClick: () => deleteFolder(acc, f) },
  ]);
}

async function newFolder(acc, parent) {
  const name = await promptDialog({ title: 'New folder', label: parent ? `Subfolder in "${parent}"` : `Folder in ${acc.email}`, ok: 'Create' });
  if (name) folderOp(() => api.createFolder(acc.id, parent, name), acc.id, 'Folder created');
}

async function renameFolder(acc, f) {
  const name = await promptDialog({ title: 'Rename folder', label: 'New name', value: f.name, ok: 'Rename' });
  if (!name || name === f.name) return;
  await folderOp(() => api.renameFolder(acc.id, f.path, name), acc.id, 'Folder renamed');
  if (S.cur.account === acc.id && S.cur.folder === f.path) {
    const p = parentOf(acc.id, f);
    emit('openFolder', { account: acc.id, folder: p ? p + f.delimiter + name : name });
  }
}

async function moveFolderDialog(acc, f) {
  const dest = await pickFolder(acc.id, { title: `Move "${f.name}" to`, exclude: f.path, allowRoot: true });
  if (dest !== null) folderOp(() => api.moveFolder(acc.id, f.path, dest), acc.id, 'Folder moved');
}

async function deleteFolder(acc, f) {
  if (!(await confirmDialog(`Delete folder "${f.name}" and all its contents? This cannot be undone.`, { ok: 'Delete', danger: true }))) return;
  const wasCur = S.cur.account === acc.id && S.cur.folder === f.path;
  await folderOp(() => api.deleteFolder(acc.id, f.path), acc.id, 'Folder deleted');
  if (wasCur) emit('openFolder', { account: acc.id, folder: 'INBOX' });
}

export async function emptyFolder(account, path) {
  const f = folderByPath(account, path);
  if (!(await confirmDialog(`Empty "${folderTitle(f)}"? Messages will be permanently deleted.`, { ok: 'Empty', danger: true }))) return;
  await folderOp(() => api.emptyFolder(account, path), account, 'Folder emptied');
  if (S.cur.account === account && S.cur.folder === path) emit('reloadList');
}

export function pickFolder(acc, { title, exclude, allowRoot }) {
  return new Promise(resolve => {
    let done = false;
    const list = h('div', { class: 'pick-list' });
    const pick = (p, d) => { done = true; resolve(p); d.close(true); };
    const d = openDialog({ title, body: list, cls: 'small', onClose: () => { if (!done) resolve(null); }, buttons: [{ label: 'Cancel', onClick: x => x.close(true) }] });
    if (allowRoot) list.append(h('button', { class: 'pick-row', on: { click: () => pick('', d) } }, icon('account', 16), h('span', { text: accountById(acc)?.email || 'Root' })));
    for (const { f, depth } of flatLocal(acc)) {
      if (exclude && (f.path === exclude || f.path.startsWith(exclude + f.delimiter))) continue;
      if (!allowRoot && f.noselect) continue;
      list.append(h('button', { class: 'pick-row', style: { paddingLeft: (10 + depth * 16) + 'px' }, on: { click: () => pick(f.path, d) } },
        icon(folderIcon(f.specialUse), 16), h('span', { text: folderTitle(f) })));
    }
  });
}
