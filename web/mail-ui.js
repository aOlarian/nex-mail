/* MAP
 * §1 toast  L12-L37
 * §2 dialoguri  L38-L104
 * §3 meniuri (cu hover submeniuri)  L105-L183
 * §4 Esc global: meniu -> dialog  L184-L191
 * §5 elemente de formular  L192-L200
 */
// Componente generice: toast, dialoguri (stiva, Esc), confirmare, prompt, meniuri contextuale.
import { h, clear } from './mail-util.js';
import { icon } from './mail-icons.js';

// §1 toast
export function toast(text, opts = {}) {
  const box = document.getElementById('toasts');
  const msg = h('span', { class: 'toast-text', text });
  const el = h('div', { class: 'toast ' + (opts.kind || 'info'), role: 'status' },
    opts.kind === 'busy' ? h('span', { class: 'spinner' }) : null, msg);
  if (opts.action) el.append(h('button', { class: 'btn link', text: opts.action.label, on: { click: () => { opts.action.fn(); close(); } } }));
  el.append(h('button', { class: 'icon-btn sm', title: 'Close', 'aria-label': 'Close', on: { click: () => close() } }, icon('close', 14)));
  // cel mult 4 toast-uri vizibile; cele vechi pleaca primele
  while (box.children.length >= 4) box.firstElementChild.remove();
  box.append(el);
  let timer = 0;
  const arm = ms => { clearTimeout(timer); if (ms) timer = setTimeout(close, ms); };
  function close() { clearTimeout(timer); el.remove(); }
  arm(opts.ms ?? (opts.kind === 'busy' ? 0 : opts.kind === 'err' ? 8000 : 4000));
  return {
    update(t, kind) {
      msg.textContent = t;
      el.className = 'toast ' + kind;
      el.querySelector('.spinner')?.remove();
      arm(kind === 'err' ? 8000 : 4000);
    },
    close,
  };
}

// §2 dialoguri
const stack = [];
export function openDialog({ title, body, buttons = [], cls = '', onClose, beforeClose }) {
  const back = h('div', { class: 'dlg-back' });
  const foot = h('div', { class: 'dlg-foot' });
  const dlg = h('div', { class: 'dlg ' + cls, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'dlg-head' },
      h('h2', { text: title }),
      h('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close', on: { click: () => api.close() } }, icon('close'))),
    h('div', { class: 'dlg-body' }, body), foot);
  back.append(dlg);
  back.addEventListener('mousedown', e => { if (e.target === back) api.close(); });
  const api = {
    el: dlg, foot,
    async close(force) {
      if (!force && beforeClose && !(await beforeClose())) return;
      const i = stack.indexOf(api);
      if (i >= 0) stack.splice(i, 1);
      back.remove();
      onClose && onClose();
    },
    setButtons(list) {
      clear(foot);
      for (const b of list) {
        foot.append(h('button', { class: 'btn ' + (b.kind || ''), text: b.label, disabled: b.disabled, on: { click: () => b.onClick(api) } }));
      }
    },
  };
  api.setButtons(buttons);
  document.body.append(back);
  stack.push(api);
  setTimeout(() => (dlg.querySelector('[autofocus], input, select, textarea, .btn.primary') || dlg).focus(), 0);
  return api;
}

export const dialogOpen = () => stack.length > 0;

export function confirmDialog(text, { title = 'Confirm', ok = 'Yes', cancel = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    let done = false;
    const d = openDialog({
      title, cls: 'small', body: h('p', { class: 'dlg-text', text }),
      onClose: () => { if (!done) resolve(false); },
      buttons: [
        { label: ok, kind: danger ? 'danger' : 'primary', onClick: x => { done = true; resolve(true); x.close(true); } },
        { label: cancel, onClick: x => x.close(true) },
      ],
    });
    return d;
  });
}

export function promptDialog({ title, label, message, value = '', type = 'text', ok, confirmText = 'OK', placeholder = '' }) {
  return new Promise(resolve => {
    let done = false;
    const input = h('input', { class: 'inp', type, value, placeholder, autofocus: true });
    const submit = x => { done = true; resolve(input.value.trim()); x.close(true); };
    const d = openDialog({
      title, cls: 'small', body: h('label', { class: 'field' }, h('span', { text: label || message || '' }), input),
      onClose: () => { if (!done) resolve(null); },
      buttons: [{ label: ok || confirmText, kind: 'primary', onClick: submit }, { label: 'Cancel', onClick: x => x.close(true) }],
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(d); });
    setTimeout(() => input.select(), 0);
  });
}

