/* MAP
 * §1 stare  L9-L44
 * §2 magistrala de evenimente  L45-L57
 * §3 preferinte locale  L58-L74
 * §4 interogari ajutatoare  L75-L119
 */
// App state, event bus, and local preferences (localStorage).

// §1 stare
export const LOCAL_ACC = '__local__';
export const ALL_INBOXES_ACC = '__all_inboxes__';
export const isVirtualAcc = id => id === LOCAL_ACC || id === ALL_INBOXES_ACC;

export const S = {
  user: '',
  accounts: [],
  accountGroups: [],
  filteredFolders: [],
  settings: {},
  categories: [],
  signatures: [],
  unread: { total: 0, byAccount: {} },
  folders: {},
  view: 'mail',
  cur: { account: null, folder: null },
  list: {
    items: [], total: 0, page: 0,
    filter: 'all', filters: new Set(),
    sortBy: 'date', sortDir: 'desc', groupBy: 'none',
    groupByCount: false,
    inboxesSubfolders: true,
    scope: 'folder', sentName: 'Sent',
    q: '', inBody: false, loading: false, error: null, more: false,
  },
  sel: new Set(),
  anchor: null,
  open: null,
  msg: null,
  compose: null,
  rightOpen: true,
  mobile: false,
  mobilePane: 'list',
};

// §2 magistrala de evenimente
const handlers = new Map();
export function on(ev, fn) {
  if (!handlers.has(ev)) handlers.set(ev, new Set());
  handlers.get(ev).add(fn);
  return () => handlers.get(ev).delete(fn);
}
export function emit(ev, data) {
  for (const fn of handlers.get(ev) || []) {
    try { fn(data); } catch (e) { console.warn('[mail] handler', ev, e); }
  }
}

// §3 preferinte locale
const PREFIX = 'nexmail.';
export const store = {
  get(key, def) {
    try {
      const v = localStorage.getItem(PREFIX + key);
      return v == null ? def : JSON.parse(v);
    } catch (e) { return def; /* localStorage unavailable or corrupt: return default */ }
  },
  set(key, val) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(val)); }
    catch (e) { console.warn('[mail] localStorage', e); }
  },
};
S.list.groupByCount = store.get('groupByCount', false);
S.list.inboxesSubfolders = store.get('inboxesSubfolders', true);

// §4 interogari ajutatoare
export const msgKey = it => `${it.account || S.cur.account}|${it.folder || S.cur.folder}|${it.uid}`;
export const parseKey = k => {
  const i = String(k).indexOf('|'), j = String(k).lastIndexOf('|');
  return { account: k.slice(0, i), folder: k.slice(i + 1, j), uid: Number(k.slice(j + 1)) };
};
export const accountById = id => S.accounts.find(a => a.id === id) || null;
export const curAccount = () => accountById(S.cur.account);
export const folderList = acc => (S.folders[acc] && S.folders[acc].folders) || [];
export const folderByPath = (acc, path) => folderList(acc).find(f => f.path === path) || null;
export const folderByUse = (acc, use) => folderList(acc).find(f => f.specialUse === use) || null;
export const curFolder = () => S.cur.account === LOCAL_ACC
  ? (S.filteredFolders.find(f => f.id === S.cur.folder) || null)
  : folderByPath(S.cur.account, S.cur.folder);
export const filteredById = id => S.filteredFolders.find(f => f.id === id) || null;
export const categoryById = id => S.categories.find(c => c.id === id) || null;
export const signatureById = id => S.signatures.find(s => s.id === id) || null;
export const ownAddresses = () => new Set(S.accounts.map(a => String(a.email).toLowerCase()));
const NON_INBOX_USE = new Set(['\\Trash', '\\Junk', '\\Drafts', '\\Sent', '\\Archive']);
export function inboxUnread(acc, withSubfolders = false) {
  const info = S.folders[acc];
  if (!info || !Array.isArray(info.folders)) return (S.unread?.byAccount?.[acc]) || 0;
  const delim = info.delimiter || '/';
  const pref = 'INBOX' + delim.toUpperCase();
  let sum = 0;
  for (const f of info.folders) {
    if (f.noselect || NON_INBOX_USE.has(f.specialUse)) continue;
    const up = String(f.path || '').toUpperCase();
    if (f.specialUse === '\\Inbox' || up === 'INBOX' || (withSubfolders && up.startsWith(pref))) sum += f.unseen || 0;
  }
  return sum;
}
export const itemByKey = k => S.list.items.find(i => msgKey(i) === k) || null;
export const itemByUid = uid => S.list.items.find(i => i.uid === uid) || null;
export const selectedItems = () => [...S.sel].map(itemByKey).filter(Boolean);

export const SPECIAL_NAMES = {
  '\\Inbox': 'Inbox', '\\Sent': 'Sent', '\\Drafts': 'Drafts',
  '\\Trash': 'Trash', '\\Junk': 'Spam', '\\Archive': 'Archive',
};
export function folderTitle(f) {
  if (!f) return '';
  if (!f.path) return f.name || '';
  const top = !f.path.includes(f.delimiter || '\u0000');
  return (top && SPECIAL_NAMES[f.specialUse]) || f.name;
}

export function groupAccountsByCategory() {
  const buckets = [], used = new Set();
  for (const g of S.accountGroups || []) {
    const items = S.accounts.filter(a => a.groupId === g.id);
    if (!items.length) continue;
    items.forEach(a => used.add(a.id));
    buckets.push({ id: g.id, name: g.name, color: g.color || '#0078d4', items });
  }
  const rest = S.accounts.filter(a => !used.has(a.id));
  if (rest.length) buckets.push({ id: '', name: buckets.length ? 'Other accounts' : 'Mailboxes', color: '', items: rest });
  return buckets;
}
