/* MAP
 * §1 appearance vars (:root[data-theme]) L21-L43
 * §2 settings modal & tabs               L44-L67
 * §3 appearance tab                      L68-L103
 * §4 categories tab                      L104-L130
 * §5 all inboxes tab                     L131-L192
 */
// Settings dialog: Accounts, All Inboxes, Signatures, Categories, Filters, Rules, Appearance.
import { h, clear } from './mail-util.js';
import { icon } from './mail-icons.js';
import { S, emit, groupAccountsByCategory } from './mail-state.js';
import { api } from './mail-api.js';
import { openDialog, openMenu, confirmDialog, toast, field, selectEl } from './mail-ui.js';
import { PALETTE } from './mail-editor.js';
import { renderAccountsTab } from './mail-accounts.js';
import { renderRulesTab } from './mail-rules.js';
import { renderSignatures } from './mail-signatures.js';
import { renderFiltersView } from './mail-filters.js';
import { CLASSIC_THEMES, NEX_THEMES, applyThemeVars } from './mail-themes.js';

// §1 appearance vars (:root[data-theme])
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
export function applyAppearance() {
  const st = S.settings || {}, root = document.documentElement;
  applyThemeVars(st.theme || 'light', root, darkMq.matches);
  root.dataset.density = st.density === 'compact' ? 'compact' : 'comfortable';
  root.dataset.fontSize = st.fontSize || 'normal';
  root.dataset.pane = st.readingPane === 'bottom' ? 'bottom' : 'right';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue('--topbar').trim() || '#0f6cbd';
}
darkMq.addEventListener('change', () => { if (S.settings.theme === 'system') applyAppearance(); });
try { if (window.parent && window.parent !== window) window.parent.addEventListener('nex-theme-change', () => { if (S.settings.theme === 'nex') applyAppearance(); }); } catch (e) { /* cross-origin */ }

export async function saveSetting(key, value) {
  const prev = S.settings[key];
  S.settings = { ...S.settings, [key]: value };
  applyAppearance();
  emit('settings');
  try { S.settings = { ...S.settings, ...(await api.saveSettings({ [key]: value })) }; }
  catch (e) { S.settings[key] = prev; applyAppearance(); toast('Could not save setting: ' + e.message, { kind: 'err' }); }
}

// §2 settings modal & tabs
const TABS = [['accounts', 'Accounts', 'account'], ['allInboxes', 'All Inboxes', 'inbox'], ['signatures', 'Signatures', 'pen'], ['categories', 'Categories', 'tag'], ['filters', 'Filters', 'filter'], ['rules', 'Rules', 'rules'], ['appearance', 'Appearance', 'palette']];

export function openSettings(opts = {}) {
  const nav = h('nav', { class: 'set-nav', role: 'tablist' });
  const pane = h('div', { class: 'set-pane' });
  const body = h('div', { class: 'set' }, nav, pane);
  const d = openDialog({ title: 'Settings', body, cls: 'settings', buttons: [{ label: 'Close', onClick: x => x.close() }] });
  const show = (tab, o = {}) => {
    clear(nav);
    for (const [k, l, ic] of TABS) nav.append(h('button', { class: 'set-tab' + (k === tab ? ' on' : ''), role: 'tab', 'aria-selected': String(k === tab), dataset: { tab: k }, on: { click: () => show(k) } }, icon(ic, 18), h('span', { text: l })));
    clear(pane);
    if (tab === 'accounts') renderAccountsTab(pane, o);
    else if (tab === 'allInboxes') renderAllInboxes(pane);
    else if (tab === 'signatures') renderSignatures(pane);
    else if (tab === 'categories') renderCategories(pane);
    else if (tab === 'filters') renderFiltersView(pane, { onAdvanced: () => show('rules') });
    else if (tab === 'rules') renderRulesTab(pane);
    else renderAppearance(pane);
  };
  show(opts.tab || 'accounts', opts);
  return d;
}

