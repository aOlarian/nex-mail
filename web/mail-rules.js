/* MAP
 * §1 vocabulary      L15-L44
 * §2 rules list      L45-L80
 * §3 rule editor     L81-L151
 */
// Rules tab: active/inactive list, order, recursive/folder execution, condition -> action editor.
import { h, clear } from './mail-util.js';
import { icon } from './mail-icons.js';
import { S, isVirtualAcc, emit, accountById, categoryById, filteredById, folderTitle, folderByPath } from './mail-state.js';
import { api } from './mail-api.js';
import { confirmDialog, toast, field, selectEl } from './mail-ui.js';
import { flatFolders } from './mail-tree.js';
import { runAllFiltersNow } from './mail-filters.js';

// §1 vocabulary
const FIELDS = [['from', 'Sender'], ['fromName', 'From name'], ['fromEmail', 'From email'], ['to', 'Recipient'], ['subject', 'Subject'], ['body', 'Body'], ['any', 'Anywhere']];
const OPS = [['contains', 'contains'], ['notContains', 'does not contain'], ['equals', 'equals'], ['startsWith', 'starts with'], ['endsWith', 'ends with'], ['wildcard', 'wildcard (* or ^=)']];
const ACTIONS = [['moveLocal', 'Move to Filtered folder (local)'], ['move', 'Move to IMAP folder'], ['delete', 'Delete (Trash)'], ['deleteForever', 'Delete permanently'], ['markRead', 'Mark as read'], ['flag', 'Flag'], ['category', 'Category']];
const label = (list, k) => (list.find(x => x[0] === k) || [k, k])[1];
let rules = [];

function summary(r) {
  const c = (r.conditions || []).map(x => `${label(FIELDS, x.field)} ${label(OPS, x.op)} "${x.value}"`).join(r.match === 'any' ? ' or ' : ' and ');
  const a = (r.actions || []).map(x => x.type === 'moveLocal' ? `filtered "${filteredById(x.value)?.name || x.value}"`
    : x.type === 'move' ? `move to ${x.value}`
      : x.type === 'category' ? `category ${(categoryById(x.value) || {}).name || ''}` : label(ACTIONS, x.type).toLowerCase()).join(', ');
  return `If ${c || '...'} -> ${a || '...'}`;
}

async function persist(list) {
  try { const r = await api.saveRules(list); rules = Array.isArray(r) ? r : (r.rules || list); emit('rulesChanged'); return true; }
  catch (e) { toast('Could not save rules: ' + e.message, { kind: 'err' }); return false; }
}

async function runRule(ruleId) {
  if (!S.cur.account || !S.cur.folder || isVirtualAcc(S.cur.account)) return runAllFiltersNow(ruleId);
  const t = toast('Running rules on current folder...', { kind: 'busy' });
  try {
    const r = await api.runRules({ ...(ruleId ? { ruleId } : {}), account: S.cur.account, folder: S.cur.folder });
    t.update(`Checked: ${r.checked || 0}, matched: ${r.matched || 0}, actions: ${r.actions || 0} (in ${folderTitle(folderByPath(S.cur.account, S.cur.folder))})`, 'ok');
    emit('reloadList');
  } catch (e) { t.update('Run failed: ' + e.message, 'err'); }
}

// §2 rules list
export async function renderRulesTab(pane) {
  clear(pane).append(h('h3', { text: 'Rules & AutoFilters' }), h('p', { class: 'muted', text: 'Loading...' }));
  try { rules = (await api.rules()).rules || []; }
  catch (e) { clear(pane).append(h('div', { class: 'state err' }, h('p', { text: e.message }), h('button', { class: 'btn', text: 'Retry', on: { click: () => renderRulesTab(pane) } }))); return; }
  renderList(pane);
}

