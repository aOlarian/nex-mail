/* MAP
 * §1 constants and helpers           L21-L47
 * §2 initial state by mode           L48-L82
 * §3 open composer & form            L83-L137
 * §4 attachments                     L138-L164
 * §5 send, draft, discard            L165-L230
 * §6 signature switching             L231-L246
 */
// Message composer inside reading pane: new message, reply, reply all, forward, draft, signature picker.
import { h, clear, escapeHtml, fmtAddr, fmtFull, fmtSize, prefixSubject, fileKind, hhmm } from './mail-util.js';
import { icon } from './mail-icons.js';
import { S, isVirtualAcc, emit, accountById, signatureById, ownAddresses, folderByUse } from './mail-state.js';
import { api } from './mail-api.js';
import { toast, confirmDialog, selectEl } from './mail-ui.js';
import { createEditor } from './mail-editor.js';
import { cleanHtml } from './mail-sanitize.js';
import { createRecipients } from './mail-recipients.js';
import { textToHtml } from './mail-frame.js';
import { refreshCounts } from './mail-actions.js';

// §1 constants and helpers
const MAX_ATT = 25 * 1024 * 1024;
const AUTOSAVE_MS = 30000;
const QUOTE_FONT = 'font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#000000';
const lower = a => String(a && a.address || '').toLowerCase();

function uniqAddrs(list, skip) {
  const seen = new Set(skip), out = [];
  for (const a of list || []) { const k = lower(a); if (k && !seen.has(k)) { seen.add(k); out.push(a); } }
  return out;
}

function sigHtml(acc, mode) {
  const sig = acc && signatureById(mode === 'new' ? acc.signatureNew : acc.signatureReply);
  return sig ? sig.html : '';
}

function quoteHtml(m) {
  const line = (k, v) => (v ? `<b>${k}:</b> ${escapeHtml(v)}<br>` : '');
  const head = line('From', fmtAddr(m.from)) + line('Sent', fmtFull(m.date)) + line('To', (m.to || []).map(fmtAddr).join('; '))
    + line('Cc', (m.cc || []).map(fmtAddr).join('; ')) + line('Subject', m.subject || '');
  const body = m.html ? m.html : textToHtml(m.text || '');
  return `<div class="nex-quote"><hr style="border:none;border-top:1px solid #b5c4df;margin:12px 0"><div style="${QUOTE_FONT}">${head}</div><br><div>${body}</div></div>`;
}

const wrapHtml = inner => `<!doctype html><html><head><meta charset="utf-8"></head><body><div style="${QUOTE_FONT}">${inner}</div></body></html>`;

// §2 initial state by mode
function initial(opts) {
  const m = opts.msg, ref = opts.ref || S.open;
  const fallbackAcc = (ref && ref.account && !isVirtualAcc(ref.account)) ? ref.account : (!isVirtualAcc(S.cur.account) ? S.cur.account : null);
  const acc = accountById((opts.account && !isVirtualAcc(opts.account)) ? opts.account : fallbackAcc) || S.accounts[0];
  const own = ownAddresses();
  const c = { mode: opts.mode, account: acc.id, to: [], cc: [], bcc: [], subject: '', body: '', inReplyTo: null, references: [], forward: null, replyTo: null, draft: null, origAtts: [] };
  const sig = s => (s ? `<div><br></div><div class="nex-signature">${s}</div>` : '');
  if (opts.mode === 'new') {
    if (opts.to) c.to = [{ name: '', address: opts.to }];
    c.body = `<div><br></div>${sig(sigHtml(acc, 'new'))}`;
    return c;
  }
  if (opts.mode === 'draft') {
    Object.assign(c, { to: m.to || [], cc: m.cc || [], subject: m.subject || '', inReplyTo: m.inReplyTo || null, references: m.references || [], draft: { folder: ref.folder, uid: m.uid } });
    c.body = m.html || textToHtml(m.text || '');
    return c;
  }
  const refs = [...(m.references || []), m.messageId].filter(Boolean);
  if (opts.mode === 'forward') {
    Object.assign(c, { subject: prefixSubject('Fw:', m.subject), forward: { account: ref.account, folder: ref.folder, uid: m.uid }, references: refs, origAtts: (m.attachments || []).filter(a => !a.inline) });
  } else {
    const sender = (m.replyTo && m.replyTo.length) ? m.replyTo : [m.from];
    const fromMe = own.has(lower(m.from));
    c.to = fromMe ? uniqAddrs(m.to, []) : uniqAddrs(sender, []);
    if (opts.mode === 'replyAll') {
      c.to = uniqAddrs([...c.to, ...(m.to || [])], own);
      c.cc = uniqAddrs(m.cc, [...own, ...c.to.map(lower)]);
    }
    Object.assign(c, { subject: prefixSubject('Re:', m.subject), inReplyTo: m.messageId || null, references: refs, replyTo: { account: ref.account, folder: ref.folder, uid: m.uid } });
  }
  c.body = `<div><br></div>${sig(sigHtml(acc, 'reply'))}${quoteHtml(m)}`;
  return c;
}

