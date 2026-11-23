/* MAP
 * §1 run all global filters              L13-L36
 * §2 custom autofilter modal             L37-L172
 * §3 global filter folders & rules view  L173-L260
 */
// Global AutoFilter workflow: Custom wildcard filter modal, global filtered folders manager, and recursive Run Filters.
import { h, clear } from './mail-util.js';
import { icon } from './mail-icons.js';
import { S, emit } from './mail-state.js';
import { api } from './mail-api.js';
import { openDialog, toast, promptDialog, confirmDialog, selectEl } from './mail-ui.js';

// §1 run all global filters
export async function runAllFiltersNow(ruleRef) {
  const t = toast('Running filters recursively across all mailboxes...', { kind: 'busy' });
  try {
    const body = Array.isArray(ruleRef) && ruleRef.length
      ? (ruleRef.length === 1 ? { all: true, ruleId: ruleRef[0] } : { all: true, ruleIds: ruleRef })
      : (ruleRef ? { all: true, ruleId: ruleRef } : { all: true });
    const r = await api.runRules(body);
    S.filteredFolders = await api.filteredFolders();
    emit('filteredChanged');
    emit('refreshCounts', true);
    emit('reloadList');
    const parts = [];
    if (r.moved) parts.push(`${r.moved} moved locally`);
    if (r.deleted) parts.push(`${r.deleted} deleted`);
    const summary = parts.length ? parts.join(', ') : `${r.actions ?? r.matched ?? 0} actions`;
    t.update(`Filters finished (${r.scanned ?? r.checked ?? 0} scanned, ${summary})`, 'ok');
    return r;
  } catch (e) {
    t.update('Filter run failed: ' + e.message, 'err');
    return null;
  }
}

