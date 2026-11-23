/* MAP
 * §1 targets and optimistic updates  L15-L83
 * §2 seen / unread                   L84-L110
 * §3 task / flag                     L111-L133
 * §4 categories                      L134-L144
 * §5 delete, archive, move           L145-L204
 * §6 block sender                    L205-L220
 */
// Message actions with optimistic UI updates across single, multi-account search, and local filtered targets.
import { S, LOCAL_ACC, isVirtualAcc, emit, folderByPath, folderByUse, msgKey, parseKey, filteredById } from './mail-state.js';
import { api } from './mail-api.js';
import { toast, confirmDialog } from './mail-ui.js';
import { debounce, isoDate, addDays, startOfWeek, startOfDay } from './mail-util.js';

// §1 targets and optimistic updates
// Group selected composite keys (acc|folder|uid) by account+folder so multi-account actions work cleanly.
export function allTargets(t) {
  if (t && Array.isArray(t.targets)) return t.targets;
  if (t && t.account && t.folder && Array.isArray(t.uids)) return [t];
  if (S.view === 'mail' && S.sel.size > 1) return groupKeys([...S.sel]);
  if (S.open) return [{ account: S.open.account, folder: S.open.folder, uids: [S.open.uid] }];
  if (S.sel.size) return groupKeys([...S.sel]);
  return [];
}

export function target(t) {
  return allTargets(t)[0] || null;
}

function groupKeys(keys) {
  const map = new Map();
  for (const k of keys) {
    const p = parseKey(k);
    const id = `${p.account}\0${p.folder}`;
    if (!map.has(id)) map.set(id, { account: p.account, folder: p.folder, uids: [] });
    map.get(id).uids.push(p.uid);
  }
  return [...map.values()];
}

const rowMatches = (it, t) => (it.account || S.cur.account) === t.account && (it.folder || S.cur.folder) === t.folder && t.uids.includes(it.uid);

function itemsFor(targets) {
  const out = [];
  for (const t of targets) {
    for (const it of S.list.items) if (rowMatches(it, t) && !out.includes(it)) out.push(it);
    if (S.msg && S.open && S.open.account === t.account && S.open.folder === t.folder && t.uids.includes(S.open.uid) && !out.includes(S.msg)) out.push(S.msg);
  }
  return out;
}

export const msgsOfTarget = t => itemsFor(allTargets(t));

async function optimistic(targets, patch, callEach, errPrefix) {
  if (!targets.length) return false;
  const list = itemsFor(targets);
  const snap = list.map(i => JSON.parse(JSON.stringify(i)));
  list.forEach(patch);
  syncOpenFromList(targets);
  emit('list'); emit('msg');
  try {
    await Promise.all(targets.map(callEach));
    refreshCounts();
    return true;
  } catch (e) {
    list.forEach((it, k) => Object.assign(it, snap[k]));
    syncOpenFromList(targets);
    emit('list'); emit('msg');
    toast(`${errPrefix}: ${e.message}`, { kind: 'err' });
    return false;
  }
}

function syncOpenFromList(targets) {
  if (!S.msg || !S.open) return;
  const tMatch = targets.some(t => t.account === S.open.account && t.folder === S.open.folder && t.uids.includes(S.open.uid));
  if (!tMatch) return;
  const it = S.list.items.find(i => (i.account || S.cur.account) === S.open.account && (i.folder || S.cur.folder) === S.open.folder && i.uid === S.msg.uid);
  if (it) for (const k of ['seen', 'flagged', 'task', 'categories', 'answered']) S.msg[k] = JSON.parse(JSON.stringify(it[k] ?? null));
}

export const refreshCounts = debounce(() => emit('refreshCounts'), 500);

// §2 seen / unread
export function setSeen(t, seen) {
  const ts = allTargets(t); if (!ts.length) return;
  if (!seen) emit('cancelPendingRead', ts);
  for (const g of ts) {
    if (isVirtualAcc(g.account)) continue;
    const f = folderByPath(g.account, g.folder);
    const listCount = S.list.items.filter(i => rowMatches(i, g) && i.seen !== seen).length;
    const delta = seen ? -listCount : listCount;
    if (f) f.unseen = Math.max(0, (f.unseen || 0) + delta);
    if ((g.folder.toUpperCase() === 'INBOX' || (f && f.specialUse === '\\Inbox')) && listCount) {
      const by = S.unread.byAccount || (S.unread.byAccount = {});
      by[g.account] = Math.max(0, (by[g.account] || 0) + delta);
      S.unread.total = Math.max(0, (S.unread.total || 0) + delta);
    }
  }
  return optimistic(ts, i => { i.seen = seen; },
    g => api.flags(g.account, g.folder, g.uids, seen ? ['\\Seen'] : [], seen ? [] : ['\\Seen']),
    'Could not update read state').then(r => { emit('tree'); return r; });
}

export function toggleSeen(t) {
  const ts = allTargets(t); if (!ts.length) return;
  const its = itemsFor(ts);
  return setSeen(ts[0] && ts.length === 1 ? ts[0] : t, its.some(i => !i.seen));
}

// §3 task / flag
export function setTask(t, task) {
  const ts = allTargets(t); if (!ts.length) return;
  return optimistic(ts, i => { i.task = task ? { ...task } : null; i.flagged = !!task; },
    g => api.meta({ account: g.account, folder: g.folder, uids: g.uids, task }),
    'Could not save flag').then(r => { if (r) emit('flaggedChanged'); return r; });
}

export function toggleFlag(t) {
  const ts = allTargets(t); if (!ts.length) return;
  const on = itemsFor(ts).some(i => i.flagged || (i.task && !i.task.done));
  return setTask(t, on ? null : { due: null, done: false });
}