// §3 meniuri (cu hover submeniuri)
let openMenus = [];
let hoverTimer = 0;
export function closeMenus(from = 0) {
  clearTimeout(hoverTimer);
  for (const m of openMenus.splice(from)) m.remove();
}

export function openMenu(at, items, level = 0) {
  closeMenus(level);
  const menu = h('div', { class: 'menu', role: 'menu' });
  let activeSubRow = null;
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { menu.append(h('div', { class: 'menu-sep' })); continue; }
    if (it.header) { menu.append(h('div', { class: 'menu-head', text: it.header })); continue; }
    const row = h('button', { class: 'menu-item' + (it.danger ? ' danger' : ''), role: 'menuitem', disabled: it.disabled, style: it.indent ? { paddingLeft: (10 + it.indent * 14) + 'px' } : null },
      it.checked !== undefined ? h('span', { class: 'menu-check' }, it.checked ? icon('check', 16) : null) : null,
      it.swatch ? h('span', { class: 'menu-swatch', style: { background: it.swatch } }) : null,
      it.color ? h('span', { class: 'dot', style: { background: it.color } }) : null,
      it.icon ? icon(it.icon, 16) : null,
      h('span', { class: 'menu-label', text: it.label }),
      it.sub ? icon('chevRight', 14, 'menu-sub') : null);
    row.addEventListener('mouseenter', () => {
      clearTimeout(hoverTimer);
      if (it.disabled) return;
      hoverTimer = setTimeout(() => {
        if (!menu.isConnected) return;
        if (it.sub) {
          if (activeSubRow === row && openMenus[level + 1]) return;
          activeSubRow = row;
          openMenu(row, typeof it.sub === 'function' ? it.sub() : it.sub, level + 1);
        } else {
          activeSubRow = null;
          closeMenus(level + 1);
        }
      }, it.sub ? 60 : 90);
    });
    row.addEventListener('click', e => {
      e.stopPropagation();
      if (it.sub) { activeSubRow = row; openMenu(row, typeof it.sub === 'function' ? it.sub() : it.sub, level + 1); return; }
      if (!it.keep) closeMenus();
      it.onClick && it.onClick(row);
    });
    menu.append(row);
  }
  document.body.append(menu);
  openMenus.push(menu);
  place(menu, at, level > 0);
  menu.addEventListener('keydown', e => {
    const rows = [...menu.querySelectorAll('.menu-item:not([disabled])')];
    const i = rows.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { rows[(i + 1) % rows.length]?.focus(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { rows[(i - 1 + rows.length) % rows.length]?.focus(); e.preventDefault(); }
    if (e.key === 'ArrowLeft' && level > 0) { closeMenus(level); e.preventDefault(); }
  });
  if (level === 0) menu.querySelector('.menu-item:not([disabled])')?.focus({ preventScroll: true });
  return menu;
}

function place(menu, at, side) {
  const vw = innerWidth, vh = innerHeight, r = menu.getBoundingClientRect();
  let x, y;
  if (at instanceof Element) {
    const a = at.getBoundingClientRect();
    x = side ? a.right : a.left;
    y = side ? a.top : a.bottom + 2;
    if (side && x + r.width > vw) x = a.left - r.width;
  } else { x = at.x; y = at.y; }
  if (x + r.width > vw - 4) x = vw - r.width - 4;
  if (y + r.height > vh - 4) y = Math.max(4, vh - r.height - 4);
  menu.style.left = Math.max(4, x) + 'px';
  menu.style.top = Math.max(4, y) + 'px';
}

document.addEventListener('mousedown', e => {
  if (openMenus.length && !openMenus.some(m => m.contains(e.target))) closeMenus();
}, true);

// §4 Esc global: meniu → dialog
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (openMenus.length) { closeMenus(openMenus.length - 1); e.preventDefault(); return; }
  if (stack.length) { stack[stack.length - 1].close(); e.preventDefault(); e.stopPropagation(); }
}, true);
export const menuOpen = () => openMenus.length > 0;

// §5 elemente de formular
export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { text: label }), input, hint ? h('small', { class: 'hint', text: hint }) : null);
}
export function selectEl(options, value, attrs = {}) {
  const s = h('select', { class: 'inp', ...attrs });
  for (const [v, l] of options) s.append(h('option', { value: v, text: l, selected: String(v) === String(value) }));
  return s;
}
