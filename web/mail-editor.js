/* MAP
 * §1 configuration                   L13-L21
 * §2 editor creation & toolbar       L22-L93
 * §3 special commands                L94-L125
 * §4 paste, shortcuts, drop, selection L126-L172
 */
// Reusable rich text editor (compose + signatures): contenteditable + inline CSS styles for consistent email HTML.
import { h } from './mail-util.js';
import { icon } from './mail-icons.js';
import { openMenu, promptDialog, toast } from './mail-ui.js';
import { cleanHtml } from './mail-sanitize.js';

// §1 configuration
const FONTS = [['Calibri, Arial, sans-serif', 'Calibri'], ['Arial, Helvetica, sans-serif', 'Arial'], ['"Segoe UI", system-ui, sans-serif', 'Segoe UI'],
  ['Verdana, Geneva, sans-serif', 'Verdana'], ['Tahoma, sans-serif', 'Tahoma'], ['"Times New Roman", Times, serif', 'Times New Roman'],
  ['Georgia, serif', 'Georgia'], ['"Courier New", Courier, monospace', 'Courier New']];
const SIZES = ['8', '9', '10', '11', '12', '14', '16', '18', '20', '24', '28', '36'];
export const PALETTE = ['#000000', '#444444', '#888888', '#c00000', '#e74c3c', '#ff8c00', '#f1c40f', '#2e9e44', '#0f6cbd', '#00a2d4',
  '#7030a0', '#c239b3', '#ffffff', '#ffff00', '#9de09d', '#a6d8f5', '#f8c8dc', '#ffd8a8'];
const MAX_INLINE_IMG = 5 * 1024 * 1024;