export function quickDue(kind) {
  const today = startOfDay(new Date());
  if (kind === 'today') return isoDate(today);
  if (kind === 'tomorrow') return isoDate(addDays(today, 1));
  if (kind === 'thisWeek') { const fri = addDays(startOfWeek(today), 4); return isoDate(fri < today ? today : fri); }
  if (kind === 'nextWeek') return isoDate(addDays(startOfWeek(today), 7));
  return null;
}

// §4 categories
export function setCategory(t, id, on) {
  const ts = allTargets(t); if (!ts.length) return;
  return optimistic(ts, i => {
    const set = new Set(i.categories || []);
    if (on) set.add(id); else set.delete(id);
    i.categories = [...set];
  }, g => api.meta({ account: g.account, folder: g.folder, uids: g.uids, [on ? 'addCategory' : 'removeCategory']: id }),
  'Could not save category');
}

// §5 delete, archive, move
async function removeFromView(ts, callEach, okText, errPrefix) {
  emit('cancelPendingRead', ts);
  const removed = S.list.items.filter(i => ts.some(g => rowMatches(i, g)));
  const idx = S.open ? S.list.items.findIndex(i => (i.account || S.cur.account) === S.open.account && (i.folder || S.cur.folder) === S.open.folder && i.uid === S.open.uid) : -1;
  const openGone = !!S.open && ts.some(g => S.open.account === g.account && S.open.folder === g.folder && g.uids.includes(S.open.uid));
  if (removed.length) {
    S.list.items = S.list.items.filter(i => !removed.includes(i));
    S.list.total = Math.max(0, S.list.total - removed.length);
  }
  for (const g of ts) for (const u of g.uids) S.sel.delete(msgKey({ account: g.account, folder: g.folder, uid: u }));
  const next = openGone && idx >= 0 ? (S.list.items[idx] || S.list.items[idx - 1]) : null;
  emit('list');
  if (openGone) emit('removedOpen', next ? msgKey(next) : null);
  try {
    await Promise.all(ts.map(callEach));
    if (okText) toast(okText, { kind: 'ok', ms: 2500 });
    refreshCounts();
    emit('flaggedChanged');
    if (ts.some(g => g.account === LOCAL_ACC)) emit('filteredChanged');
    return true;
  } catch (e) {
    if (removed.length) { S.list.items = [...S.list.items, ...removed].sort((a, b) => new Date(b.date) - new Date(a.date)); S.list.total += removed.length; }
    emit('list');
    toast(`${errPrefix}: ${e.message}`, { kind: 'err' });
    return false;
  }
}

export async function deleteMessages(t, permanent) {
  const ts = allTargets(t); if (!ts.length) return;
  const anyPerm = permanent || ts.some(g => {
    if (g.account === LOCAL_ACC) return true;
    const f = folderByPath(g.account, g.folder);
    return f && f.specialUse === '\\Trash';
  });
  if (anyPerm) {
    const n = ts.reduce((s, g) => s + g.uids.length, 0);
    if (!(await confirmDialog(n > 1 ? `Permanently delete ${n} messages?` : 'Permanently delete this message?', { ok: 'Delete permanently', danger: true }))) return;
    permanent = true;
  }
  return removeFromView(ts, g => api.remove(g.account, g.folder, g.uids, permanent || g.account === LOCAL_ACC),
    permanent ? 'Message deleted permanently' : 'Moved to Trash', 'Delete failed');
}

export function archiveMessages(t) {
  const ts = allTargets(t).filter(g => g.account !== LOCAL_ACC);
  if (!ts.length) return;
  return removeFromView(ts, g => api.archive(g.account, g.folder, g.uids), 'Archived', 'Archive failed');
}

export function moveMessages(t, dest, destAccount) {
  const ts = allTargets(t); if (!ts.length || !dest) return;
  const filtered = ts.filter(g => !(g.folder === dest && (destAccount || g.account) === g.account));
  if (!filtered.length) return;
  const label = destAccount === LOCAL_ACC ? (filteredById(dest)?.name || dest) : (folderByPath(destAccount || filtered[0].account, dest)?.name || dest);
  return removeFromView(filtered, g => api.move(g.account, g.folder, g.uids, dest, destAccount), `Moved to "${label}"`, 'Move failed')
    .then(ok => { if (ok && destAccount === LOCAL_ACC) emit('filteredChanged'); return ok; });
}

// §6 block sender
export async function blockSender(t) {
  const ts = allTargets(t); if (!ts.length) return;
  const it = itemsFor(ts)[0];
  const addr = it && it.from && it.from.address;
  if (!addr) return;
  const ok = await confirmDialog(`Block sender ${addr}? Future messages from this address will move automatically to Trash, and the selected messages will be deleted now.`, { ok: 'Block', danger: true });
  if (!ok) return;
  try {
    const res = await api.quickRule({ kind: 'blockSender', value: addr, action: 'delete' });
    if (res && res.duplicate) toast(`Sender ${addr} already has a block rule.`, { kind: 'info' });
    else { emit('rulesChanged'); toast(`Sender ${addr} blocked (new rule created).`, { kind: 'ok' }); }
  } catch (e) { toast('Block failed: ' + e.message, { kind: 'err' }); return; }
  const toDelete = ts.filter(g => { const tr = folderByUse(g.account, '\\Trash'); return !tr || tr.path !== g.folder; });
  if (toDelete.length) await removeFromView(toDelete, g => api.remove(g.account, g.folder, g.uids, g.account === LOCAL_ACC), null, 'Delete failed');
}
