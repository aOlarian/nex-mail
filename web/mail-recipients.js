/* MAP
 * §1 component     L10-L41
 * §2 autocomplete  L42-L94
 */
// Recipients field with chips and autocomplete from /api/mail/contacts.
import { h, clear, parseAddrList, validEmail, fmtAddr, debounce, initials, colorFor } from './mail-util.js';
import { icon } from './mail-icons.js';
import { api } from './mail-api.js';

// §1 component
export function createRecipients(label, initial = [], onChange) {
  const list = [];
  const chips = h('div', { class: 'rc-chips' });
  const input = h('input', { class: 'rc-input', type: 'text', autocomplete: 'off', 'aria-label': label, spellcheck: 'false' });
  const drop = h('div', { class: 'rc-drop', role: 'listbox', hidden: true });
  const box = h('div', { class: 'rc-box', on: { click: () => input.focus() } }, chips, input);
  const el = h('div', { class: 'rc' }, h('span', { class: 'rc-label', text: label }), box, drop);
  let sugg = [], hi = -1, seq = 0;

  function add(a) {
    if (!a || !a.address) return;
    if (list.some(x => x.address.toLowerCase() === a.address.toLowerCase())) return;
    list.push(a);
    renderChips(); onChange && onChange();
  }
  function remove(i) { list.splice(i, 1); renderChips(); onChange && onChange(); }
  function renderChips() {
    clear(chips);
    list.forEach((a, i) => chips.append(h('span', { class: 'chip rc-chip' + (validEmail(a.address) ? '' : ' bad'), title: fmtAddr(a) + (validEmail(a.address) ? '' : ' (invalid address)') },
      h('span', { class: 'avatar xs', style: { background: colorFor(a.address) }, text: initials(a) }),
      h('span', { text: a.name || a.address }),
      h('button', { class: 'chip-x', type: 'button', 'aria-label': `Remove ${a.address}`, on: { click: e => { e.stopPropagation(); remove(i); } } }, icon('close', 12)))));
  }
  function commit() {
    const v = input.value.trim();
    if (!v) return;
    parseAddrList(v).forEach(add);
    input.value = '';
    hide();
  }

  // §2 autocomplete
  const search = debounce(async q => {
    const my = ++seq;
    if (q.length < 2) { hide(); return; }
    try {
      const r = await api.contacts(q);
      if (my !== seq || input.value.trim() !== q) return;
      sugg = (r.items || []).filter(c => !list.some(x => x.address.toLowerCase() === c.address.toLowerCase()));
      showDrop();
    } catch (e) { console.warn('[mail] contacts', e.message); }
  }, 200);
  function showDrop() {
    clear(drop);
    hi = sugg.length ? 0 : -1;
    if (!sugg.length) { hide(); return; }
    sugg.forEach((c, i) => drop.append(h('div', { class: 'rc-opt' + (i === hi ? ' hi' : ''), role: 'option', on: { mousedown: e => { e.preventDefault(); pick(i); } } },
      h('span', { class: 'avatar xs', style: { background: colorFor(c.address) }, text: initials(c) }),
      h('span', { class: 'rc-opt-name', text: c.name || c.address }), c.name ? h('span', { class: 'muted', text: c.address }) : null)));
    drop.hidden = false;
  }
  function hide() { drop.hidden = true; sugg = []; hi = -1; }
  function pick(i) { add(sugg[i]); input.value = ''; hide(); input.focus(); }
  function mark() { [...drop.children].forEach((c, i) => c.classList.toggle('hi', i === hi)); }

  input.addEventListener('input', () => {
    if (/[,;]/.test(input.value)) { commit(); return; }
    search(input.value.trim());
  });
  input.addEventListener('keydown', e => {
    if (!drop.hidden && sugg.length) {
      if (e.key === 'ArrowDown') { hi = (hi + 1) % sugg.length; mark(); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { hi = (hi - 1 + sugg.length) % sugg.length; mark(); e.preventDefault(); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && hi >= 0) { pick(hi); e.preventDefault(); return; }
      if (e.key === 'Escape') { hide(); e.stopPropagation(); return; }
    }
    if (e.key === 'Enter' && !e.ctrlKey) { commit(); e.preventDefault(); }
    if (e.key === 'Backspace' && !input.value && list.length) remove(list.length - 1);
  });
  input.addEventListener('blur', () => setTimeout(() => { commit(); hide(); }, 150));
  input.addEventListener('paste', e => {
    const t = e.clipboardData.getData('text/plain');
    if (/[,;\n]/.test(t)) { e.preventDefault(); parseAddrList(t).forEach(add); }
  });

  initial.forEach(add);
  return {
    el, input,
    get: () => { commit(); return list.map(fmtAddr); },
    list: () => list,
    invalid: () => list.filter(a => !validEmail(a.address)).map(a => a.address),
    add, focus: () => input.focus(),
  };
}
