/* MAP
 * §1 list navigation   L12-L24
 * §2 keyboard shortcuts L25-L52
 */
// Outlook-style keyboard shortcuts. Escape for dialogs/menus is handled in mail-ui.js.
import { S, emit, msgKey } from './mail-state.js';
import { dialogOpen, menuOpen } from './mail-ui.js';
import { deleteMessages, toggleFlag, toggleSeen } from './mail-actions.js';
import { selectOne } from './mail-list.js';
import { setMobilePane } from './mail-layout.js';

// §1 list navigation
function moveFocus(d) {
  const keys = [...document.querySelectorAll('#list .row:not(.skel)')].map(el => el.dataset.key).filter(Boolean);
  if (!keys.length) return;
  const openKey = S.open ? msgKey(S.open) : null;
  const cur = openKey ? keys.indexOf(openKey) : -1;
  const key = keys[Math.min(keys.length - 1, Math.max(0, cur + d))];
  if (!key) return;
  selectOne(key);
  document.querySelector(`#list .row[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
}

// §2 keyboard shortcuts
function onKey(e) {
  if (dialogOpen() || menuOpen()) return;
  const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
  const inField = e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]');
  if ((ctrl && k === 'n' && !e.shiftKey) || (!inField && !ctrl && !e.altKey && k === 'n')) { e.preventDefault(); emit('compose', { mode: 'new' }); return; }
  if (inField || S.compose) return;
  if (S.view !== 'mail') return;
  const m = S.msg;
  if (ctrl && e.shiftKey && k === 'r') { e.preventDefault(); if (m) emit('compose', { mode: 'replyAll', msg: m }); return; }
  if (ctrl && !e.shiftKey && k === 'r') { e.preventDefault(); if (m) emit('compose', { mode: 'reply', msg: m }); return; }
  if (ctrl && e.shiftKey && k === 'f') { e.preventDefault(); if (m) emit('compose', { mode: 'forward', msg: m }); return; }
  if (ctrl && k === 'q') { e.preventDefault(); toggleSeen(); return; }
  if (ctrl || e.altKey) return;
  if (e.key === 'Delete') { e.preventDefault(); deleteMessages(null, e.shiftKey); return; }
  if (e.key === 'Insert') { e.preventDefault(); toggleFlag(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1); return; }
  if (e.key === 'Enter') {
    if (S.sel.size === 1) {
      const key = [...S.sel][0];
      if (!S.open || msgKey(S.open) !== key) selectOne(key);
      if (S.mobile) setMobilePane('reader');
    }
  }
}

export function initKeys() { document.addEventListener('keydown', onKey); }
