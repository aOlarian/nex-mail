/* MAP
 * §1 signature editor               L13-L58
 * §2 default signature per mailbox  L59-L129
 */
// Signatures tab: create/edit independent named signatures and pick default per mailbox.
import { h, clear } from './mail-util.js';
import { icon } from './mail-icons.js';
import { S, groupAccountsByCategory, signatureById } from './mail-state.js';
import { api } from './mail-api.js';
import { confirmDialog, toast, field } from './mail-ui.js';
import { createEditor } from './mail-editor.js';

// §1 signature editor
export function renderSignatures(pane, selId, selAccId) {
  clear(pane);
  const sigs = S.signatures;
  const cur = sigs.find(s => s.id === selId) || sigs[0] || null;
  let activeAccId = selAccId || (S.accounts && S.accounts[0]?.id) || null;

  const side = h('div', { class: 'sig-list' },
    sigs.map(s => h('button', {
      type: 'button', class: 'sig-item' + (cur && s.id === cur.id ? ' on' : ''),
      text: s.name || '(untitled)', on: { click: () => renderSignatures(pane, s.id, activeAccId) },
    })),
    h('button', { type: 'button', class: 'btn ghost sm', on: { click: () => editSig(null) } }, icon('plus', 16), h('span', { text: 'New signature' })));
  const edit = h('div', { class: 'sig-edit' });
  const defSec = h('div', { class: 'sig-def-sec' });
  pane.append(
    h('h3', { text: 'Signatures' }),
    h('p', { class: 'muted', text: 'Create named signatures independently, pick each mailbox default below, or swap signatures per message while composing.' }),
    h('div', { class: 'sig' }, side, edit),
    defSec);

  function editSig(s) {
    clear(edit);
    const name = h('input', { class: 'inp', value: s ? s.name : '', placeholder: 'e.g., Official signature' });
    const ed = createEditor({ html: s ? s.html : '<div>Best regards,</div><div><b>Full Name</b></div>', minHeight: 140 });
    edit.append(field('Name', name), ed.el, h('div', { class: 'row-btns' },
      h('button', { type: 'button', class: 'btn primary', text: 'Save Signature', on: { click: async () => {
        if (!name.value.trim()) { toast('Give the signature a name.', { kind: 'err' }); return; }
        const item = { ...(s && s.id ? { id: s.id } : {}), name: name.value.trim(), html: ed.getHtml() };
        const list = s ? sigs.map(x => (x.id === s.id ? item : x)) : [...sigs, item];
        try {
          S.signatures = await api.saveSignatures(list);
          toast('Signature saved', { kind: 'ok' });
          renderSignatures(pane, (S.signatures.find(x => x.name === item.name) || {}).id, activeAccId);
        } catch (e) { toast(e.message, { kind: 'err' }); }
      } } }),
      s ? h('button', { type: 'button', class: 'btn danger', text: 'Delete', on: { click: async () => {
        if (!(await confirmDialog(`Delete signature "${s.name}"?`, { ok: 'Delete', danger: true }))) return;
        try {
          S.signatures = await api.saveSignatures(sigs.filter(x => x.id !== s.id));
          renderSignatures(pane, null, activeAccId);
        } catch (e) { toast(e.message, { kind: 'err' }); }
      } } }) : null));
  }

  // §2 default signature per mailbox
  async function saveAccountDefaultSig(acc, sigId) {
    const payload = {
      id: acc.id, name: acc.name, email: acc.email, user: acc.user || acc.email, color: acc.color,
      imap: acc.imap, smtp: acc.smtp, insecureTls: !!acc.insecureTls,
      ...(acc.sentFolder ? { sentFolder: acc.sentFolder } : {}),
      groupId: acc.groupId || null,
      signatureNew: sigId || null,
      signatureReply: sigId || null,
    };
    const saved = await api.saveAccount(payload);
    const idx = S.accounts.findIndex(x => x.id === acc.id);
    if (idx >= 0) S.accounts[idx] = { ...S.accounts[idx], ...saved };
  }

  function renderDef() {
    const prevScroll = defSec.querySelector('.sig-acc-list')?.scrollTop || 0;
    const accList = S.accounts || [];
    const curAcc = accList.find(a => a.id === activeAccId) || accList[0] || null;
    if (curAcc) activeAccId = curAcc.id;
    clear(defSec);
    defSec.append(
      h('h4', { text: 'Default signature per mailbox' }),
      h('p', { class: 'muted', text: 'Click a mailbox on the left, then check which signature applies by default for its new emails and replies.' }));
    if (!curAcc) {
      defSec.append(h('p', { class: 'muted', text: 'No mailboxes configured yet.' }));
      return;
    }

    const accCol = h('div', { class: 'sig-acc-list' });
    for (const b of groupAccountsByCategory()) {
      const grp = h('div', { class: 'sig-acc-grp' },
        h('div', { class: 'sig-acc-ghead', style: b.color ? { borderLeftColor: b.color } : null },
          b.color ? h('span', { class: 'acc-color-chip', style: { background: b.color } }) : null,
          h('span', { text: b.name })));
      for (const a of b.items) {
        const def = signatureById(a.signatureNew) || signatureById(a.signatureReply);
        grp.append(h('button', {
          type: 'button', class: 'sig-acc-item' + (a.id === curAcc.id ? ' on' : ''),
          dataset: { accId: a.id },
          on: { click: () => { activeAccId = a.id; renderDef(); } },
        },
        h('span', { class: 'sig-acc-mail', text: a.email }),
        h('span', { class: 'sig-acc-badge', text: def ? def.name : 'None' })));
      }
      accCol.append(grp);
    }

    const activeDefId = curAcc.signatureNew || curAcc.signatureReply || null;
    const sigCol = h('div', { class: 'sig-def-list' },
      h('div', { class: 'sig-def-head', text: `Default for ${curAcc.email}` }));
    if (!sigs.length) {
      sigCol.append(h('p', { class: 'muted', text: 'Create a signature above first.' }));
    } else {
      for (const s of sigs) {
        const cb = h('input', { type: 'checkbox', checked: activeDefId === s.id, dataset: { sigId: s.id } });
        cb.addEventListener('change', async () => {
          const nextId = cb.checked ? s.id : null;
          sigCol.querySelectorAll('input[type="checkbox"]').forEach(x => { x.disabled = true; });
          try {
            await saveAccountDefaultSig(curAcc, nextId);
            toast(nextId ? `Default for ${curAcc.email}: ${s.name}` : `Cleared default for ${curAcc.email}`, { kind: 'ok' });
          } catch (e) {
            toast(e.message, { kind: 'err' });
          }
          renderDef();
        });
        sigCol.append(h('label', { class: 'check sig-def-row' }, cb, h('span', { text: s.name || '(untitled)' })));
      }
    }
    defSec.append(h('div', { class: 'sig-def' }, accCol, sigCol));
    if (prevScroll) accCol.scrollTop = prevScroll;
  }

  editSig(cur);
  renderDef();
}
