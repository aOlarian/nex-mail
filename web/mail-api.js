/* MAP
 * §1 transport  L7-L48
 * §2 rute  L49-L106
 */
// HTTP client for /api/mail/*.

// §1 transport
const BASE = '/api/mail/';

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function req(method, path, body) {
  let r;
  try {
    r = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError('Mail service is unreachable. Check your connection and try again.', 0);
  }
  const ct = r.headers.get('content-type') || '';
  let data = null;
  if (ct.includes('json')) {
    try { data = await r.json(); } catch (e) { data = null; /* invalid JSON handled below */ }
  } else {
    data = await r.text();
  }
  if (!r.ok) {
    const msg = (data && (data.eroare || data.error)) || (r.status === 401 ? 'Session expired. Sign in to Nex again.' : `Server error (${r.status}).`);
    throw new ApiError(msg, r.status);
  }
  return data;
}

const get = (path, q) => req('GET', path + (q ? '?' + new URLSearchParams(clean(q)) : ''));
const post = (path, body) => req('POST', path, body || {});
const listOf = (r, key) => (Array.isArray(r) ? r : (r && r[key]) || []);
function clean(q) {
  const o = {};
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') o[k] = String(v);
  return o;
}

// §2 rute
export const api = {
  state: () => get('state'),
  unread: () => get('unread'),
  saveSettings: s => post('settings', s),
  saveCategories: categories => post('categories', { categories }).then(r => listOf(r, 'categories')),
  saveSignatures: signatures => post('signatures', { signatures }).then(r => listOf(r, 'signatures')),
  saveAccountGroups: groups => post('account-groups', { groups }).then(r => listOf(r, 'accountGroups')),

  autoconfig: email => post('accounts/autoconfig', { email }),
  testAccount: acc => post('accounts/test', acc),
  saveAccount: acc => post('accounts/save', acc),
  reorderAccounts: order => post('accounts/reorder', { order }).then(r => listOf(r, 'accounts')),
  deleteAccount: id => post('accounts/delete', { id }),

  folders: (account, fresh) => get('folders', fresh ? { account, fresh: 1 } : { account }),
  createFolder: (account, parent, name) => post('folders/create', { account, parent, name }),
  renameFolder: (account, path, name) => post('folders/rename', { account, path, name }),
  moveFolder: (account, path, parent) => post('folders/move', { account, path, parent }),
  deleteFolder: (account, path) => post('folders/delete', { account, path }),
  emptyFolder: (account, path) => post('folders/empty', { account, path }),

  filteredFolders: () => get('filtered/folders').then(r => listOf(r, 'folders')),
  saveFilteredFolders: body => post('filtered/folders', body).then(r => listOf(r, 'folders')),

  messages: q => get('messages', q),
  flagged: size => get('flagged', { size: size || 100 }),
  message: (account, folder, uid) => get('message', { account, folder, uid }),
  source: (account, folder, uid) => get('source', { account, folder, uid }),
  flags: (account, folder, uids, add, remove) => post('flags', { account, folder, uids, add: add || [], remove: remove || [] }),
  move: (account, folder, uids, dest, destAccount) => post('move', { account, folder, uids, dest, ...(destAccount ? { destAccount } : {}) }),
  remove: (account, folder, uids, permanent) => post('delete', { account, folder, uids, permanent: !!permanent }),
  archive: (account, folder, uids) => post('archive', { account, folder, uids }),
  meta: body => post('meta', body),
  tasks: done => get('tasks', { done: done ? 1 : 0 }),
  contacts: q => get('contacts', { q }),

  send: body => post('send', body),
  draft: body => post('draft', body),

  rules: () => get('rules'),
  saveRules: rules => post('rules', { rules }).then(r => listOf(r, 'rules')),
  runRules: body => post('rules/run', body),
  quickRule: body => post('rules/quick', body),

  calendar: (from, to, includePending) => get('calendar', { from: from.toISOString(), to: to.toISOString(), ...(includePending ? { includePending: 1 } : {}) }),
  calendarReplyTarget: id => get('calendar/reply-target', { id }),
  calendarRespond: body => post('calendar/respond', body),
  saveEvent: event => post('calendar/save', { event }),
  deleteEvent: id => post('calendar/delete', { id }),
  eventFromMessage: (account, folder, uid, index) => post('calendar/from-message', { account, folder, uid, index }),

  sync: account => post('sync', account ? { account } : {}),
};

export function attachmentUrl(account, folder, uid, part, inline) {
  const q = new URLSearchParams({ account, folder, uid: String(uid), part: String(part) });
  if (inline) q.set('inline', '1');
  return '/api/mail/attachment?' + q;
}
