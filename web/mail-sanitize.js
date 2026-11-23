/* MAP
 * §1 lista alba pentru editor  L8-L61
 * §2 pregatire pentru iframe-ul de citire  L62-L100
 */
// Curatarea HTML-ului: (a) pentru contenteditable (compunere, semnaturi, lipire) prin lista alba;
// (b) pentru afisarea mesajelor in iframe-ul sandbox (fara scripturi, imagini externe blocate la cerere).

// §1 lista alba pentru editor
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'LINK', 'META', 'TITLE', 'HEAD', 'BASE',
  'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'OPTION', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT', 'AUDIO', 'VIDEO', 'SOURCE', 'CANVAS', 'XML', 'PARAM']);
const KEEP = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'INS', 'SUB', 'SUP', 'P', 'DIV', 'SPAN', 'BR', 'HR', 'UL', 'OL', 'LI',
  'A', 'IMG', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'CODE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH',
  'CAPTION', 'COLGROUP', 'COL', 'FONT', 'CENTER', 'SMALL', 'BIG', 'MARK', 'DL', 'DT', 'DD']);
const ATTRS = new Set(['href', 'src', 'alt', 'title', 'width', 'height', 'align', 'valign', 'colspan', 'rowspan', 'border', 'cellpadding',
  'cellspacing', 'bgcolor', 'color', 'face', 'size', 'style', 'start', 'type', 'dir']);
const STYLE_OK = /^(color|background-color|font-weight|font-style|font-size|font-family|text-decoration(-line|-color|-style)?|text-align|text-indent|line-height|vertical-align|white-space|list-style-type|margin(-\w+)?|padding(-\w+)?|border(-\w+)*|width|height|max-width|border-collapse|display)$/;
const CLASS_OK = new Set(['nex-signature', 'nex-quote']);
const HREF_OK = /^(https?:|mailto:|tel:|#)/i;
const SRC_OK = /^(data:image\/(png|jpe?g|gif|webp);base64,|https?:|cid:|\/api\/mail\/)/i;

export function cleanHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  walk(doc.body);
  return doc.body.innerHTML;
}

function walk(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 8) { child.remove(); continue; }             // comentarii (inclusiv conditionalele Word)
    if (child.nodeType !== 1) continue;
    const tag = child.tagName.toUpperCase();
    if (DROP.has(tag)) { child.remove(); continue; }
    walk(child);
    if (!KEEP.has(tag)) { child.replaceWith(...child.childNodes); continue; }  // ex. <o:p>, <section>: pastram continutul
    cleanAttrs(child, tag);
  }
}

function cleanAttrs(el, tag) {
  for (const a of [...el.attributes]) {
    const n = a.name.toLowerCase();
    if (n === 'class') {
      const keep = [...el.classList].filter(c => CLASS_OK.has(c));
      if (keep.length) el.setAttribute('class', keep.join(' ')); else el.removeAttribute('class');
      continue;
    }
    if (!ATTRS.has(n)) { el.removeAttribute(a.name); continue; }
    if (n === 'href' && !(tag === 'A' && HREF_OK.test(a.value.trim()))) el.removeAttribute(a.name);
    if (n === 'src' && !(tag === 'IMG' && SRC_OK.test(a.value.trim()))) el.removeAttribute(a.name);
  }
  if (el.hasAttribute('style')) {
    const st = el.style, keep = [];
    for (let i = 0; i < st.length; i++) {
      const p = st[i], v = st.getPropertyValue(p);
      if (STYLE_OK.test(p) && !/url\(|expression|javascript:/i.test(v)) keep.push(`${p}: ${v}`);
    }
    if (keep.length) el.setAttribute('style', keep.join('; ')); else el.removeAttribute('style');
  }
  if (tag === 'A' && el.hasAttribute('href')) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
}

// §2 pregatire pentru iframe-ul de citire
const REMOTE_URL = /url\(\s*(['"]?)\s*(https?:)?\/\/[^)]*\)/gi;

// intoarce { head: stiluri, body, bodyStyle, blocked: cate resurse externe au fost oprite }
export function prepareMessageHtml(html, allowRemote) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  let blocked = 0;
  doc.querySelectorAll('script, meta, base, link, iframe, frame, object, embed, applet, form, input, button, textarea, select, audio, video, source, noscript, template').forEach(n => n.remove());
  for (const el of doc.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || n === 'srcdoc' || n === 'formaction') el.removeAttribute(a.name);
      else if ((n === 'href' || n === 'src' || n === 'action') && /^\s*(javascript|vbscript|data:text)/i.test(a.value)) el.removeAttribute(a.name);
    }
    if (allowRemote) continue;
    if (el.tagName === 'IMG' && /^\s*(https?:)?\/\//i.test(el.getAttribute('src') || '')) {
      el.setAttribute('data-blocked-src', el.getAttribute('src'));
      el.removeAttribute('src');
      blocked++;
    }
    if (el.hasAttribute('srcset')) { el.removeAttribute('srcset'); blocked++; }
    if (/^\s*(https?:)?\/\//i.test(el.getAttribute('background') || '')) { el.removeAttribute('background'); blocked++; }
    const st = el.getAttribute('style');
    if (st && REMOTE_URL.test(st)) { el.setAttribute('style', st.replace(REMOTE_URL, 'none')); blocked++; }
    REMOTE_URL.lastIndex = 0;
  }
  let styles = '';
  for (const s of doc.querySelectorAll('style')) {
    let css = s.textContent.replace(/@import[^;]+;/gi, '');
    if (!allowRemote && REMOTE_URL.test(css)) { css = css.replace(REMOTE_URL, 'none'); blocked++; }
    REMOTE_URL.lastIndex = 0;
    styles += css.replace(/<\/style/gi, '') + '\n';
    s.remove();
  }
  const body = doc.body;
  const bodyStyle = [body.getAttribute('style') || '', body.getAttribute('bgcolor') ? `background-color:${body.getAttribute('bgcolor')}` : '']
    .filter(Boolean).join(';').replace(/[<>"]/g, '');
  return { styles, body: body.innerHTML, bodyStyle, blocked };
}