// §2 editor creation & toolbar
export function createEditor({ html = '', placeholder = '', onChange, onFiles, minHeight = 200 } = {}) {
  const content = h('div', { class: 'ed-content', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Message body', 'data-placeholder': placeholder, spellcheck: 'true', style: { minHeight: minHeight + 'px' } });
  let range = null;
  const changed = () => onChange && onChange();

  const exec = (cmd, val) => {
    const s = getSelection();
    const inside = s.rangeCount > 0 && content.contains(s.getRangeAt(0).commonAncestorContainer);
    content.focus();
    if (!inside && range) { s.removeAllRanges(); s.addRange(range); }
    document.execCommand('styleWithCSS', false, true);
    document.execCommand(cmd, false, val);
    saveRange(); refresh(); changed();
  };
  const saveRange = () => {
    const s = getSelection();
    if (s.rangeCount && content.contains(s.getRangeAt(0).commonAncestorContainer)) range = s.getRangeAt(0).cloneRange();
  };

  const btn = (ic, title, fn, state, cls) => {
    const b = h('button', { type: 'button', class: 'ed-btn' + (cls ? ' ' + cls : ''), title, 'aria-label': title, dataset: state ? { state } : {} }, icon(ic, 16));
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => fn(b));
    return b;
  };
  const fontSel = h('select', { class: 'ed-sel', title: 'Font', 'aria-label': 'Font' },
    FONTS.map(([v, l]) => h('option', { value: v, text: l })));
  fontSel.addEventListener('change', () => exec('fontName', fontSel.value));
  const sizeSel = h('select', { class: 'ed-sel sm', title: 'Size', 'aria-label': 'Font size' },
    SIZES.map(s => h('option', { value: s, text: s, selected: s === '11' })));
  sizeSel.addEventListener('change', () => setSize(sizeSel.value));

  const colorBtn = btn('textColor', 'Text color', b => colorMenu(b, 'foreColor'), null, 'ed-color');
  colorBtn.style.setProperty('--ed-swatch', '#d13438');
  const bgBtn = btn('highlight', 'Highlight color', b => colorMenu(b, 'hiliteColor'), null, 'ed-bg');
  bgBtn.style.setProperty('--ed-swatch', '#fff100');

  const colorMenu = (b, cmd) => openMenu(b, PALETTE.map(c => ({
    label: c, swatch: c, color: c,
    onClick: () => { b.style.setProperty('--ed-swatch', c); exec(cmd, c); },
  })));
  const imgInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  imgInput.addEventListener('change', () => { [...imgInput.files].forEach(insertImage); imgInput.value = ''; });

  const bar = h('div', { class: 'ed-bar', role: 'toolbar', 'aria-label': 'Formatting' },
    fontSel, sizeSel, h('span', { class: 'ed-sep' }),
    btn('bold', 'Bold (Ctrl+B)', () => exec('bold'), 'bold'),
    btn('italic', 'Italic (Ctrl+I)', () => exec('italic'), 'italic'),
    btn('underline', 'Underline (Ctrl+U)', () => exec('underline'), 'underline'),
    btn('strike', 'Strikethrough', () => exec('strikeThrough'), 'strikeThrough'),
    colorBtn, bgBtn,
    h('span', { class: 'ed-sep' }),
    btn('alignLeft', 'Align left', () => exec('justifyLeft'), 'justifyLeft'),
    btn('alignCenter', 'Center', () => exec('justifyCenter'), 'justifyCenter'),
    btn('alignRight', 'Align right', () => exec('justifyRight'), 'justifyRight'),
    btn('alignJustify', 'Justify', () => exec('justifyFull'), 'justifyFull'),
    h('span', { class: 'ed-sep' }),
    btn('listUl', 'Bulleted list', () => exec('insertUnorderedList'), 'insertUnorderedList'),
    btn('listOl', 'Numbered list', () => exec('insertOrderedList'), 'insertOrderedList'),
    btn('outdent', 'Decrease indent', () => exec('outdent')),
    btn('indent', 'Increase indent', () => exec('indent')),
    h('span', { class: 'ed-sep' }),
    btn('link', 'Insert link', addLink),
    btn('image', 'Insert image', () => imgInput.click()),
    btn('hr', 'Horizontal line', () => exec('insertHorizontalRule')),
    btn('clearFormat', 'Clear formatting', () => { exec('removeFormat'); exec('unlink'); }),
    h('span', { class: 'ed-sep' }),
    btn('undo', 'Undo (Ctrl+Z)', () => exec('undo')),
    btn('redo', 'Redo (Ctrl+Y)', () => exec('redo')),
    imgInput);

  // §3 special commands
  function setSize(pt) {
    exec('fontSize', '7');
    for (const el of content.querySelectorAll('span[style*="xxx-large"], font[size="7"]')) {
      if (el.tagName === 'FONT') { el.removeAttribute('size'); el.style.fontSize = pt + 'pt'; } else el.style.fontSize = pt + 'pt';
    }
    changed();
  }
  async function addLink() {
    const saved = range;
    const url = await promptDialog({ title: 'Insert link', label: 'URL (https://...)', value: 'https://' });
    if (!url || url === 'https://') return;
    if (!/^(https?:|mailto:)/i.test(url)) { toast('Link must start with https:// or mailto:', { kind: 'err' }); return; }
    range = saved;
    if (range && range.collapsed) exec('insertHTML', `<a href="${url.replace(/"/g, '%22')}">${url.replace(/[<>&]/g, '')}</a>`);
    else exec('createLink', url);
  }
  function insertImage(file) {
    if (!/^image\//.test(file.type)) return;
    if (file.size > MAX_INLINE_IMG) { toast('Image exceeds 5 MB; attach it as a file instead.', { kind: 'err' }); return; }
    const r = new FileReader();
    r.onload = () => exec('insertImage', r.result);
    r.readAsDataURL(file);
  }
  function refresh() {
    for (const b of bar.querySelectorAll('[data-state]')) {
      let on = false;
      try { on = document.queryCommandState(b.dataset.state); } catch (e) { on = false; }
      b.classList.toggle('on', on);
    }
  }

  // §4 paste, shortcuts, drop, selection
  content.addEventListener('paste', e => {
    const cd = e.clipboardData;
    const imgs = [...(cd.files || [])].filter(f => /^image\//.test(f.type));
    if (imgs.length) { e.preventDefault(); imgs.forEach(insertImage); return; }
    const html = cd.getData('text/html');
    e.preventDefault();
    if (html) exec('insertHTML', cleanHtml(html));
    else exec('insertText', cd.getData('text/plain'));
  });
  content.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    const map = { b: 'bold', i: 'italic', u: 'underline' };
    if (map[k] && !e.shiftKey) { e.preventDefault(); exec(map[k]); }
  });
  content.addEventListener('input', changed);
  content.addEventListener('drop', e => {
    if (e.dataTransfer && e.dataTransfer.files.length) {
      e.preventDefault();
      e.stopPropagation();
      const files = [...e.dataTransfer.files];
      if (onFiles) onFiles(files); else files.forEach(insertImage);
    }
  });
  document.addEventListener('selectionchange', () => {
    if (!content.isConnected) return;
    if (content.contains(document.activeElement) || document.activeElement === content) { saveRange(); refresh(); }
  });

  const wrap = h('div', { class: 'editor' }, bar, content);
  const ed = {
    el: wrap, content,
    getHtml: () => cleanHtml(content.innerHTML),
    setHtml(v) { content.innerHTML = cleanHtml(v); },
    focusStart() {
      content.focus();
      const r = document.createRange();
      r.setStart(content.firstChild || content, 0);
      r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    },
    isEmpty: () => !content.textContent.trim() && !content.querySelector('img'),
  };
  ed.setHtml(html);
  return ed;
}
