/* MAP
 * §1 Nex theme presets & metadata   L8-L36
 * §2 color & contrast helpers       L37-L64
 * §3 apply theme tokens to :root    L65-L120
 */
// Classic Outlook themes plus all 15 Nex presets with contrast-verified CSS variables.

// §1 Nex theme presets & metadata
export const CLASSIC_THEMES = [
  ['light', 'Light (Outlook)', '#0f6cbd', '#ffffff', '#0f6cbd'],
  ['dark', 'Dark', '#479ef5', '#262626', '#1f2a37'],
  ['blue', 'Blue', '#0f548c', '#e8f1fb', '#0f548c'],
  ['purple', 'Purple', '#6b2fa0', '#f4eefa', '#5c2b8a'],
  ['green', 'Green', '#107c41', '#ecf6ef', '#0b6a37'],
  ['system', 'System', '#0f6cbd', 'linear-gradient(135deg,#fff 50%,#292929 50%)', '#0f6cbd'],
  ['nex', 'Match Nex', '#6fb3e0', 'linear-gradient(135deg,#1b212b 50%,#e9deec 50%)', '#334b61'],
];

export const NEX_THEMES = {
  azur: { name: 'Azur Soft', mode: 'dark', colors: { background: '#1b212b', surface: '#27313d', sidebar: '#232a35', input: '#2d3542', text: '#d7e0e8', muted: '#a6b2be', accent: '#6fb3e0', border: '#606f80', header: '#334b61' } },
  'ema-dark': { name: 'Ema Dark', mode: 'dark', colors: { background: '#362d40', surface: '#3d3448', sidebar: '#322a3c', input: '#453b52', text: '#e8deed', muted: '#b3a6be', accent: '#d17bb5', border: '#8a7697', header: '#4b3b58' } },
  'ema-light': { name: 'Ema Light', mode: 'light', colors: { background: '#e9deec', surface: '#f1e8f3', sidebar: '#dfd0e4', input: '#f1e8f3', text: '#382d42', muted: '#5f5468', accent: '#a8468f', border: '#867092', header: '#d8c5df' } },
  'amber-dark': { name: 'Amber Dark', mode: 'dark', colors: { background: '#24201d', surface: '#302a25', sidebar: '#2b2520', input: '#3b332c', text: '#e7ddcf', muted: '#b8a999', accent: '#d9814f', border: '#78695b', header: '#49392e' } },
  'amber-light': { name: 'Amber Light', mode: 'light', colors: { background: '#f1ecdf', surface: '#faf6ec', sidebar: '#e5dccb', input: '#faf6ec', text: '#342d27', muted: '#665c53', accent: '#a74f2e', border: '#927f69', header: '#d9cbb7' } },
  'neon-horizon': { name: 'Neon Horizon', mode: 'dark', colors: { background: '#0b1222', surface: '#16213b', sidebar: '#101a30', input: '#1b2945', text: '#e7f2ff', muted: '#a8c0d5', accent: '#44d5df', border: '#607d9d', header: '#1b3152' } },
  'aero-glass': { name: 'Aero Glass', mode: 'light', colors: { background: '#e2edf6', surface: '#f4faff', sidebar: '#d0e3f1', input: '#f8fcff', text: '#18314b', muted: '#49627a', accent: '#096ba6', border: '#627f99', header: '#bbd7e9' } },
  'windows-xp': { name: 'Windows XP', mode: 'light', colors: { background: '#ece9d8', surface: '#f7f5ea', sidebar: '#dce8f5', input: '#ffffff', text: '#1b2842', muted: '#4d5c72', accent: '#1f57b5', border: '#58729a', header: '#78a8df' } },
  'putty-terminal': { name: 'PuTTY Terminal', mode: 'dark', colors: { background: '#0b120c', surface: '#152018', sidebar: '#111b13', input: '#0e190f', text: '#c7edc4', muted: '#91ba8f', accent: '#63df73', border: '#4e9560', header: '#1c3b22' } },
  'executive-slate': { name: 'Executive Slate', mode: 'dark', colors: { background: '#141c28', surface: '#202c3a', sidebar: '#1a2532', input: '#263545', text: '#eef0ec', muted: '#b6c1c6', accent: '#d2ad72', border: '#718392', header: '#293b4c' } },
  'polar-blueprint': { name: 'Polar Blueprint', mode: 'light', colors: { background: '#e8f1f5', surface: '#f7fbfc', sidebar: '#d7e9ee', input: '#ffffff', text: '#193441', muted: '#4c6570', accent: '#0a6c88', border: '#608591', header: '#c4dfe6' } },
  'cinder-rose': { name: 'Cinder Rose', mode: 'dark', colors: { background: '#211d22', surface: '#302830', sidebar: '#282129', input: '#392f39', text: '#f0e7e9', muted: '#c2adb6', accent: '#e88ea4', border: '#977c88', header: '#43313d' } },
  'moss-paper': { name: 'Moss & Paper', mode: 'light', colors: { background: '#eeeee3', surface: '#faf9f0', sidebar: '#dfe4d6', input: '#ffffff', text: '#29362a', muted: '#59665a', accent: '#2e704b', border: '#768b74', header: '#ccd8c5' } },
  'plum-orchard-dusk': { name: 'Plum Orchard Dusk', mode: 'dark', colors: { background: '#1a1420', surface: '#241c2c', sidebar: '#140f19', input: '#2c2335', text: '#f3e9dc', muted: '#b8a9bf', accent: '#f2a65a', border: '#8c76a0', header: '#201827' } },
  'linen-and-sea-glass': { name: 'Linen & Sea Glass', mode: 'light', colors: { background: '#f7f3ec', surface: '#fffdf8', sidebar: '#ece5d8', input: '#ffffff', text: '#1f2a2e', muted: '#56615f', accent: '#0f6e68', border: '#7a7163', header: '#e4dccb' } },
};

