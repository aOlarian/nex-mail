/* MAP
 * §1 message right-click menu            L14-L108
 * §2 helper dispatchers (reply, search)  L109-L153
 * §3 group right-click menu              L154-L172
 */
// Custom right-click context menu on message rows: Reply, Reply All, Mark colors, Forward, Read/Unread, Find related, AutoFilter, Delete.
import { S, LOCAL_ACC, ALL_INBOXES_ACC, emit, msgKey } from './mail-state.js';
import { api } from './mail-api.js';
import { openMenu, toast } from './mail-ui.js';
import { setSeen, setCategory, deleteMessages, allTargets } from './mail-actions.js';
import { moveMenu } from './mail-commands.js';
import { openCustomFilterModal, runAllFiltersNow } from './mail-filters.js';

// §1 message right-click menu
export function buildAutoFilterSub(list) {
  const items = (Array.isArray(list) ? list : [list]).filter(Boolean);
  const uniq = fn => {
    const seen = new Set(), out = [];
    for (const m of items) {
      const v = String(fn(m) || '').trim(), k = v.toLowerCase();
      if (v && !seen.has(k)) { seen.add(k); out.push(v); }
    }
    return out;
  };
  const subjVals = uniq(m => m.subject);
  const senderVals = uniq(m => m.from && m.from.address);
  const domainVals = uniq(m => {
    const a = String((m.from && m.from.address) || '').trim();
    const at = a.lastIndexOf('@');
    return at >= 0 && a.slice(at + 1).trim() ? `*@${a.slice(at + 1).trim().toLowerCase()}` : '';
  });
  const quickActions = (kind, values) => [
    { label: 'Delete', icon: 'delete', danger: true, onClick: () => applyQuick(kind, values, 'delete') },
    { sep: true },
    ...S.filteredFolders.map(ff => ({
      label: ff.name, swatch: ff.color,
      onClick: () => applyQuick(kind, values, 'moveLocal', ff.id, ff.name),
    })),
  ];
  const quickSub = [
    subjVals.length ? { label: subjVals.length > 1 ? `Subject (${subjVals.length})` : 'Subject', icon: 'edit', sub: quickActions('quickSubject', subjVals) } : null,
    senderVals.length ? { label: senderVals.length > 1 ? `Sender (${senderVals.length})` : 'Sender', icon: 'person', sub: quickActions('quickSender', senderVals) } : null,
    domainVals.length ? { label: domainVals.length > 1 ? `Domain (${domainVals.length})` : 'Domain', icon: 'globe', sub: quickActions('quickDomain', domainVals) } : null,
  ].filter(Boolean);
  return [
    { label: 'Quick', icon: 'play', sub: quickSub },
    { label: 'Custom...', icon: 'settings', onClick: () => openCustomFilterModal(items.length > 1 ? items : items[0]) },
  ];
}

export function openMessageContextMenu(e, it, selectFn) {
  e.preventDefault();
  e.stopPropagation();
  const key = msgKey(it);
  if (!S.sel.has(key) && selectFn) selectFn(key);

  const acc = it.account || S.cur.account;
  const folder = it.folder || S.cur.folder;
  const singleTarget = { account: acc, folder, uids: [it.uid] };
  const actTarget = S.sel.size > 1 && S.sel.has(key) ? { targets: allTargets() } : singleTarget;

  const hasCat = id => (it.categories || []).includes(id);
  const markItems = [
    ...S.categories.map(c => ({
      label: c.name, swatch: c.color, checked: hasCat(c.id),
      onClick: () => setCategory(actTarget, c.id, !hasCat(c.id)),
    })),
    it.categories && it.categories.length ? { sep: true } : null,
    it.categories && it.categories.length ? {
      label: 'Clear labels', icon: 'close',
      onClick: async () => { for (const cid of [...(it.categories || [])]) await setCategory(actTarget, cid, false); },
    } : null,
    { label: 'Manage Categories...', icon: 'settings', onClick: () => emit('openSettings', { tab: 'categories' }) },
  ];

  const fromAddr = it.from && it.from.address || '';
  const fromName = it.from && it.from.name || fromAddr;
  const cleanSubj = String(it.subject || '').replace(/^(re|fw|fwd)\s*:\s*/i, '').trim();

  const relatedItems = [
    fromAddr ? { label: `From sender (${fromAddr})`, icon: 'user', onClick: () => searchRelated(fromAddr) } : null,
    cleanSubj ? { label: `Same subject`, icon: 'mail', onClick: () => searchRelated(cleanSubj) } : null,
  ].filter(Boolean);

  const selectedItems = (S.sel.size > 1 && S.sel.has(key))
    ? S.list.items.filter(x => S.sel.has(msgKey(x)))
    : [it];
  const autoFilterSub = buildAutoFilterSub(selectedItems);

  const isLocal = acc === LOCAL_ACC;
  const crossFolder = (S.cur.account === ALL_INBOXES_ACC || (S.list.q && S.list.scope !== 'folder')) && !isLocal;
  const items = [
    !isLocal ? { label: 'Reply', icon: 'reply', onClick: () => replyToItem(it, 'reply') } : null,
    !isLocal ? { label: 'Reply All', icon: 'replyAll', onClick: () => replyToItem(it, 'replyAll') } : null,
    { label: 'Mark', icon: 'tag', sub: markItems },
    { label: 'Forward', icon: 'forward', onClick: () => replyToItem(it, 'forward') },
    { sep: true },
    !isLocal ? { label: it.seen ? 'Mark as Unread' : 'Mark as Read', icon: it.seen ? 'mail' : 'mailOpen', onClick: () => setSeen(actTarget, !it.seen) } : null,
    !isLocal ? { label: 'Move to...', icon: 'move', onClick: () => moveMenu({ x: e.clientX, y: e.clientY }, actTarget) } : null,
    crossFolder ? { label: 'Open original folder', icon: 'folder', onClick: () => emit('openFolder', { account: acc, folder }) } : null,
    relatedItems.length ? { label: 'Find related', icon: 'search', sub: relatedItems } : null,
    { label: 'AutoFilter', icon: 'rules', sub: autoFilterSub },
    { sep: true },
    { label: 'Delete', icon: 'delete', danger: true, onClick: () => deleteMessages(actTarget) },
  ];

  openMenu({ x: e.clientX, y: e.clientY }, items);
}

