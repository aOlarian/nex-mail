/* MAP
 * §1 shared action menus (move, categories, task)  L13-L84
 */
// Shared menus used by the reader toolbar and message context menu (command bar removed per layout v2).
import { isoDate } from './mail-util.js';
import { S, LOCAL_ACC, isVirtualAcc, emit, folderTitle } from './mail-state.js';
import { api } from './mail-api.js';
import { openMenu, promptDialog, toast } from './mail-ui.js';
import { flatFolders } from './mail-tree.js';
import { target, allTargets, msgsOfTarget, moveMessages, setCategory, setTask, quickDue } from './mail-actions.js';
import { PALETTE } from './mail-editor.js';

// §1 shared action menus (move, categories, task)
export function moveMenu(anchor, t) {
  const ts = allTargets(t);
  t = ts[0] || target(t); if (!t) return;
  const items = [];
  const sameImap = ts.length > 0 && !isVirtualAcc(t.account) && ts.every(x => x.account === t.account);
  const passTarget = ts.length > 1 ? { targets: ts } : t;
  if (sameImap) {
    for (const { f, depth } of flatFolders(t.account)) {
      if (f.noselect || (ts.length === 1 && f.path === t.folder)) continue;
      items.push({ label: folderTitle(f), icon: 'folder', indent: depth, onClick: () => moveMessages(passTarget, f.path) });
    }
  } else if (t.account === LOCAL_ACC && ts.length === 1) {
    const fallbackAcc = S.accounts[0]?.id;
    if (fallbackAcc) {
      for (const { f, depth } of flatFolders(fallbackAcc)) {
        if (f.noselect) continue;
        items.push({ label: folderTitle(f), icon: 'folder', indent: depth, onClick: () => moveMessages(t, f.path, fallbackAcc) });
      }
    }
  } else {
    items.push({ header: 'Select messages from one account to move to IMAP folders' });
  }
  if (S.filteredFolders.length) {
    if (items.length) items.push({ sep: true });
    items.push({ header: 'Filtered (local)' });
    for (const ff of S.filteredFolders) {
      if (t.account === LOCAL_ACC && t.folder === ff.id && ts.length === 1) continue;
      items.push({ label: ff.name, swatch: ff.color, onClick: () => moveMessages(passTarget, ff.id, LOCAL_ACC) });
    }
  }
  openMenu(anchor, [{ header: 'Move to' }, ...items]);
}

export function categoriesMenu(anchor, t) {
  t = t || target(); if (!t) return;
  const its = msgsOfTarget(t);
  const has = id => its.length > 0 && its.every(i => (i.categories || []).includes(id));
  openMenu(anchor, [
    ...S.categories.map(c => ({ label: c.name, swatch: c.color, checked: has(c.id), onClick: () => setCategory(t, c.id, !has(c.id)) })),
    S.categories.length ? { sep: true } : null,
    { label: 'New Category...', icon: 'plus', onClick: () => newCategory(t) },
    { label: 'Manage Categories', icon: 'settings', onClick: () => emit('openSettings', { tab: 'categories' }) },
  ]);
}

async function newCategory(t) {
  const name = await promptDialog({ title: 'New Category', label: 'Category name', ok: 'Create' });
  if (!name) return;
  const color = PALETTE[(S.categories.length * 5 + 3) % 12];
  try {
    S.categories = await api.saveCategories([...S.categories, { name, color }]);
    const c = S.categories.find(x => x.name === name);
    emit('categories');
    if (c && t) setCategory(t, c.id, true);
  } catch (e) { toast(e.message, { kind: 'err' }); }
}

export function taskMenu(anchor, t) {
  t = t || target(); if (!t) return;
  const set = due => setTask(t, { due, done: false });
  const its = msgsOfTarget(t);
  const any = its.some(i => i.flagged || i.task);
  openMenu(anchor, [
    { label: 'Today', icon: 'flag', onClick: () => set(quickDue('today')) },
    { label: 'Tomorrow', icon: 'flag', onClick: () => set(quickDue('tomorrow')) },
    { label: 'This Week', icon: 'flag', onClick: () => set(quickDue('thisWeek')) },
    { label: 'Next Week', icon: 'flag', onClick: () => set(quickDue('nextWeek')) },
    { label: 'No Date', icon: 'flag', onClick: () => set(null) },
    { label: 'Custom Date...', icon: 'calendar', onClick: async () => {
      const d = await promptDialog({ title: 'Due Date', label: 'Date', type: 'date', value: isoDate(new Date()), ok: 'Set' });
      if (d) set(d);
    } },
    any ? { sep: true } : null,
    any ? { label: 'Mark Complete', icon: 'check', onClick: () => setTask(t, { due: (its[0].task || {}).due || null, done: true }) } : null,
    any ? { label: 'Clear Flag', icon: 'close', onClick: () => setTask(t, null) } : null,
  ]);
}
