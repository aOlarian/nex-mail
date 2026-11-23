/* MAP
 * §1 accounts list     L14-L51
 * §2 account form      L52-L103
 * §3 test & save       L104-L146
 */
// Accounts tab: status list, add/edit (autoconfig, IMAP/SMTP test), delete with confirmation.
import { h, clear, fmtShort, validEmail } from './mail-util.js';
import { icon } from './mail-icons.js';
import { S, emit, accountById } from './mail-state.js';
import { api } from './mail-api.js';
import { confirmDialog, toast, field, selectEl } from './mail-ui.js';
import { PALETTE } from './mail-editor.js';

// §1 accounts list
export function renderAccountsTab(pane, opts = {}) {
  clear(pane);
  if (opts.add) return renderForm(pane, null);
  if (opts.edit && accountById(opts.edit)) return renderForm(pane, accountById(opts.edit));
  pane.append(h('h3', { text: 'Email Accounts' }));
  if (!S.accounts.length) pane.append(h('p', { class: 'muted', text: 'No accounts yet. Add an IMAP mailbox to get started.' }));
  for (const a of S.accounts) {
    const st = a.status || {};
    const ok = st.ok !== false;
    pane.append(h('div', { class: 'acc-card' },
      h('span', { class: 'acc-dot lg', style: { background: a.color || '#0f6cbd' } }),
      h('div', { class: 'acc-info' },
        h('strong', { text: a.name || a.email }), h('span', { class: 'muted', text: a.email }),
        h('span', { class: 'acc-st ' + (ok ? 'ok' : 'err') }, icon(ok ? 'check' : 'warn', 14),
          ok ? (st.lastSync ? `Synced ${fmtShort(st.lastSync)}` : 'Waiting for initial sync') : (st.error || 'Connection error'))),
      h('button', { class: 'btn sm', on: { click: () => renderForm(clear(pane), a) } }, icon('edit', 16), h('span', { text: 'Edit' })),
      h('button', { class: 'btn sm danger', on: { click: () => removeAccount(pane, a) } }, icon('delete', 16), h('span', { text: 'Delete' }))));
  }
  pane.append(h('button', { class: 'btn primary', on: { click: () => renderForm(clear(pane), null) } }, icon('plus', 16), h('span', { text: 'Add Account' })));
}

export async function confirmDeleteAccount(a) {
  if (!(await confirmDialog(`Remove account ${a.email} from Nex Mail? Messages remain on the server; only local account settings, categories, and tasks will be removed.`, { ok: 'Remove account', danger: true }))) return false;
  try {
    await api.deleteAccount(a.id);
    S.accounts = S.accounts.filter(x => x.id !== a.id);
    delete S.folders[a.id];
    emit('accountsChanged');
    toast('Account removed', { kind: 'ok' });
    return true;
  } catch (e) { toast(e.message, { kind: 'err' }); return false; }
}

async function removeAccount(pane, a) {
  if (await confirmDeleteAccount(a)) renderAccountsTab(pane);
}