// §2 custom autofilter modal
export async function openCustomFilterModal(msgOrList) {
  const list = (Array.isArray(msgOrList) ? msgOrList : [msgOrList]).filter(Boolean);
  const isMulti = list.length > 1;
  const m = list[0] || {};
  let bodySeed = m.text || m.preview || '';
  const uniq = fn => {
    const seen = new Set(), out = [];
    for (const x of list) { const v = String(fn(x) || '').trim(), k = v.toLowerCase(); if (v && !seen.has(k)) { seen.add(k); out.push(v); } }
    return out;
  };

  const folderChoices = () => [
    ...S.filteredFolders.map(f => [f.id, f.name]),
    ['__create__', '+ Create Folder...'],
    ['__delete__', 'Delete (Move to Trash / Remove)'],
  ];

  const moveSel = selectEl(folderChoices(), S.filteredFolders[0]?.id || '__delete__', { 'aria-label': 'Move to' });
  const newWrap = h('div', { class: 'af-create', hidden: true });
  const newName = h('input', { class: 'inp', placeholder: 'New filtered folder name' });
  newWrap.append(newName);

  const bySel = selectEl([
    ['subject', 'Subject'],
    ['fromName', 'From name'],
    ['fromEmail', 'From email'],
    ['domain', 'Domain (*@domain.tld)'],
    ['body', 'Body'],
  ], isMulti ? 'fromEmail' : 'subject', { 'aria-label': 'Filter by' });

  const domOf = x => { const a = String((x && x.from && x.from.address) || '').trim(), i = a.lastIndexOf('@'); return i >= 0 && a.slice(i + 1).trim() ? `*@${a.slice(i + 1).trim().toLowerCase()}` : ''; };
  const presetFor = k => {
    if (!isMulti) return k === 'subject' ? (m.subject || '') : k === 'fromName' ? ((m.from && m.from.name) || '') : k === 'fromEmail' ? ((m.from && m.from.address) || '') : k === 'domain' ? domOf(m) : bodySeed;
    if (k === 'subject') return uniq(x => x.subject).join('\n');
    if (k === 'fromName') return uniq(x => x.from && x.from.name).join('\n');
    if (k === 'fromEmail') return uniq(x => x.from && x.from.address).join('\n');
    if (k === 'domain') return uniq(domOf).join('\n');
    return uniq(x => x.text || x.preview).join('\n');
  };

  const valWrap = h('div', { class: 'af-valwrap' });
  const valInp = h('input', { class: 'inp', value: isMulti ? '' : presetFor('subject'), placeholder: 'Wildcard pattern or text', hidden: isMulti });
  const valBox = h('textarea', { class: 'inp af-textarea', rows: 5, value: isMulti ? presetFor('fromEmail') : '', placeholder: isMulti ? 'One wildcard pattern or value per line' : 'Body pattern or phrase', hidden: !isMulti });
  valWrap.append(valInp, valBox);

  const edited = { subject: false, fromName: false, fromEmail: false, domain: false, body: false };

  function syncField() {
    const k = bySel.value;
    const useBox = isMulti || k === 'body';
    valInp.hidden = useBox;
    valBox.hidden = !useBox;
    if (!edited[k]) {
      const v = presetFor(k);
      if (useBox) valBox.value = v; else valInp.value = v;
    }
  }
  valInp.addEventListener('input', () => { edited[bySel.value] = true; });
  valBox.addEventListener('input', () => { edited[bySel.value] = true; });
  bySel.addEventListener('change', syncField);

  if (!isMulti && !m.text && m.account && m.folder && m.uid) {
    api.message(m.account, m.folder, m.uid).then(full => {
      if (full && full.text) {
        bodySeed = full.text.slice(0, 1200);
        if (bySel.value === 'body' && !edited.body) valBox.value = bodySeed;
      }
    }).catch(() => {});
  }

  moveSel.addEventListener('change', () => {
    const creating = moveSel.value === '__create__';
    newWrap.hidden = !creating;
    if (creating) newName.focus();
  });

  const runNowChk = h('input', { type: 'checkbox', class: 'chk', checked: true });
  const hint = h('div', { class: 'af-hint muted' },
    h('strong', { text: 'Wildcard syntax: ' }),
    h('span', { text: 'Use ' }), h('code', { text: '^=' }), h('span', { text: ' or ' }), h('code', { text: '*' }),
    h('span', { text: ' as "everything here" (e.g., Order *= processed, *.shop). Applies globally across all mailboxes & folders (past, present, future); filtered mail is stored locally and removed from the IMAP server.' }));

  const createBtn = h('button', { type: 'button', class: 'btn ghost sm', text: '+ New', title: 'Create Folder', on: { click: () => { moveSel.value = '__create__'; newWrap.hidden = false; newName.focus(); } } });
  const form = h('div', { class: 'af-form' },
    h('label', { class: 'field' }, h('span', { text: 'Move to' }), h('div', { class: 'af-moverow' }, moveSel, createBtn)),
    newWrap,
    h('label', { class: 'field' }, h('span', { text: 'Filter by' }), bySel),
    h('label', { class: 'field' }, h('span', { text: isMulti ? 'Match values (one per line, editable)' : 'Match value (editable)' }), valWrap),
    hint,
    h('label', { class: 'row-check' }, runNowChk, h('span', { text: 'Run immediately across all accounts and folders' })));

  let saving = false;
  const mDlg = openDialog({
    title: isMulti ? `Custom AutoFilter (${list.length} messages)` : 'Custom AutoFilter',
    body: form,
    buttons: [
      { label: 'Save Filter', kind: 'primary', onClick: async d => {
        if (saving) return;
        const field = bySel.value;
        const raw = (isMulti || field === 'body' ? valBox.value : valInp.value);
        const vals = isMulti ? [...new Set(raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean))] : [raw.trim()].filter(Boolean);
        if (!vals.length) { toast('Enter a match value.', { kind: 'err' }); return; }
        saving = true;
        try {
          let dest = moveSel.value;
          const action = dest === '__delete__' ? 'delete' : 'moveLocal';
          if (dest === '__create__') {
            const cn = newName.value.trim();
            if (!cn) { toast('Enter a name for the new folder.', { kind: 'err' }); newName.focus(); return; }
            S.filteredFolders = await api.saveFilteredFolders({ action: 'create', name: cn });
            const created = S.filteredFolders.find(f => f.name.toLowerCase() === cn.toLowerCase());
            dest = created ? created.id : cn;
            emit('filteredChanged');
          }
          const runIds = [];
          let added = 0, dups = 0;
          for (const value of vals) {
            const res = await api.quickRule({ kind: 'custom', field, op: 'wildcard', value, action, dest });
            const id = res && (res.id || (res.rule && res.rule.id));
            if (id) runIds.push(id);
            if (res && res.duplicate) dups++; else added++;
          }
          if (added) emit('rulesChanged');
          if (!added && dups) toast(`AutoFilter already exists (${field})`, { kind: 'info' });
          else toast(vals.length > 1 ? `AutoFilter saved (${added} ${added === 1 ? 'rule' : 'rules'}${dups ? `, ${dups} duplicate skipped` : ''})` : `AutoFilter saved (${field}: ${vals[0]})`, { kind: 'ok' });
          d.close(true);
          if (runNowChk.checked && runIds.length) runAllFiltersNow(runIds);
        } finally { saving = false; }
      } },
      { label: 'Cancel', onClick: d => d.close(true) },
    ],
  });
  return mDlg;
}