// §3 appearance tab
function themeGrid(list, cur, pane) {
  const g = h('div', { class: 'theme-grid', role: 'radiogroup', 'aria-label': 'Theme' });
  for (const [k, l, accent, bg, hdr] of list) {
    g.append(h('button', {
      class: 'theme-card' + (cur === k ? ' on' : ''), role: 'radio', 'aria-checked': String(cur === k), dataset: { theme: k },
      on: { click: async () => { await saveSetting('theme', k); renderAppearance(clear(pane)); } },
    }, h('span', { class: 'theme-prev', style: { background: bg } }, h('span', { style: { background: hdr || accent } })), h('span', { text: l })));
  }
  return g;
}

function renderAppearance(pane) {
  const st = S.settings, cur = st.theme || 'light';
  const classic = themeGrid(CLASSIC_THEMES, cur, pane);
  const nexList = Object.entries(NEX_THEMES).map(([k, p]) => [k, p.name, p.colors.accent, p.colors.background, p.colors.header]);
  const nexGrid = themeGrid(nexList, cur, pane);
  const sel = (key, options, cast = String) => {
    const s = selectEl(options, st[key]);
    s.addEventListener('change', () => saveSetting(key, cast(s.value)));
    return s;
  };
  const autoCal = h('input', { type: 'checkbox', checked: st.autoCalendar !== false });
  autoCal.addEventListener('change', () => saveSetting('autoCalendar', autoCal.checked));
  pane.append(h('h3', { text: 'Theme' }), classic, h('h4', { text: 'Nex Themes' }), nexGrid,
    h('div', { class: 'form grid2' },
      field('Density', sel('density', [['comfortable', 'Comfortable'], ['compact', 'Compact']])),
      field('Text size', sel('fontSize', [['xsmall', 'Extra small'], ['small', 'Small'], ['normal', 'Normal'], ['large', 'Large'], ['xlarge', 'Extra large'], ['xxlarge', 'XX-Large']])),
      field('Reading pane', sel('readingPane', [['right', 'Right'], ['bottom', 'Bottom']])),
      field('Mark as read', sel('markReadSeconds', [[0, 'Immediately when opened'], [1, 'After 1 second'], [2, 'After 2 seconds'], [5, 'After 5 seconds'], [10, 'After 10 seconds'], [30, 'After 30 seconds']], Number)),
      field('External images', sel('showImages', [['ask', 'Ask (blocked by default)'], ['always', 'Always show']])),
      field('Sync interval', sel('pollSeconds', [[60, 'Every 1 minute'], [120, 'Every 2 minutes'], [300, 'Every 5 minutes'], [900, 'Every 15 minutes'], [3600, 'Every hour']], Number)),
      field('Messages per page', sel('pageSize', [[25, '25'], [50, '50'], [100, '100'], [200, '200']], Number))),
    h('label', { class: 'check' }, autoCal, h('span', { text: 'Auto calendar: add detected email appointments to your calendar' })));
}

// §4 categories tab
async function saveCats(list) {
  try { S.categories = await api.saveCategories(list); emit('categories'); emit('list'); emit('msg'); return true; }
  catch (e) { toast('Could not save categories: ' + e.message, { kind: 'err' }); return false; }
}

function renderCategories(pane) {
  clear(pane);
  const list = h('div', { class: 'cat-list' });
  S.categories.forEach((c, i) => {
    const name = h('input', { class: 'inp', value: c.name, 'aria-label': 'Category name' });
    name.addEventListener('change', async () => { if (!name.value.trim()) { name.value = c.name; return; } const l = S.categories.map(x => ({ ...x })); l[i].name = name.value.trim(); await saveCats(l); });
    const sw = h('button', { class: 'swatch', style: { background: c.color }, title: 'Change color', 'aria-label': 'Color' });
    sw.addEventListener('click', () => openMenu(sw, PALETTE.slice(0, 12).map(col => ({ label: col, swatch: col, color: col, checked: col === c.color, onClick: async () => { const l = S.categories.map(x => ({ ...x })); l[i].color = col; if (await saveCats(l)) renderCategories(pane); } }))));
    list.append(h('div', { class: 'cat-row' }, sw, name,
      h('button', { class: 'icon-btn', title: 'Delete category', 'aria-label': 'Delete category', on: { click: async () => {
        if (!(await confirmDialog(`Delete category "${c.name}"? It will be removed from all messages.`, { ok: 'Delete', danger: true }))) return;
        if (await saveCats(S.categories.filter(x => x !== c))) renderCategories(pane);
      } } }, icon('delete', 18))));
  });
  pane.append(h('h3', { text: 'Categories (colored labels)' }), h('p', { class: 'muted', text: 'Messages can have multiple categories applied via right-click Mark or the reading pane.' }), list,
    h('button', { class: 'btn', on: { click: async () => {
      const color = PALETTE[(S.categories.length * 5 + 3) % 12];
      if (await saveCats([...S.categories, { name: `Category ${S.categories.length + 1}`, color }])) { renderCategories(pane); pane.querySelector('.cat-row:last-child input')?.select(); }
    } } }, icon('plus', 16), h('span', { text: 'Add Category' })));
}

