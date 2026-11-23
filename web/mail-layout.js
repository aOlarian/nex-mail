/* MAP
 * §1 icoane din HTML (data-icon)  L13-L17
 * §2 separatoare redimensionabile (latimi in localStorage)  L18-L56
 * §3 cautare si scopuri Outlook  L57-L134
 * §4 telefon si layout  L135-L186
 */
// Frame, static icons, resizable splitters, Outlook search bar, header nav, and mobile panes.
import { $, $$, h, debounce } from './mail-util.js';
import { icon } from './mail-icons.js';
import { S, emit, store } from './mail-state.js';
import { openMenu, promptDialog } from './mail-ui.js';

// §1 icoane din HTML (data-icon)
function fillIcons() {
  for (const el of $$('[data-icon]')) el.prepend(icon(el.dataset.icon, Number(el.dataset.size) || 18));
}

// §2 separatoare redimensionabile (latimi in localStorage)
const LIMITS = { side: ['--side-w', 180, 420], list: ['--list-w', 280, 760], listH: ['--list-h', 140, 900], right: ['--right-w', 240, 440] };

function applySizes() {
  const sz = store.get('sizes', {});
  for (const [k, [v]] of Object.entries(LIMITS)) if (sz[k]) document.documentElement.style.setProperty(v, sz[k] + 'px');
}

function initSplitters() {
  for (const sp of $$('.splitter')) {
    sp.setAttribute('role', 'separator');
    sp.setAttribute('aria-label', 'Resize panel');
    sp.addEventListener('pointerdown', e => {
      const kind = sp.dataset.split === 'list' && document.documentElement.dataset.pane === 'bottom' ? 'listH' : sp.dataset.split;
      const [cssVar, min, max] = LIMITS[kind];
      const target = kind === 'side' ? $('#side') : kind === 'right' ? $('#rightbar') : $('#listpane');
      const r = target.getBoundingClientRect();
      const start = kind === 'listH' ? e.clientY : e.clientX;
      const base = kind === 'listH' ? r.height : r.width;
      const sign = kind === 'right' ? -1 : 1;
      sp.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing');
      let val = base;
      const move = ev => {
        val = Math.round(Math.min(max, Math.max(min, base + sign * ((kind === 'listH' ? ev.clientY : ev.clientX) - start))));
        document.documentElement.style.setProperty(cssVar, val + 'px');
      };
      const up = () => {
        sp.removeEventListener('pointermove', move);
        document.body.classList.remove('resizing');
        store.set('sizes', { ...store.get('sizes', {}), [kind]: val });
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up, { once: true });
      sp.addEventListener('pointercancel', up, { once: true });
    });
  }
}

// §3 cautare si scopuri Outlook
const PLACEHOLDERS = {
  folder: 'Search current folder',
  mailbox: 'Search current mailbox',
  inboxes: 'Search all Inboxes',
  sent: 'Search Sent folders',
  everywhere: 'Search everywhere',
};

function updateSearchUi() {
  const q = $('#q'), scopeSel = $('#search-scope'), sentBtn = $('#search-sent');
  if (scopeSel) scopeSel.value = S.list.scope || 'folder';
  if (q) q.placeholder = PLACEHOLDERS[S.list.scope] || PLACEHOLDERS.folder;
  if (sentBtn) {
    sentBtn.hidden = S.list.scope !== 'sent';
    sentBtn.textContent = S.list.sentName || 'Sent';
  }
}

function initSearch() {
  const form = $('#search'), q = $('#q'), scopeSel = $('#search-scope'), sentBtn = $('#search-sent');
  S.list.inBody = store.get('searchBody', false);
  S.list.scope = store.get('searchScope', 'folder');
  S.list.sentName = store.get('sentName', 'Sent');
  updateSearchUi();

  const trigger = debounce(val => {
    if (val === S.list.q) return;
    emit('search', val);
  }, 260);

  form.addEventListener('submit', e => {
    e.preventDefault();
    const v = q.value.trim();
    emit('search', v, true);
  });
  q.addEventListener('input', () => {
    const v = q.value.trim();
    if (!v && S.list.q) emit('search', '');
    else if (v) trigger(v);
  });
  q.addEventListener('search', () => {
    const v = q.value.trim();
    if (!v && S.list.q) emit('search', '');
  });
  scopeSel.addEventListener('change', () => {
    S.list.scope = scopeSel.value;
    store.set('searchScope', S.list.scope);
    updateSearchUi();
    emit('search', q.value.trim(), true);
  });
  sentBtn.addEventListener('click', async () => {
    const val = await promptDialog({
      title: 'Sent Folder Name',
      message: 'Enter folder name to match across all accounts (including subfolders recursively):',
      value: S.list.sentName || 'Sent',
      confirmText: 'Apply',
    });
    if (!val) return;
    S.list.sentName = val.trim() || 'Sent';
    store.set('sentName', S.list.sentName);
    updateSearchUi();
    emit('search', q.value.trim(), true);
  });
  $('#search-opt').addEventListener('click', e => openMenu(e.currentTarget, [
    { label: 'Also search message body', checked: S.list.inBody, onClick: () => { S.list.inBody = !S.list.inBody; store.set('searchBody', S.list.inBody); if (S.list.q) emit('search', S.list.q, true); } },
  ]));
}

export function setSearchText(v, scope) {
  if (scope) {
    S.list.scope = scope;
    store.set('searchScope', scope);
  }
  $('#q').value = v;
  updateSearchUi();
}

// §4 telefon si layout
const mq = window.matchMedia('(max-width: 759px)');
export function setMobilePane(p) {
  S.mobilePane = p;
  $('#app').dataset.mpane = p;
}
function onMq() {
  S.mobile = mq.matches;
  document.documentElement.classList.toggle('is-mobile', S.mobile);
  emit('mobile', S.mobile);
}

export function syncRightbarState() {
  const open = S.rightOpen !== false;
  $('#app').dataset.right = open ? 'open' : 'closed';
  const btn = $('#btn-rightbar');
  if (btn) btn.classList.toggle('active', open);
}

export function initLayout() {
  fillIcons();
  applySizes();
  initSplitters();
  initSearch();
  S.rightOpen = store.get('rightOpen', true);
  syncRightbarState();
  mq.addEventListener('change', onMq);
  onMq();
  setMobilePane('list');
  $('#btn-menu').addEventListener('click', () => setMobilePane(S.mobilePane === 'side' ? 'list' : 'side'));
  $('#scrim').addEventListener('click', () => setMobilePane('list'));
  $('#btn-compose').addEventListener('click', () => emit('compose', { mode: 'new' }));
  $('#btn-rightbar').addEventListener('click', () => {
    S.rightOpen = !S.rightOpen;
    store.set('rightOpen', S.rightOpen);
    syncRightbarState();
    emit('rightbarToggle', S.rightOpen);
  });
  $('#btn-sync').addEventListener('click', () => emit('sync'));
  $('#btn-settings').addEventListener('click', () => emit('openSettings'));
  for (const b of $$('.rail [data-view]')) b.addEventListener('click', () => emit('view', b.dataset.view));
}

export function markRail(view) {
  for (const b of $$('.rail [data-view]')) {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
}