// §2 color & contrast helpers
const rgb = h => h.match(/[0-9a-f]{2}/gi).map(v => parseInt(v, 16));
const mix = (a, b, s) => { const x = rgb(a), y = rgb(b); return '#' + x.map((v, i) => Math.round(v * (1 - s) + y[i] * s).toString(16).padStart(2, '0')).join(''); };
const lum = h => { const l = rgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return l[0] * 0.2126 + l[1] * 0.7152 + l[2] * 0.0722; };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

function ensureContrast(fg, bgs, min, fallback) {
  const list = Array.isArray(bgs) ? bgs : [bgs];
  if (list.every(b => contrast(fg, b) >= min)) return fg;
  const target = fallback || (lum(list[0]) < 0.25 ? '#f5f5f5' : '#181818');
  for (let s = 0.05; s <= 1.001; s += 0.05) {
    const c = mix(fg, target, Math.min(1, s));
    if (list.every(b => contrast(c, b) >= min)) return c;
  }
  return target;
}

export function resolveNexPreset() {
  try {
    if (window.parent && window.parent !== window && window.parent.NexThemes) {
      const id = window.parent.NexThemes.get()?.preset;
      if (id && NEX_THEMES[id]) return id;
    }
  } catch (e) { /* different origin */ }
  return 'azur';
}

// §3 apply theme tokens to :root
const VARS = [
  '--bg', '--surface', '--surface-2', '--surface-3', '--hover', '--sel', '--sel-strong',
  '--border', '--border-strong', '--text', '--text-2', '--text-3', '--accent', '--accent-hover',
  '--on-accent', '--accent-soft', '--accent-text', '--topbar', '--on-topbar', '--topbar-hover',
  '--topbar-active', '--search-bg', '--search-text', '--rail-bg', '--danger', '--on-danger',
  '--danger-soft', '--ok', '--ok-soft', '--warn-bg', '--warn-text', '--warn-border',
  '--input-bg', '--chip-bg', '--skel', '--paper', '--paper-border', '--shadow', '--focus',
];