// §2 account form
function renderForm(pane, a) {
  const isNew = !a;
  a = a || { name: '', email: '', user: '', color: PALETTE[8], imap: { host: '', port: 993, secure: true }, smtp: { host: '', port: 465, secure: true }, insecureTls: false, signatureNew: null, signatureReply: null };
  const inp = (v, attrs = {}) => h('input', { class: 'inp', value: v ?? '', ...attrs });
  const f = {
    name: inp(a.name, { placeholder: 'e.g., Augustin Olarian', autofocus: true }),
    email: inp(a.email, { type: 'email', placeholder: 'name@company.com' }),
    user: inp(a.user, { placeholder: 'default: email address' }),
    pass: inp('', { type: 'password', autocomplete: 'new-password', placeholder: isNew ? '' : 'unchanged (leave blank)' }),
    ih: inp(a.imap.host, { placeholder: 'imap.company.com' }), ip: inp(a.imap.port, { type: 'number', min: 1, max: 65535 }),
    is: h('input', { type: 'checkbox', checked: a.imap.secure !== false }),
    sh: inp(a.smtp.host, { placeholder: 'smtp.company.com' }), sp: inp(a.smtp.port, { type: 'number', min: 1, max: 65535 }),
    ss: h('input', { type: 'checkbox', checked: a.smtp.secure !== false }),
    insecure: h('input', { type: 'checkbox', checked: !!a.insecureTls }),
  };
  const sigOpts = [['', 'No signature'], ...S.signatures.map(s => [s.id, s.name])];
  f.sigNew = selectEl(sigOpts, a.signatureNew || '');
  f.sigReply = selectEl(sigOpts, a.signatureReply || '');
  let color = a.color || PALETTE[8];
  const sw = h('div', { class: 'swatches' });
  const paint = () => { clear(sw); PALETTE.slice(0, 12).forEach(c => sw.append(h('button', { type: 'button', class: 'swatch' + (c === color ? ' on' : ''), 'aria-label': c, style: { background: c }, on: { click: () => { color = c; paint(); } } }))); };
  paint();
  f.sp.addEventListener('change', () => { f.ss.checked = Number(f.sp.value) === 465; });
  f.ip.addEventListener('change', () => { f.is.checked = Number(f.ip.value) === 993; });
  f.email.addEventListener('blur', async () => {
    const em = f.email.value.trim();
    if (!validEmail(em)) return;
    if (!f.user.value.trim()) f.user.placeholder = em;
    if (f.ih.value.trim() && f.sh.value.trim()) return;
    try {
      const c = await api.autoconfig(em);
      if (!f.ih.value.trim() && c.imap) { f.ih.value = c.imap.host; f.ip.value = c.imap.port; f.is.checked = !!c.imap.secure; }
      if (!f.sh.value.trim() && c.smtp) { f.sh.value = c.smtp.host; f.sp.value = c.smtp.port; f.ss.checked = !!c.smtp.secure; }
      result.textContent = 'Servers auto-detected; verify and click Test.';
    } catch (e) { result.textContent = 'Could not auto-detect servers: ' + e.message; }
  });
  const result = h('div', { class: 'test-result muted', role: 'status' });
  const collect = () => ({
    ...(a.id ? { id: a.id } : {}), name: f.name.value.trim(), email: f.email.value.trim(), user: f.user.value.trim() || f.email.value.trim(),
    password: f.pass.value, color,
    imap: { host: f.ih.value.trim(), port: Number(f.ip.value) || 993, secure: f.is.checked },
    smtp: { host: f.sh.value.trim(), port: Number(f.sp.value) || 465, secure: f.ss.checked },
    insecureTls: f.insecure.checked, signatureNew: f.sigNew.value || null, signatureReply: f.sigReply.value || null,
  });
  const check = d => {
    if (!d.email || !validEmail(d.email)) return 'Enter a valid email address.';
    if (!d.imap.host || !d.smtp.host) return 'Enter IMAP and SMTP servers.';
    if (isNew && !d.password) return 'Enter password.';
    return null;
  };

  // §3 test & save
  async function test(btn) {
    const d = collect(), err = check(d);
    if (err) { toast(err, { kind: 'err' }); return; }
    btn.disabled = true; clear(result).append(h('span', { class: 'spinner' }), ' Testing connection...');
    try {
      const r = await api.testAccount(d);
      clear(result).append(line('IMAP', r.imap), line('SMTP', r.smtp));
    } catch (e) { clear(result).append(h('span', { class: 'acc-st err', text: e.message })); }
    btn.disabled = false;
  }
  const line = (k, x) => h('div', { class: 'acc-st ' + (x && x.ok ? 'ok' : 'err') }, icon(x && x.ok ? 'check' : 'warn', 14), x && x.ok ? `${k} ok` : `${k}: ${(x && x.error) || 'error'}`);
  async function save(btn) {
    const d = collect(), err = check(d);
    if (err) { toast(err, { kind: 'err' }); return; }
    if (!d.password) delete d.password;
    btn.disabled = true;
    try {
      const saved = await api.saveAccount(d);
      const i = S.accounts.findIndex(x => x.id === saved.id);
      if (i >= 0) S.accounts[i] = saved; else S.accounts.push(saved);
      emit('accountsChanged', saved.id);
      toast(isNew ? `Account ${saved.email} added` : 'Account saved', { kind: 'ok' });
      renderAccountsTab(clear(pane));
    } catch (e) { toast(e.message, { kind: 'err' }); btn.disabled = false; }
  }
  pane.append(
    h('div', { class: 'set-back' }, h('button', { class: 'btn ghost sm', on: { click: () => renderAccountsTab(clear(pane)) } }, icon('back', 16), h('span', { text: 'Back to accounts' }))),
    h('h3', { text: isNew ? 'Add Account' : `Edit ${a.email}` }),
    h('div', { class: 'form grid2' }, field('Display name', f.name), field('Email address', f.email), field('Username', f.user), field('Password', f.pass)),
    h('h4', { text: 'Incoming Server (IMAP)' }),
    h('div', { class: 'form grid3' }, field('Host', f.ih), field('Port', f.ip), h('label', { class: 'check' }, f.is, h('span', { text: 'SSL/TLS' }))),
    h('h4', { text: 'Outgoing Server (SMTP)' }),
    h('div', { class: 'form grid3' }, field('Host', f.sh), field('Port', f.sp), h('label', { class: 'check' }, f.ss, h('span', { text: 'SSL/TLS (465)' }))),
    h('label', { class: 'check' }, f.insecure, h('span', { text: 'Allow self-signed / insecure certificate (private servers only)' })),
    h('div', { class: 'form grid2' }, field('Signature for new messages', f.sigNew), field('Signature for replies', f.sigReply)),
    h('div', { class: 'field' }, h('span', { text: 'Account color' }), sw),
    result,
    h('div', { class: 'row-btns' },
      h('button', { class: 'btn', on: { click: e => test(e.currentTarget) } }, icon('sync', 16), h('span', { text: 'Test' })),
      h('button', { class: 'btn primary', on: { click: e => save(e.currentTarget) } }, icon('save', 16), h('span', { text: 'Save' })),
      !isNew ? h('button', { class: 'btn danger push-right', on: { click: () => removeAccount(pane, a) } }, icon('delete', 16), h('span', { text: 'Delete' })) : null));
}