function renderList(pane) {
  clear(pane);
  pane.append(h('h3', { text: 'Rules & AutoFilters' }),
    h('p', { class: 'muted', text: 'Rules run automatically on incoming messages and recursively across all folders on Run Filters.' }));
  const list = h('div', { class: 'rule-list' });
  rules.forEach((r, i) => {
    const sw = h('input', { type: 'checkbox', class: 'switch', checked: r.enabled !== false, title: 'Enabled', 'aria-label': `Enabled: ${r.name}` });
    sw.addEventListener('change', () => { r.enabled = sw.checked; persist(rules); });
    const mv = d => { const j = i + d; if (j < 0 || j >= rules.length) return; [rules[i], rules[j]] = [rules[j], rules[i]]; persist(rules).then(() => renderList(pane)); };
    const acc = r.account === '*' ? 'All accounts' : (accountById(r.account) || {}).email || r.account;
    list.append(h('div', { class: 'rule-row' + (r.enabled === false ? ' off' : '') }, sw,
      h('div', { class: 'rule-main' }, h('strong', { text: r.name || '(untitled)' }), h('span', { class: 'muted', text: `${summary(r)} · ${acc}${r.stop ? ' · stops other rules' : ''}` })),
      h('button', { class: 'icon-btn sm', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, on: { click: () => mv(-1) } }, icon('arrowUp', 16)),
      h('button', { class: 'icon-btn sm', title: 'Move down', 'aria-label': 'Move down', disabled: i === rules.length - 1, on: { click: () => mv(1) } }, icon('arrowDown', 16)),
      h('button', { class: 'icon-btn sm', title: 'Run globally now', 'aria-label': 'Run globally', on: { click: () => runAllFiltersNow(r.id) } }, icon('play', 16)),
      h('button', { class: 'icon-btn sm', title: 'Edit', 'aria-label': 'Edit', on: { click: () => renderEditor(pane, r) } }, icon('edit', 16)),
      h('button', { class: 'icon-btn sm', title: 'Delete', 'aria-label': 'Delete', on: { click: async () => {
        if (!(await confirmDialog(`Delete rule "${r.name}"?`, { ok: 'Delete', danger: true }))) return;
        if (await persist(rules.filter(x => x !== r))) renderList(pane);
      } } }, icon('delete', 16))));
  });
  if (!rules.length) list.append(h('p', { class: 'muted', text: 'No rules configured yet.' }));
  pane.append(list, h('div', { class: 'row-btns' },
    h('button', { class: 'btn primary', on: { click: () => renderEditor(pane, null) } }, icon('plus', 16), h('span', { text: 'New Rule' })),
    rules.length ? h('button', { class: 'btn', on: { click: () => runAllFiltersNow(null) } }, icon('play', 16), h('span', { text: 'Run All Everywhere' })) : null,
    rules.length ? h('button', { class: 'btn ghost', on: { click: () => runRule(null) } }, icon('play', 16), h('span', { text: 'Run on Current Folder' })) : null));
}