// §3 global filter folders & rules view
export function renderFiltersView(pane, opts = {}) {
  clear(pane);
  const topBar = h('div', { class: 'af-tab-head' },
    h('h3', { text: 'Filters & Filtered Folders' }),
    h('button', { id: 'btn-run-filters', type: 'button', class: 'btn primary sm', on: { click: () => runAllFiltersNow() } },
      icon('play', 14), h('span', { text: 'Run Filters' })));
  const body = h('div', { class: 'af-mgr' });
  const foldersBox = h('div', { class: 'af-sec' });
  const rulesBox = h('div', { class: 'af-sec' });
  body.append(foldersBox, rulesBox);
  pane.append(topBar, body);

  let rules = [];
  async function loadRules() {
    try { const res = await api.rules(); rules = res.rules || (Array.isArray(res) ? res : []); }
    catch (e) { rules = []; toast(e.message, { kind: 'err' }); }
    render();
  }

  function render() {
    clear(foldersBox);
    foldersBox.append(h('div', { class: 'af-sechead' },
      h('h4', { text: 'Global Filtered Folders (local only)' }),
      h('button', { type: 'button', class: 'btn sm', text: '+ Create Folder', on: { click: addFolder } })));
    for (const ff of S.filteredFolders) {
      foldersBox.append(h('div', { class: 'af-item' },
        h('span', { class: 'af-name', text: ff.name }),
        h('span', { class: 'badge', text: String(ff.count || 0) }),
        h('button', { type: 'button', class: 'icon-btn sm', title: 'Rename', on: { click: () => renameFolder(ff) } }, icon('edit', 14)),
        !ff.system ? h('button', { type: 'button', class: 'icon-btn sm', title: 'Delete', on: { click: () => removeFolder(ff) } }, icon('delete', 14)) : null));
    }

    clear(rulesBox);
    rulesBox.append(h('div', { class: 'af-sechead' },
      h('h4', { text: `Filter Rules (${rules.length})` }),
      h('div', { class: 'af-btns' },
        h('button', { type: 'button', class: 'btn sm', text: 'Advanced Rules', on: { click: () => (opts.onAdvanced ? opts.onAdvanced() : emit('openSettings', { tab: 'rules' })) } }))));
    if (!rules.length) {
      rulesBox.append(h('p', { class: 'muted', text: 'No filter rules yet. Right-click any message -> AutoFilter to create one.' }));
    } else {
      for (const r of rules) {
        rulesBox.append(h('div', { class: 'af-item' },
          h('input', { type: 'checkbox', class: 'chk', checked: r.enabled !== false, on: { change: async e => {
            r.enabled = e.target.checked;
            await api.saveRules(rules);
            emit('rulesChanged');
          } } }),
          h('span', { class: 'af-name', text: r.name }),
          h('button', { type: 'button', class: 'btn link sm', text: 'Run', on: { click: () => runAllFiltersNow(r.id) } }),
          h('button', { type: 'button', class: 'icon-btn sm', title: 'Delete rule', on: { click: async () => {
            rules = rules.filter(x => x.id !== r.id);
            await api.saveRules(rules);
            emit('rulesChanged');
            render();
          } } }, icon('delete', 14))));
      }
    }
  }

  async function addFolder() {
    const name = await promptDialog({ title: 'Create Filtered Folder', label: 'Folder name', ok: 'Create' });
    if (!name) return;
    S.filteredFolders = await api.saveFilteredFolders({ action: 'create', name });
    emit('filteredChanged'); render();
  }
  async function renameFolder(ff) {
    const name = await promptDialog({ title: 'Rename Folder', label: 'Folder name', value: ff.name, ok: 'Save' });
    if (!name || name === ff.name) return;
    S.filteredFolders = await api.saveFilteredFolders({ action: 'rename', id: ff.id, name });
    emit('filteredChanged'); render();
  }
  async function removeFolder(ff) {
    if (!(await confirmDialog(`Delete filtered folder "${ff.name}" and its local messages?`, { ok: 'Delete', danger: true }))) return;
    S.filteredFolders = await api.saveFilteredFolders({ action: 'delete', id: ff.id });
    emit('filteredChanged'); render();
  }

  render();
  loadRules();
}

export function openFilterManager() {
  const body = h('div');
  const dlg = openDialog({ title: 'Filters & Filtered Folders', body, cls: 'wide', buttons: [{ label: 'Close', kind: 'primary', onClick: d => d.close(true) }] });
  renderFiltersView(body, { onAdvanced: () => { dlg.close(); emit('openSettings', { tab: 'rules' }); } });
  return dlg;
}