export function applyThemeVars(themeId, root, systemDark) {
  const id = themeId === 'system' ? (systemDark ? 'dark' : 'light') : (themeId === 'nex' ? resolveNexPreset() : (themeId || 'light'));
  const p = NEX_THEMES[id];
  if (!p) {
    for (const v of VARS) root.style.removeProperty(v);
    root.style.removeProperty('color-scheme');
    root.dataset.theme = id;
    root.dataset.mode = id === 'dark' ? 'dark' : 'light';
    root.dataset.topbar = 'dark';
    return;
  }
  const c = p.colors, dark = p.mode === 'dark', fb = dark ? '#f5f5f5' : '#181818';
  const selStrong = mix(c.surface, c.accent, dark ? 0.22 : 0.16);
  const topDark = lum(c.header) <= 0.35;
  const baseTop = contrast(c.header, c.text) >= 5.2 ? c.text : (topDark ? '#f4f4f4' : '#181818');
  const topHover = mix(c.header, baseTop, 0.10), topActive = mix(c.header, baseTop, 0.16);
  const onTop = ensureContrast(baseTop, [c.header, topActive], 4.6, topDark ? '#ffffff' : '#121212');
  const onAcc = contrast(c.accent, '#ffffff') >= contrast(c.accent, '#141414') ? '#ffffff' : '#141414';
  const danger = dark ? '#f1707b' : '#c50f1f', ok = dark ? '#6ccb5f' : '#107c10';
  const map = {
    '--bg': c.background, '--surface': c.surface, '--surface-2': c.sidebar,
    '--surface-3': mix(c.surface, c.text, dark ? 0.12 : 0.08),
    '--hover': mix(c.surface, c.text, dark ? 0.08 : 0.05),
    '--sel': mix(c.surface, c.accent, dark ? 0.14 : 0.11), '--sel-strong': selStrong,
    '--border': mix(c.surface, c.border, 0.55), '--border-strong': c.border,
    '--text': ensureContrast(c.text, [c.surface, selStrong, c.sidebar], 4.6, fb),
    '--text-2': ensureContrast(c.muted, [c.surface, selStrong, c.sidebar], 4.6, c.text),
    '--text-3': ensureContrast(mix(c.muted, c.surface, 0.10), [c.surface, selStrong], 4.6, c.text),
    '--accent': c.accent, '--accent-hover': mix(c.accent, dark ? '#ffffff' : '#000000', 0.14),
    '--on-accent': onAcc, '--accent-soft': mix(c.surface, c.accent, dark ? 0.20 : 0.14),
    '--accent-text': ensureContrast(c.accent, [c.surface, selStrong, c.sidebar], 4.6, c.text),
    '--topbar': c.header, '--on-topbar': onTop,
    '--topbar-hover': topHover, '--topbar-active': topActive,
    '--search-bg': c.input, '--search-text': ensureContrast(c.text, c.input, 4.5),
    '--rail-bg': c.sidebar, '--danger': danger, '--on-danger': dark ? '#1b0a0c' : '#ffffff',
    '--danger-soft': mix(c.surface, danger, 0.18), '--ok': ok, '--ok-soft': mix(c.surface, ok, 0.18),
    '--warn-bg': dark ? '#3d3214' : '#fff4ce', '--warn-text': dark ? '#f5dc8a' : '#4d3b00',
    '--warn-border': dark ? '#8a7320' : '#e6c200', '--input-bg': c.input,
    '--chip-bg': mix(c.surface, c.text, dark ? 0.12 : 0.08), '--skel': mix(c.surface, c.text, 0.1),
    '--paper': dark ? '#fafafa' : '#ffffff', '--paper-border': c.border,
    '--shadow': dark ? '0 8px 28px rgba(0, 0, 0, .55), 0 0 2px rgba(0, 0, 0, .6)' : '0 8px 28px rgba(0, 0, 0, .16), 0 0 2px rgba(0, 0, 0, .12)',
    '--focus': c.accent,
  };
  for (const [k, v] of Object.entries(map)) root.style.setProperty(k, v);
  root.style.colorScheme = p.mode;
  root.dataset.theme = id;
  root.dataset.mode = p.mode;
  root.dataset.topbar = lum(c.header) > 0.35 ? 'light' : 'dark';
}
