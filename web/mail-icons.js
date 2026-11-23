/* MAP
 * §1 desene (viewBox 24x24, contur currentColor)  L7-L96
 * §2 constructor element  L97-L118
 */
// Icoane SVG proprii, stil outline (Fluent). Siruri statice, de incredere; nu primesc date externe.

// §1 desene (viewBox 24x24, contur currentColor)
const P = {
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/>',
  mailOpen: '<path d="M3 10l9-6 9 6v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3.5 10.5l8.5 5.5 8.5-5.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  calAdd: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M12 13v5M9.5 15.5h5"/>',
  tasks: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
  rules: '<path d="M4 6h10M4 12h7M4 18h10"/><circle cx="17" cy="6" r="2"/><circle cx="14" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M10.3 2.5h3.4l.6 2.1a7.6 7.6 0 0 1 1.9.8l1.9-1.1 2.4 2.4-1.1 1.9c.3.6.6 1.2.8 1.9l2.1.6v3.4l-2.1.6c-.2.7-.5 1.3-.8 1.9l1.1 1.9-2.4 2.4-1.9-1.1c-.6.3-1.2.6-1.9.8l-.6 2.1h-3.4l-.6-2.1a7.6 7.6 0 0 1-1.9-.8l-1.9 1.1-2.4-2.4 1.1-1.9a7.6 7.6 0 0 1-.8-1.9l-2.1-.6v-3.4l2.1-.6c.2-.7.5-1.3.8-1.9L4.3 6.7l2.4-2.4 1.9 1.1c.6-.3 1.2-.6 1.9-.8z"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/>',
  sync: '<path d="M19.5 9A8 8 0 0 0 5 7.5M4.5 15A8 8 0 0 0 19 16.5"/><path d="M5 3.5v4h4M19 20.5v-4h-4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  compose: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  delete: '<path d="M4 7h16M10 3h4M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
  move: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M10 13h6M13.5 10.5L16 13l-2.5 2.5"/>',
  tag: '<path d="M3 12V4h8l9.5 9.5-8 8z"/><circle cx="7.5" cy="8" r="1.3"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  flagFill: '<path d="M5 21V4M5 4h11l-2 4 2 4H5" fill="currentColor"/>',
  block: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
  broom: '<path d="M14 3l-4 9M6 12h9l2 9H4z"/><path d="M8 16v5M12 16v5"/>',
  inbox: '<path d="M3 13l2.5-8h13L21 13v6H3z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>',
  sent: '<path d="M3 11.5L21 4l-7.5 17-2.5-7.5z"/><path d="M11 13.5L21 4"/>',
  drafts: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M9 16l5-5 1.5 1.5-5 5H9z"/>',
  junk: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16v.5"/>',
  trash: '<path d="M4 7h16M10 3h4M6 7l1 13h10l1-13"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  folderAdd: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M12 10v6M9 13h6"/>',
  chevRight: '<path d="M9 5l7 7-7 7"/>',
  chevDown: '<path d="M5 9l7 7 7-7"/>',
  chevLeft: '<path d="M15 5l-7 7 7 7"/>',
  chevUp: '<path d="M5 15l7-7 7 7"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  reply: '<path d="M10 6L4 12l6 6"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/>',
  replyAll: '<path d="M11 6l-6 6 6 6M7 6l-6 6 6 6"/><path d="M5 12h9a6 6 0 0 1 6 6v1"/>',
  forward: '<path d="M14 6l6 6-6 6"/><path d="M20 12H10a6 6 0 0 0-6 6v1"/>',
  attach: '<path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  back: '<path d="M11 5l-7 7 7 7M4 12h16"/>',
  print: '<path d="M7 9V3h10v6M7 17H4v-7a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v7h-3"/><rect x="7" y="14" width="10" height="7"/>',
  code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  send: '<path d="M3 20l18-8L3 4l2.5 8z"/><path d="M5.5 12H12"/>',
  save: '<path d="M5 3h11l4 4v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M3 18l6-6 4 4 3-3 5 5"/>',
  file: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/>',
  filePdf: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M8.5 16.5h7M8.5 13h7"/>',
  fileImg: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M8 18l3-4 2 2.5 1.5-1.5 2 3z"/>',
  fileZip: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M11 6v2M11 10v2M11 14v3"/>',
  pen: '<path d="M3 17c3-1 4 2 7 1s3-5 6-5 3 3 5 3"/><path d="M14 4l3 3-6 6H8v-3z"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2s0-2.5 1.5-2.5H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10" cy="7" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/>',
  location: '<path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  bold: '<path d="M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z" stroke-width="2.2"/>',
  italic: '<path d="M10 4h8M6 20h8M14 4l-4 16"/>',
  underline: '<path d="M7 4v7a5 5 0 0 0 10 0V4M5 21h14"/>',
  strike: '<path d="M4 12h16M16 7a4 3 0 0 0-8 0c0 4 8 2.5 8 7a4 3.5 0 0 1-8 .5"/>',
  textColor: '<path d="M6 17L12 3l6 14M8.3 12h7.4"/>',
  highlight: '<path d="M9 14l-3 3v3h6l1.5-1.5M9 14l7-9 4 4-7 9z"/>',
  alignLeft: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  alignCenter: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  alignRight: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  alignJustify: '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>',
  listUl: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>',
  listOl: '<path d="M10 6h10M10 12h10M10 18h10M4 4.5h1.5V9M3.5 14h3l-3 4h3"/>',
  indent: '<path d="M4 5h16M10 10h10M10 14h10M4 19h16M4 9.5l3 2.5-3 2.5"/>',
  outdent: '<path d="M4 5h16M10 10h10M10 14h10M4 19h16M7 9.5L4 12l3 2.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  hr: '<path d="M3 12h18M7 7h10M7 17h10" />',
  clearFormat: '<path d="M6 5h12M12 5l-3 14M15 15l5 5M20 15l-5 5"/>',
  undo: '<path d="M8 5L4 9l4 4"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M16 5l4 4-4 4"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M5 19l1.4-1.4M17.6 6.4L19 5"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  account: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.2"/><path d="M5.5 16.5a3.5 3.5 0 0 1 7 0M14 10h4M14 13.5h4"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  panelRight: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  play: '<polygon points="6,4 20,12 6,20"/>',
  grip: '<circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
};

// §2 constructor element
const NS = 'http://www.w3.org/2000/svg';
export function icon(name, size = 18, cls = '') {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ic ' + cls);
  svg.innerHTML = P[name] || P.file;
  return svg;
}

// icoana dupa tipul folderului
export function folderIcon(specialUse) {
  return ({ '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Trash': 'trash', '\\Junk': 'junk', '\\Archive': 'archive' })[specialUse] || 'folder';
}
