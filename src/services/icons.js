'use strict';

/**
 * Single-line icon set (§3.3): Lucide/Feather geometry, 1.5px stroke, 24×24
 * viewBox, currentColor. One family only — never mix icon families.
 *
 * Usage in EJS:  <%- icon('search') %>
 */

const PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  account: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.3 3.1-6 7-6s7 2.7 7 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  whatsapp: '<path d="M12 3a9 9 0 0 0-7.7 13.6L3 21l4.5-1.2A9 9 0 1 0 12 3Z"/><path d="M8.8 8.5c0 3 2.7 5.7 5.7 5.7l1-1.3-1.7-1-.8.8a5 5 0 0 1-2.4-2.4l.8-.8-1-1.7z"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a12 12 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1Z"/>',
  car: '<path d="M5 17h14v-4l-1.6-4.4A1.5 1.5 0 0 0 16 7.6H8a1.5 1.5 0 0 0-1.4 1L5 13v4Z"/><circle cx="8" cy="17" r="1.6"/><circle cx="16" cy="17" r="1.6"/><path d="M5 13h14"/>',
  searchCheck: '<circle cx="10" cy="10" r="6"/><path d="m20 20-4-4"/><path d="m7.5 10 1.7 1.7L12.5 8"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z"/>',
  fileCheck: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/><path d="m9 14 2 2 4-4"/>',
  repeat: '<path d="M4 8h13l-3-3"/><path d="M20 16H7l3 3"/>',
  shield: '<path d="M12 3 5 6v6c0 4 3 7.4 7 9 4-1.6 7-5 7-9V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
  barChart: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  video: '<rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-3v10l-6-3"/>',
  package: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5"/><path d="M12 12v9"/>',
  store: '<path d="M4 9V6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v3"/><path d="M3 9h18v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9Z"/><path d="M9 20v-6h6v6"/>',
  chart: '<path d="M4 20V6"/><path d="M10 20V10"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  inbox: '<path d="M3 12h4l2 3h6l2-3h4"/><path d="M5 5h14l2 7v7H3v-7l2-7Z"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="m11 11 8-8"/><path d="m16 6 2 2"/><path d="m19 3 2 2"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 14.5v2.5"/>',
  check: '<path d="m5 13 4 4 10-11"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.2"/>',
  share: '<path d="M12 4v11"/><path d="m8 8 4-4 4 4"/><path d="M6 13v6a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-6"/>',
  link: '<path d="M10 13a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 1 0-5.7-5.7L11 6.3"/><path d="M14 11a4 4 0 0 0-5.7 0L6 13.3a4 4 0 1 0 5.7 5.7l1.3-1.3"/>',
  heart: '<path d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.6-7 9-7 9Z"/>',
  heartFilled: '<path fill="currentColor" d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.6-7 9-7 9Z"/>',
  logout: '<path d="M15 12H4"/><path d="m7 8-4 4 4 4"/><path d="M11 4h6a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/>',
  scale: '<path d="M12 4v16"/><path d="M6 8h12"/><path d="m6 8-3 6h6L6 8Z"/><path d="m18 8-3 6h6l-3-6Z"/>',
  gauge: '<path d="M4 17a9 9 0 1 1 16 0"/><path d="M12 13.5 15 10"/><circle cx="12" cy="15" r="1.6"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  home: '<path d="m4 11 8-7 8 7"/><path d="M6 10v10h12V10"/>',
  chat: '<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 4V6a1 1 0 0 1 1-1Z"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  trash: '<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/>',
  alert: '<path d="M12 4 3 20h18L12 4Z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  fuel: '<path d="M7 20V5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v15"/><path d="M5 20h11"/><path d="M14 9h2.5a1.5 1.5 0 0 1 1.5 1.5V17a1.5 1.5 0 0 0 1.5 1.5"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M4.2 7.5l2.2 1.2M17.6 15.3l2.2 1.2M4.2 16.5l2.2-1.2M17.6 8.7l2.2-1.2"/>',
  mapPin: '<path d="M12 21s6-5.3 6-10a6 6 0 1 0-12 0c0 4.7 6 10 6 10Z"/><circle cx="12" cy="11" r="2.4"/>',
  eye: '<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bell: '<path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 13 6 9Z"/><path d="M10 18a2 2 0 0 0 4 0"/>',
};

/**
 * @param {string} name  key from PATHS
 * @param {{ size?: number, className?: string, title?: string }} [options]
 */
function icon(name, options = {}) {
  const body = PATHS[name] || PATHS.info;
  const size = options.size || 24;
  const className = options.className ? ` class="${options.className}"` : '';
  const label = options.title
    ? ` role="img" aria-label="${escapeAttr(options.title)}"`
    : ' aria-hidden="true"';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"${className}${label}>${body}</svg>`;
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Service slug → icon key (matches the seed + Appendix C service list). */
const SERVICE_ICONS = {
  inspection: 'searchCheck',
  concierge: 'compass',
  documents: 'fileCheck',
  'sell-swap': 'repeat',
  tracking: 'shield',
  hire: 'car',
  research: 'barChart',
  consultation: 'video',
  parts: 'package',
  'dealer-services': 'store',
};

module.exports = { icon, PATHS, SERVICE_ICONS };