// §3 open composer & form
export async function openCompose(opts) {
  if (!S.accounts.length) { emit('openSettings', { tab: 'accounts', add: true }); return; }
  if (S.compose && S.compose.dirty) await S.compose.saveDraft(true);
  if (S.compose) S.compose.close();
  const c = initial(opts);
  const root = document.getElementById('reader');
  clear(root);
  const st = { ...c, dirty: false, atts: [], sending: false };
  const mark = () => { st.dirty = true; };
  const from = selectEl(S.accounts.map(a => [a.id, `${a.name} <${a.email}>`]), c.account, { 'aria-label': 'From' });
  const to = createRecipients('To', c.to, mark), cc = createRecipients('Cc', c.cc, mark), bcc = createRecipients('Bcc', c.bcc, mark);
  st.dirty = false;
  const subject = h('input', { class: 'inp cp-subject', value: c.subject, placeholder: 'Add a subject', 'aria-label': 'Subject', on: { input: mark } });
  const ccRow = h('div', { class: 'cp-row', hidden: !c.cc.length }, cc.el), bccRow = h('div', { class: 'cp-row', hidden: true }, bcc.el);
  const ed = createEditor({ html: c.body, placeholder: 'Write your message here...', onChange: mark, onFiles: files => { el.classList.remove('dragging'); addFiles(files); } });
  const attBox = h('div', { class: 'cp-atts' });
  const status = h('span', { class: 'cp-status muted' });
  const fileIn = h('input', { type: 'file', multiple: true, hidden: true, on: { change: () => { addFiles([...fileIn.files]); fileIn.value = ''; } } });
  const sendBtn = h('button', { class: 'btn primary', title: 'Send (Ctrl+Enter)', on: { click: () => send() } }, icon('send', 16), h('span', { text: 'Send' }));

  const defAcc = accountById(c.account);
  const defSigId = defAcc ? (c.mode === 'new' ? defAcc.signatureNew : defAcc.signatureReply) || '' : '';
  const sigSel = selectEl([['__prompt__', 'Insert signature'], ['', 'No signature'], ...S.signatures.map(s => [s.id, s.name])], defSigId || '__prompt__', { class: 'cp-sig-sel', title: 'Insert signature', 'aria-label': 'Insert signature' });
  sigSel.addEventListener('change', () => {
    if (sigSel.value === '__prompt__') return;
    const sig = signatureById(sigSel.value);
    swapSignatureHtml(ed, sig ? sig.html : '');
    mark();
  });

  from.addEventListener('change', () => {
    const acc = accountById(from.value);
    const sid = acc ? (c.mode === 'new' ? acc.signatureNew : acc.signatureReply) || '' : '';
    sigSel.value = sid || '__prompt__';
    swapSignature(ed, acc, c.mode === 'new' ? 'new' : 'reply');
    st.account = from.value; mark();
  });
  const el = h('div', { class: 'cp', role: 'form', 'aria-label': 'Compose message' },
    h('div', { class: 'cp-bar' }, sendBtn,
      h('button', { class: 'btn ghost', on: { click: () => fileIn.click() } }, icon('attach', 16), h('span', { text: 'Attach' })),
      h('button', { class: 'btn ghost', on: { click: () => saveDraft(false) } }, icon('save', 16), h('span', { text: 'Save draft' })),
      sigSel,
      h('button', { class: 'btn ghost', on: { click: () => discard() } }, icon('delete', 16), h('span', { text: 'Discard' })),
      status, fileIn),
    h('div', { class: 'cp-row' }, h('span', { class: 'rc-label', text: 'From' }), from),
    h('div', { class: 'cp-row' }, to.el,
      h('button', { class: 'btn link sm', text: 'Cc', on: { click: () => { ccRow.hidden = false; cc.focus(); } } }),
      h('button', { class: 'btn link sm', text: 'Bcc', on: { click: () => { bccRow.hidden = false; bcc.focus(); } } })),
    ccRow, bccRow,
    h('div', { class: 'cp-row' }, subject),
    attBox, ed.el,
    h('div', { class: 'cp-drop', text: 'Drop files here to attach' }));
  root.append(el);

  // §4 attachments
  function addFiles(files) {
    for (const f of files) {
      const total = st.atts.reduce((s, a) => s + a.size, 0) + f.size;
      if (total > MAX_ATT) { toast(`"${f.name}" exceeds the 25 MB total attachment limit.`, { kind: 'err' }); continue; }
      const a = { filename: f.name, contentType: f.type || 'application/octet-stream', size: f.size, dataB64: null };
      st.atts.push(a);
      const r = new FileReader();
      r.onload = () => { a.dataB64 = String(r.result).split(',')[1] || ''; renderAtts(); };
      r.onerror = () => { st.atts.splice(st.atts.indexOf(a), 1); toast(`Could not read "${f.name}".`, { kind: 'err' }); renderAtts(); };
      r.readAsDataURL(f);
    }
    mark(); renderAtts();
  }
  function renderAtts() {
    clear(attBox);
    for (const a of c.origAtts) attBox.append(h('span', { class: 'att small', title: 'From original message' }, icon(fileKind(a.filename, a.contentType), 18), h('span', { class: 'att-name', text: a.filename }), h('span', { class: 'att-size muted', text: fmtSize(a.size) })));
    st.atts.forEach((a, i) => attBox.append(h('span', { class: 'att small' + (a.dataB64 == null ? ' busy' : '') },
      icon(fileKind(a.filename, a.contentType), 18), h('span', { class: 'att-name', text: a.filename }), h('span', { class: 'att-size muted', text: a.dataB64 == null ? 'loading...' : fmtSize(a.size) }),
      h('button', { class: 'chip-x', 'aria-label': `Remove ${a.filename}`, on: { click: () => { st.atts.splice(i, 1); mark(); renderAtts(); } } }, icon('close', 12)))));
    if (st.atts.length) attBox.append(h('span', { class: 'muted cp-limit', text: `${fmtSize(st.atts.reduce((s, a) => s + a.size, 0))} of 25 MB` }));
  }
  renderAtts();
  el.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); el.classList.add('dragging'); } });
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('dragging'); });
  el.addEventListener('drop', e => { el.classList.remove('dragging'); if (e.dataTransfer.files.length) { e.preventDefault(); addFiles([...e.dataTransfer.files]); } });

  // §5 send, draft, discard
  function payload() {
    return {
      account: from.value, to: to.get(), cc: cc.get(), bcc: bcc.get(), subject: subject.value.trim(),
      html: wrapHtml(ed.getHtml()), inReplyTo: c.inReplyTo, references: c.references,
      attachments: st.atts.filter(a => a.dataB64 != null).map(({ filename, contentType, dataB64 }) => ({ filename, contentType, dataB64 })),
      forward: c.forward || undefined, replyTo: c.replyTo || undefined,
      draft: st.draft && st.draftAccount === from.value ? st.draft : undefined,
    };
  }
  async function send() {
    if (st.sending) return;
    const p = payload();
    const bad = [...to.invalid(), ...cc.invalid(), ...bcc.invalid()];
    if (!p.to.length && !p.cc.length && !p.bcc.length) { toast('Add at least one recipient.', { kind: 'err' }); to.focus(); return; }
    if (bad.length) { toast(`Invalid addresses: ${bad.join(', ')}`, { kind: 'err' }); return; }
    if (st.atts.some(a => a.dataB64 == null)) { toast('Wait for attachments to finish loading.', { kind: 'err' }); return; }
    if (!p.subject && !(await confirmDialog('This message has no subject. Send anyway?', { ok: 'Send' }))) return;
    st.sending = true; sendBtn.disabled = true;
    const t = toast('Sending message...', { kind: 'busy' });
    try {
      const r = await api.send(p);
      t.update(r.sentSaved === false ? 'Sent (could not save a copy in Sent)' : 'Message sent', 'ok');
      if (c.replyTo) { const it = S.list.items.find(i => i.uid === c.replyTo.uid && (i.folder || S.cur.folder) === c.replyTo.folder && (!c.replyTo.account || (i.account || S.cur.account) === c.replyTo.account)); if (it) it.answered = true; }
      close();
      refreshCounts();
      if (p.draft) emit('reloadList');
    } catch (e) {
      t.update('Send failed: ' + e.message, 'err');
      st.sending = false; sendBtn.disabled = false;
    }
  }
  async function saveDraft(silent) {
    if (st.sending) return;
    const p = payload();
    try {
      const r = await api.draft(p);
      st.draft = { folder: r.folder, uid: r.uid }; st.draftAccount = p.account; st.dirty = false;
      status.textContent = `Draft saved at ${hhmm(new Date())}`;
      if (!silent) toast('Draft saved', { kind: 'ok' });
      const df = folderByUse(p.account, '\\Drafts');
      if (df && S.cur.account === p.account && S.cur.folder === df.path) emit('reloadList');
    } catch (e) { status.textContent = 'Could not save draft'; toast('Could not save draft: ' + e.message, { kind: 'err' }); }
  }
  async function discard() {
    if (st.dirty || st.draft) {
      const ok = await confirmDialog(st.draft ? 'Discard this message? The saved draft will be deleted.' : 'Discard this message? Unsaved changes will be lost.', { ok: 'Discard', cancel: 'Keep editing', danger: true });
      if (!ok) return;
      if (st.draft) { try { await api.remove(st.draftAccount, st.draft.folder, [st.draft.uid], true); emit('reloadList'); } catch (e) { toast('Could not delete draft: ' + e.message, { kind: 'err' }); } }
    }
    close();
  }
  function close() {
    clearInterval(timer);
    S.compose = null;
    emit('composeChanged');
  }
  const timer = setInterval(() => { if (st.dirty && !st.sending) saveDraft(true); }, AUTOSAVE_MS);
  el.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); } });

  if (c.draft) { st.draft = c.draft; st.draftAccount = c.account; }
  S.compose = { el, saveDraft, close, send, get dirty() { return st.dirty; } };
  emit('composeChanged');
  if (c.mode === 'forward' || (c.mode === 'new' && !c.to.length)) to.focus(); else ed.focusStart();
}

// §6 signature switching
function swapSignature(ed, acc, mode) {
  swapSignatureHtml(ed, sigHtml(acc, mode));
}

function swapSignatureHtml(ed, html) {
  let sig = [...ed.content.querySelectorAll('.nex-signature')].find(n => !n.closest('.nex-quote'));
  if (!html) { if (sig) sig.remove(); return; }
  if (!sig) {
    sig = document.createElement('div');
    sig.className = 'nex-signature';
    const q = ed.content.querySelector('.nex-quote');
    if (q) q.before(sig); else ed.content.append(sig);
  }
  sig.innerHTML = cleanHtml(html);
}