// §5 all inboxes tab
function renderAllInboxes(pane) {
  clear(pane);
  const ai = S.settings?.allInboxes || {};
  const curColor = ai.color || '';
  const excl = new Set(ai.excluded || []);
  const apply = async (patch, redraw = false) => {
    const next = { color: curColor, excluded: [...excl], ...patch };
    await saveSetting('allInboxes', next);
    emit('tree'); emit('list'); emit('reloadAllInboxes');
    if (redraw) renderAllInboxes(pane);
  };

  const swatches = h('div', { class: 'swatches ai-swatches' },
    PALETTE.slice(0, 12).map(col => h('button', {
      type: 'button', class: 'swatch' + (curColor.toLowerCase() === col.toLowerCase() ? ' on' : ''),
      style: { background: col }, title: col, 'aria-label': `Accent color ${col}`,
      on: { click: () => apply({ color: col }, true) },
    })),
    h('input', {
      type: 'color', class: 'all-color-inp', value: curColor || '#0f6cbd', 'aria-label': 'Custom accent color',
      on: { change: e => apply({ color: e.target.value }, true) },
    }),
    h('button', { type: 'button', class: 'btn ghost sm', text: 'Default', disabled: !curColor, on: { click: () => apply({ color: '' }, true) } }));

  const groupsWrap = h('div', { class: 'ai-groups' });
  const buckets = groupAccountsByCategory();
  const includedCount = () => S.accounts.filter(a => !excl.has(a.id)).length;
  const countEl = h('span', { class: 'muted', text: `${includedCount()}/${S.accounts.length} included` });

  if (!buckets.length) {
    groupsWrap.append(h('p', { class: 'muted', text: 'No email accounts added yet.' }));
  } else for (const b of buckets) {
    const allIn = b.items.every(a => !excl.has(a.id));
    const toggleBtn = h('button', {
      type: 'button', class: 'btn link sm', text: allIn ? 'Uncheck all' : 'Check all',
      on: { click: () => { for (const a of b.items) if (allIn) excl.add(a.id); else excl.delete(a.id); apply({ excluded: [...excl] }, true); } },
    });
    const list = h('div', { class: 'ai-acc-list' }, b.items.map(a => {
      const cb = h('input', { type: 'checkbox', checked: !excl.has(a.id), dataset: { accId: a.id } });
      cb.addEventListener('change', () => {
        if (cb.checked) excl.delete(a.id); else excl.add(a.id);
        countEl.textContent = `${includedCount()}/${S.accounts.length} included`;
        apply({ excluded: [...excl] });
      });
      const labelTxt = a.name && a.name !== a.email ? `${a.name} (${a.email})` : a.email;
      return h('label', { class: 'check ai-acc-row' }, cb, h('span', { class: 'ai-acc-lbl', text: labelTxt }));
    }));
    groupsWrap.append(h('div', { class: 'ai-group' },
      h('div', { class: 'ai-group-head', style: b.color ? { borderLeftColor: b.color } : null },
        b.color ? h('span', { class: 'acc-color-chip', style: { background: b.color } }) : null,
        h('span', { class: 'ai-group-name', text: b.name }), toggleBtn),
      list));
  }

  pane.append(
    h('h3', { text: 'ALL INBOXES' }),
    h('p', { class: 'muted', text: 'Choose the accent color and which mailboxes feed new messages into ALL INBOXES.' }),
    h('h4', { text: 'Accent color' }), swatches,
    h('div', { class: 'ai-sec-head' }, h('h4', { text: 'Included mailboxes' }), countEl),
    groupsWrap);
}