// §2 helper dispatchers (reply, search)
async function replyToItem(it, mode) {
  const acc = it.account || S.cur.account;
  const folder = it.folder || S.cur.folder;
  try {
    const full = (S.msg && S.open && S.open.account === acc && S.open.folder === folder && S.open.uid === it.uid)
      ? S.msg
      : await api.message(acc, folder, it.uid);
    emit('compose', { mode, msg: full, ref: { account: acc, folder, uid: it.uid } });
  } catch (e) {
    toast('Could not open message for compose: ' + e.message, { kind: 'err' });
  }
}

function searchRelated(q) {
  emit('setSearch', { q, scope: 'everywhere' });
}

async function applyQuick(kind, values, action, dest, label) {
  const list = Array.isArray(values) ? values.filter(Boolean) : (values ? [values] : []);
  if (!list.length) { toast('Nothing to filter on selected messages.', { kind: 'err' }); return; }
  try {
    const created = [], dups = [], runIds = [];
    for (const value of list) {
      const res = await api.quickRule({ kind, value, action, dest });
      const id = res && (res.id || (res.rule && res.rule.id));
      if (id) runIds.push(id);
      if (res && res.duplicate) dups.push(value);
      else if (id) created.push(id);
    }
    if (created.length) emit('rulesChanged');
    const targetLbl = action === 'delete' ? 'Delete' : label;
    if (!created.length && dups.length) {
      toast(`AutoFilter already exists (${targetLbl}).`, { kind: 'info' });
    } else if (dups.length) {
      toast(`AutoFilter created (${created.length} ${created.length === 1 ? 'rule' : 'rules'} -> ${targetLbl}; ${dups.length} duplicate skipped).`, { kind: 'ok' });
    } else {
      toast(`AutoFilter created (${created.length} ${created.length === 1 ? 'rule' : 'rules'} -> ${targetLbl}).`, { kind: 'ok' });
    }
    if (runIds.length) await runAllFiltersNow(runIds);
  } catch (e) {
    toast('Could not create AutoFilter: ' + e.message, { kind: 'err' });
  }
}

// §3 group right-click menu
export function openGroupContextMenu(e, { grp, items, key, collapsed, allKeys, collapsedGroups, redraw, onSelect }) {
  e.preventDefault();
  e.stopPropagation();
  const grpTargets = [...items.reduce((m, it) => {
    const a = it.account || S.cur.account, f = it.folder || S.cur.folder, k = `${a}\0${f}`;
    if (!m.has(k)) m.set(k, { account: a, folder: f, uids: [] });
    m.get(k).uids.push(it.uid);
    return m;
  }, new Map()).values()];
  openMenu({ x: e.clientX, y: e.clientY }, [
    { label: collapsed ? 'Expand group' : 'Collapse group', icon: collapsed ? 'chevDown' : 'chevRight', onClick: () => { if (collapsed) collapsedGroups.delete(key); else collapsedGroups.add(key); redraw(); } },
    { label: 'Expand all groups', icon: 'chevDown', onClick: () => { collapsedGroups.clear(); redraw(); } },
    { label: 'Collapse all groups', icon: 'chevRight', onClick: () => { allKeys.forEach(k => collapsedGroups.add(k)); redraw(); } },
    { sep: true },
    { label: `Select all in "${grp}" (${items.length})`, icon: 'check', onClick: onSelect },
    { label: `AutoFilter "${grp}"`, icon: 'rules', sub: buildAutoFilterSub(items) },
    { label: `Delete all in "${grp}" (${items.length})`, icon: 'delete', danger: true, onClick: () => deleteMessages({ targets: grpTargets }) },
  ]);
}
