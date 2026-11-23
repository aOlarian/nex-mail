/* MAP
 * §1 document srcdoc  L10-L38
 * §2 montare iframe cu inaltime dupa continut  L39-L77
 * §3 text simplu cu linkuri clicabile  L78-L103
 */
// Corpul mesajului: HTML in iframe sandbox (fara scripturi) cu CSP; text simplu in <pre> cu linkuri.
import { h, escapeHtml } from './mail-util.js';
import { prepareMessageHtml } from './mail-sanitize.js';

// §1 document srcdoc
// '/api/' din cerinta nu e sursa CSP valida (fara gazda); 'self' = aceeasi origine, deci /api/mail/attachment
function csp(allowRemote) {
  const img = allowRemote ? "data: cid: 'self' https: http:" : "data: cid: 'self'";
  return `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data: https:`;
}

const BASE_CSS = scale => {
  const f = Number(scale) || 1;
  const px = v => `${Math.round(v * f * 100) / 100}px`;
  return `html{font-size:${px(16)}}html,body{margin:0;padding:0;background:#fff;color:#242424}
body{padding:4px 2px 12px;font:${px(14)}/1.45 "Segoe UI",system-ui,-apple-system,Arial,sans-serif;overflow-wrap:anywhere;word-wrap:break-word}
img{max-width:100%;height:auto} img[data-blocked-src]{display:inline-block;min-width:24px;min-height:16px;background:#f0f0f0;outline:1px dashed #bbb}
pre{white-space:pre-wrap} blockquote{margin:0 0 0 .8em;padding-left:.8em;border-left:3px solid #c8c8c8;color:#444}
a{color:#0f6cbd} table{max-width:100%}
@media (max-width:480px){body{font-size:${px(16)};line-height:1.5}}`;
};

const curScale = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs')) || 1;

export function buildSrcdoc(html, allowRemote, fontScale = curScale()) {
  const p = prepareMessageHtml(html, allowRemote);
  const doc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp(allowRemote)}">
<base target="_blank"><style>${BASE_CSS(fontScale)}</style><style>${p.styles}</style></head>
<body><div class="nex-body" style="${escapeHtml(p.bodyStyle)}">${p.body}</div></body></html>`;
  return { doc, blocked: p.blocked };
}

// §2 montare iframe cu inaltime dupa continut
export function mountHtml(container, html, { allowRemote, onMailto }) {
  const { doc, blocked } = buildSrcdoc(html, allowRemote);
  const ifr = h('iframe', {
    class: 'msg-frame', title: 'Message content',
    sandbox: 'allow-popups allow-popups-to-escape-sandbox allow-same-origin',
    referrerpolicy: 'no-referrer',
  });
  ifr.srcdoc = doc;
  container.append(ifr);
  const fit = () => {
    const d = ifr.contentDocument;
    if (!d || !d.body) return;
    const hgt = Math.max(d.body.scrollHeight, d.documentElement.scrollHeight);
    ifr.style.height = Math.max(60, Math.ceil(hgt)) + 'px';
  };
  ifr.addEventListener('load', () => {
    const d = ifr.contentDocument;
    if (!d) return;
    fit();
    d.querySelectorAll('img').forEach(img => img.addEventListener('load', fit));
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(fit);
      ro.observe(d.body);
    }
    // mailto: deschide compunerea in Nex, nu clientul sistemului
    d.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (a && /^mailto:/i.test(a.getAttribute('href')) && onMailto) {
        e.preventDefault();
        onMailto(decodeURIComponent(a.getAttribute('href').slice(7).split('?')[0]));
      }
    });
    setTimeout(fit, 300);
    setTimeout(fit, 1200);
  });
  return { iframe: ifr, blocked };
}

// §3 text simplu cu linkuri clicabile
const URL_RE = /\b(https?:\/\/[^\s<>"')\]]+|www\.[^\s<>"')\]]+|[\w.+-]+@[\w-]+\.[\w.-]+)/gi;

export function mountText(container, text, { onMailto }) {
  const pre = h('pre', { class: 'msg-text' });
  const s = String(text || '');
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    pre.append(s.slice(last, m.index));
    const t = m[0].replace(/[.,;:!?]+$/, '');
    if (t.includes('@') && !/^https?:/i.test(t)) {
      pre.append(h('a', { href: '#', text: t, on: { click: e => { e.preventDefault(); onMailto && onMailto(t); } } }));
    } else {
      pre.append(h('a', { href: /^www\./i.test(t) ? 'https://' + t : t, target: '_blank', rel: 'noopener noreferrer', text: t }));
    }
    last = m.index + t.length;
  }
  pre.append(s.slice(last));
  container.append(pre);
  return pre;
}

// text simplu → HTML pentru citat (escapat)
export function textToHtml(text) {
  return escapeHtml(text || '').replace(/\r?\n/g, '<br>');
}