// §3 rule editor
function renderEditor(pane, r) {
  const isNew = !r;
  const d = r ? JSON.parse(JSON.stringify(r)) : { name: '', enabled: true, account: '*', match: 'all', conditions: [{ field: 'subject', op: 'wildcard', value: '' }], actions: [{ type: 'moveLocal', value: S.filteredFolders[0]?.id || '' }], stop: false };
  clear(pane);
  const name = h('input', { class: 'inp', value: d.name, placeholder: 'e.g., Order tracking newsletters', autofocus: true });
  const acc = selectEl([['*', 'All accounts'], ...S.accounts.map(a => [a.id, a.email])], d.account);
  const match = selectEl([['all', 'all conditions'], ['any', 'any condition']], d.match);
  const stop = h('input', { type: 'checkbox', checked: !!d.stop });
  const conds = h('div', { class: 'rule-lines' }), acts = h('div', { class: 'rule-lines' });
  acc.addEventListener('change', () => { d.account = acc.value; drawActs(); });

  function drawConds() {
    clear(conds);
    d.conditions.forEach((c, i) => {
      const f = selectEl(FIELDS, c.field), o = selectEl(OPS, c.op);
      const v = h('input', { class: 'inp', value: c.value || '', placeholder: i === 0 ? 'e.g., *.shop or Newsletter *' : 'value' });
      f.addEventListener('change', () => { c.field = f.value; });
      o.addEventListener('change', () => { c.op = o.value; });
      v.addEventListener('input', () => { c.value = v.value; });
      conds.append(h('div', { class: 'rule-line' }, f, o, v,
        h('button', { class: 'icon-btn sm', title: 'Remove condition', 'aria-label': 'Remove condition', disabled: d.conditions.length < 2, on: { click: () => { d.conditions.splice(i, 1); drawConds(); } } }, icon('minus', 16))));
    });
  }
  function folderOptions() {
    const accs = d.account === '*' ? S.accounts.map(a => a.id) : [d.account];
    const seen = new Set(), out = [];
    for (const a of accs) for (const { f } of flatFolders(a)) if (!f.noselect && !seen.has(f.path)) { seen.add(f.path); out.push([f.path, f.path]); }
    return out;
  }
  function drawActs() {
    clear(acts);
    d.actions.forEach((a, i) => {
      const t = selectEl(ACTIONS, a.type);
      let val = null;
      if (a.type === 'moveLocal') { const opts = S.filteredFolders.map(ff => [ff.id, ff.name]); if (!a.value && opts[0]) a.value = opts[0][0]; val = selectEl(opts.length ? opts : [['', 'No filtered folders']], a.value); }
      if (a.type === 'move') { const opts = folderOptions(); if (!a.value && opts[0]) a.value = opts[0][0]; val = selectEl(opts, a.value); }
      if (a.type === 'category') { const opts = S.categories.map(c => [c.id, c.name]); if (!a.value && opts[0]) a.value = opts[0][0]; val = selectEl(opts.length ? opts : [['', 'No categories defined']], a.value); }
      if (val) val.addEventListener('change', () => { a.value = val.value; });
      t.addEventListener('change', () => { a.type = t.value; a.value = null; drawActs(); });
      acts.append(h('div', { class: 'rule-line' }, t, val,
        h('button', { class: 'icon-btn sm', title: 'Remove action', 'aria-label': 'Remove action', disabled: d.actions.length < 2, on: { click: () => { d.actions.splice(i, 1); drawActs(); } } }, icon('minus', 16))));
    });
  }
  drawConds(); drawActs();

  const ruleSig = x => {
    const cs = (x.conditions || []).map(c => `${c.field}|${c.op}|${String(c.value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\^\=/g, '*').trim().toLowerCase()}`).sort().join('&&');
    const as = (x.actions || []).map(a => `${a.type}|${a.value == null ? '' : String(a.value).trim()}`).join('&&');
    return `${x.account || '*'}::${x.match || 'all'}::${cs}::${as}`;
  };
  async function save() {
    d.name = name.value.trim();
    d.account = acc.value; d.match = match.value; d.stop = stop.checked;
    d.conditions = d.conditions.filter(c => String(c.value || '').trim());
    if (!d.conditions.length) { toast('Add at least one condition.', { kind: 'err' }); d.conditions = [{ field: 'subject', op: 'wildcard', value: '' }]; drawConds(); return; }
    if (d.actions.some(a => (a.type === 'move' || a.type === 'moveLocal' || a.type === 'category') && !a.value)) { toast('Select destination folder or category.', { kind: 'err' }); return; }
    const sig = ruleSig(d);
    if (rules.some(x => (isNew || x.id !== r.id) && ruleSig(x) === sig)) { toast('An identical rule already exists.', { kind: 'err' }); return; }
    if (!d.name) d.name = `${label(FIELDS, d.conditions[0].field)} ${label(OPS, d.conditions[0].op)} "${d.conditions[0].value}"`;
    if (!d.id) d.id = 'r' + Date.now().toString(36);
    const list = isNew ? [...rules, d] : rules.map(x => (x.id === r.id ? d : x));
    if (await persist(list)) { toast('Rule saved', { kind: 'ok' }); renderList(pane); }
  }
  pane.append(
    h('div', { class: 'set-back' }, h('button', { class: 'btn ghost sm', on: { click: () => renderList(pane) } }, icon('back', 16), h('span', { text: 'Back to rules' }))),
    h('h3', { text: isNew ? 'New Rule' : 'Edit Rule' }),
    h('div', { class: 'form grid2' }, field('Name', name), field('Applies to', acc)),
    h('div', { class: 'rule-sec' }, h('span', { text: 'When matching' }), match),
    conds, h('button', { class: 'btn ghost sm', on: { click: () => { d.conditions.push({ field: 'fromEmail', op: 'wildcard', value: '' }); drawConds(); } } }, icon('plus', 16), h('span', { text: 'Add Condition' })),
    h('div', { class: 'rule-sec' }, h('span', { text: 'Then' })),
    acts, h('button', { class: 'btn ghost sm', on: { click: () => { d.actions.push({ type: 'markRead', value: null }); drawActs(); } } }, icon('plus', 16), h('span', { text: 'Add Action' })),
    h('label', { class: 'check' }, stop, h('span', { text: 'Stop processing more rules after this' })),
    h('div', { class: 'row-btns' },
      h('button', { class: 'btn primary', on: { click: save } }, icon('save', 16), h('span', { text: 'Save Rule' })),
      !isNew ? h('button', { class: 'btn', on: { click: () => runAllFiltersNow(d.id) } }, icon('play', 16), h('span', { text: 'Run Globally Now' })) : null,
      h('button', { class: 'btn ghost', text: 'Cancel', on: { click: () => renderList(pane) } })));
}
