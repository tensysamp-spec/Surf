// Shared helpers used by every renderer module (and the little window).
const { ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const NEWTAB_URL = pathToFileURL(path.join(__dirname, '..', 'newtab.html')).href;

const SEARCH_ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=' },
};

// Private windows read your settings but never write anything to disk,
// and start without your tabs or history.
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const PRIVATE = params.get('private') === '1';
const PRIVATE_PARTITION = PRIVATE ? params.get('partition') : null;
const PRIVATE_FRESH = new Set(['browser.spaces', 'browser.archive', 'browser.activeSpace', 'browser.history', 'browser.downloads', 'browser.highlights', 'browser.shelf', 'browser.sidebarCollapsed', 'browser.readingList']);
const memory = new Map();

const store = {
  get(key, fallback) {
    if (PRIVATE) {
      if (memory.has(key)) return memory.get(key);
      if (PRIVATE_FRESH.has(key)) return fallback;
    }
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    if (PRIVATE) {
      memory.set(key, value);
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify(value, SLIM_KEYS.has(key) ? slimFavicons : undefined));
      if (store.onWrite) store.onWrite(key);
    } catch (err) {
      console.error('Could not save', key, err);
      if (isQuotaError(err)) warnStorageFull();
    }
  },
};

// Pages can hand us huge data: URL favicons; saving those in tabs, archive and history
// fills localStorage fast. They're kept in memory and dropped on disk (http(s) icon URLs stay).
const SLIM_KEYS = new Set(['browser.spaces', 'browser.favorites', 'browser.archive', 'browser.history']);
const MAX_SAVED_DATA_ICON = 8 * 1024;
function slimFavicons(k, v) {
  return k === 'favicon' && typeof v === 'string' && v.startsWith('data:') && v.length > MAX_SAVED_DATA_ICON ? undefined : v;
}

const isQuotaError = (err) => !!err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014);

// A full localStorage means changes are silently lost; say so once (not on every save)
// and offer the usual culprit, History, to clear
let storageWarnedAt = 0;
function warnStorageFull() {
  if (Date.now() - storageWarnedAt < 10 * 60 * 1000) return;
  storageWarnedAt = Date.now();
  const library = require('./ctx').library;
  toast('Surf couldn’t save — storage is full', {
    duration: 10000,
    ...(library && { action: () => library.open('history'), actionLabel: 'Clear History…' }),
  });
}

// A Space can pick its own search engine
let spaceEngine = null;
function setSpaceEngine(key) {
  spaceEngine = key && SEARCH_ENGINES[key] ? key : null;
}

function searchEngine() {
  if (spaceEngine) return SEARCH_ENGINES[spaceEngine];
  const settings = store.get('browser.settings', {});
  return SEARCH_ENGINES[settings.searchEngine] || SEARCH_ENGINES.duckduckgo;
}

function searchUrl(query) {
  return searchEngine().url + encodeURIComponent(query);
}

function isNewTabUrl(url) {
  return !!url && url.split(/[?#]/)[0] === NEWTAB_URL;
}

// Turn whatever the user typed into a URL: full URLs pass through,
// domains / hosts get a scheme, everything else becomes a search.
function resolveInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(text) || /^(about|data|mailto|view-source):/i.test(text)) {
    return text;
  }
  if (/\s/.test(text)) return searchUrl(text);

  const tail = '(:\\d{1,5})?([/?#].*)?$';
  if (new RegExp(`^(localhost|127(\\.\\d{1,3}){3}|0\\.0\\.0\\.0|\\[::1\\])${tail}`, 'i').test(text)) {
    return 'http://' + text;
  }
  if (new RegExp(`^\\d{1,3}(\\.\\d{1,3}){3}${tail}`).test(text)) {
    return 'http://' + text;
  }
  if (new RegExp(`^([a-z\\d]([a-z\\d-]*[a-z\\d])?\\.)+([a-z]{2,63}|xn--[a-z\\d-]+)${tail}`, 'i').test(text)) {
    return 'https://' + text;
  }
  return searchUrl(text);
}

function looksLikeUrl(text) {
  const resolved = resolveInput(text);
  return !!resolved && !resolved.startsWith(searchEngine().url);
}

function displayUrl(url) {
  return isNewTabUrl(url) ? '' : url || '';
}

// Arc-style compact address: just the host, without "www."
function compactUrl(url) {
  if (!url || isNewTabUrl(url)) return '';
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return url;
    return u.host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || '';
  }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ------------------------------------------------------------------ */
/* Icons (Lucide/Feather style, 24x24, stroke-based)                   */
/* ------------------------------------------------------------------ */

const svg = (body) => `<svg viewBox="0 0 24 24">${body}</svg>`;

const ICONS = {
  globe: svg('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
  grid: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>'),
  close: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  search: svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  arrow: svg('<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>'),
  plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  folder: svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
  folderOpen: svg('<path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M17.66 17.66l1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M6.34 17.66l-1.41 1.41"/><path d="M19.07 4.93l-1.41 1.41"/>'),
  moon: svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  contrast: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>'),
  chevronRight: svg('<polyline points="9 18 15 12 9 6"/>'),
  chevronDown: svg('<polyline points="6 9 12 15 18 9"/>'),
  pin: svg('<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/>'),
  star: svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
  split: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>'),
  eye: svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>'),
  reload: svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  volume: svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'),
  mute: svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'),
  play: svg('<polygon points="6 4 20 12 6 20 6 4"/>'),
  pause: svg('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>'),
  archive: svg('<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5" rx="1"/><line x1="10" y1="12" x2="14" y2="12"/>'),
  clock: svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  note: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>'),
  easel: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="7" y="7" width="5" height="5" rx="1"/><line x1="15" y1="8" x2="17" y2="8"/><line x1="7" y1="16" x2="17" y2="16"/>'),
  sparkles: svg('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>'),
  wand: svg('<path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8L19 13"/><path d="M15 9h.01"/><path d="M17.8 6.2L19 5"/><path d="M3 21l9-9"/><path d="M12.2 6.2L11 5"/>'),
  palette: svg('<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.75 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-4.96-4.5-9-10-9z"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  shield: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  window: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>'),
  external: svg('<polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  maximize: svg('<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>'),
  type: svg('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>'),
  crop: svg('<path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"/><path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  layers: svg('<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>'),
  home: svg('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
  sidebar: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><line x1="9" y1="3" x2="9" y2="21"/>'),
  undo: svg('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>'),
  send: svg('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
  rss: svg('<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>'),
  share: svg('<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>'),
  panel: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/>'),
  camera: svg('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
  key: svg('<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>'),
  highlighter: svg('<path d="M9 11l-6 6v3h9l3-3"/><path d="M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
  code: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
  user: svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  more: svg('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
  zap: svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
  brain: svg('<path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.04z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.04z"/>'),
  mask: svg('<path d="M2 12c0-3 2-5 5-5 2 0 3 1 5 1s3-1 5-1c3 0 5 2 5 5 0 4-3 6-5 6-2 0-3-2-5-2s-3 2-5 2c-2 0-5-2-5-6z"/><circle cx="8" cy="11.5" r="1.5"/><circle cx="16" cy="11.5" r="1.5"/>'),
  card: svg('<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/>'),
  bookmark: svg('<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>'),
  smile: svg('<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>'),
  arrowLeft: svg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  keyboard: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6.01" y2="10"/><line x1="10" y1="10" x2="10.01" y2="10"/><line x1="14" y1="10" x2="14.01" y2="10"/><line x1="18" y1="10" x2="18.01" y2="10"/><line x1="7" y1="14" x2="17" y2="14"/>'),
};

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

// el('div', 'cls other', 'text') — text is always set via textContent
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Only our own static SVG strings go through innerHTML
function icon(name) {
  const span = document.createElement('span');
  span.innerHTML = ICONS[name] || ICONS.globe;
  return span.firstChild;
}

function iconElement(src, fallbackSvg) {
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.draggable = false;
    img.addEventListener('error', () => {
      const span = document.createElement('span');
      span.innerHTML = fallbackSvg;
      img.replaceWith(span.firstChild);
    }, { once: true });
    return img;
  }
  const span = document.createElement('span');
  span.innerHTML = fallbackSvg;
  return span.firstChild;
}

function iconButton(name, title, onClick, className = 'icon-btn') {
  const btn = el('button', className);
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.appendChild(icon(name));
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function timeAgo(time) {
  const s = Math.round((Date.now() - time) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function dayLabel(time) {
  const d = new Date(time);
  const today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

/* ------------------------------------------------------------------ */
/* Escape-key routing                                                  */
/* ------------------------------------------------------------------ */

// While any overlay is open, ask main to deliver Escape to us even if a page has focus.
const escapeHandlers = [];
function pushEscape(handler) {
  escapeHandlers.push(handler);
  ipcRenderer.send('set-escape-capture', true);
  return () => popEscape(handler);
}
function popEscape(handler) {
  const i = escapeHandlers.lastIndexOf(handler);
  if (i !== -1) escapeHandlers.splice(i, 1);
  ipcRenderer.send('set-escape-capture', escapeHandlers.length > 0);
}
function handleEscape() {
  const handler = escapeHandlers[escapeHandlers.length - 1];
  if (handler) handler();
  return !!handler;
}

/* ------------------------------------------------------------------ */
/* Where popups go                                                     */
/* ------------------------------------------------------------------ */

// Toasts, menus and dialogs appear in the window you're looking at: normally this browser
// window, or its Settings window (which this window's code draws into) while that has focus.
let popupDoc = null;
function setPopupDocument(doc) {
  popupDoc = doc;
}
function uiDoc() {
  const view = popupDoc && popupDoc.defaultView;
  return view && !view.closed && popupDoc.hasFocus() ? popupDoc : document;
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

function toast(message, { action, actionLabel, duration = 2600 } = {}) {
  const doc = uiDoc();
  let host = doc.getElementById('toasts');
  if (!host) {
    host = el('div');
    host.id = 'toasts';
    doc.body.appendChild(host);
  }
  const node = el('div', 'toast');
  node.appendChild(el('span', null, message));
  if (action) {
    const btn = el('button', 'toast-action', actionLabel || 'Open');
    btn.addEventListener('click', () => {
      action();
      dismiss();
    });
    node.appendChild(btn);
  }
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  const dismiss = () => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 250);
  };
  setTimeout(dismiss, duration);
}

/* ------------------------------------------------------------------ */
/* Context menu                                                        */
/* ------------------------------------------------------------------ */

let openMenu = null;

// Play a short exit animation (the element's .closing styles), then remove it
function removeAnimated(node, ms = 140) {
  if (!node || !node.isConnected) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return node.remove();
  node.classList.add('closing');
  node.style.pointerEvents = 'none';
  setTimeout(() => node.remove(), ms);
}

function closeContextMenu() {
  if (!openMenu) return;
  removeAnimated(openMenu.node, 110);
  openMenu.release();
  openMenu.doc.removeEventListener('mousedown', openMenu.outside, true);
  openMenu.doc.defaultView.removeEventListener('blur', closeContextMenu);
  openMenu = null;
}

// items: [{ label, icon, action, danger, disabled, checked, swatch } | { separator: true } | { header } | { element, menuClass }]
function contextMenu(items, x, y) {
  closeContextMenu();
  const node = el('div', 'ctx-menu');
  node.setAttribute('role', 'menu');

  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      node.appendChild(el('div', 'ctx-sep'));
      continue;
    }
    if (item.header) {
      node.appendChild(el('div', 'ctx-header', item.header));
      continue;
    }
    if (item.element) {
      node.appendChild(item.element);
      if (item.menuClass) node.classList.add(item.menuClass);
      continue;
    }
    if (item.swatches) {
      const row = el('div', 'ctx-swatches');
      for (const s of item.swatches) {
        const b = el('button', 'ctx-swatch' + (s.active ? ' active' : ''));
        b.title = s.title;
        b.style.background = s.color;
        b.addEventListener('click', () => {
          closeContextMenu();
          s.action();
        });
        row.appendChild(b);
      }
      node.appendChild(row);
      continue;
    }
    const row = el('button', 'ctx-item' + (item.danger ? ' danger' : ''));
    row.disabled = !!item.disabled;
    row.appendChild(item.icon ? icon(item.icon) : el('span', 'ctx-icon-spacer'));
    row.appendChild(el('span', 'ctx-label', item.label));
    if (item.checked) row.appendChild(el('span', 'ctx-check', '✓'));
    if (item.hint) row.appendChild(el('span', 'ctx-hint', item.hint));
    row.addEventListener('click', () => {
      closeContextMenu();
      item.action();
    });
    node.appendChild(row);
  }

  const doc = uiDoc();
  const view = doc.defaultView;
  doc.body.appendChild(node);
  const { innerWidth: W, innerHeight: H } = view;
  // Layout size, not getBoundingClientRect: the opening animation is scaling the menu down right now
  const rect = { width: node.offsetWidth, height: node.offsetHeight };
  // Menus opened low in the window (e.g. from the sidebar's bottom bar) grow upward;
  // either way they stay fully on screen (CSS caps the height and lets it scroll)
  const up = y > H / 2 && y - rect.height >= 8;
  const top = up ? y - rect.height : y;
  node.classList.toggle('up', up);
  node.style.left = `${Math.max(8, Math.min(x, W - rect.width - 8))}px`;
  node.style.top = `${Math.max(8, Math.min(top, H - rect.height - 8))}px`;

  const outside = (e) => {
    if (!node.contains(e.target)) closeContextMenu();
  };
  doc.addEventListener('mousedown', outside, true);
  view.addEventListener('blur', closeContextMenu);
  openMenu = { node, outside, doc, release: pushEscape(closeContextMenu) };
}

/* ------------------------------------------------------------------ */
/* Prompt / confirm dialog (window.prompt is not supported in Electron) */
/* ------------------------------------------------------------------ */

// content: an optional element shown below the message (e.g. a form; the dialog then resolves true)
function dialog({ title, message, value, placeholder, confirmLabel = 'OK', danger = false, input = true, content = null, className = '' }) {
  return new Promise((resolve) => {
    const backdrop = el('div', 'dialog-backdrop');
    const box = el('form', 'dialog' + (className ? ` ${className}` : ''));
    box.appendChild(el('h3', null, title));
    if (message) box.appendChild(el('p', null, message));
    if (content) box.appendChild(content);
    let field = null;
    if (input) {
      field = el('input', 'dialog-input');
      field.type = 'text';
      field.value = value || '';
      field.placeholder = placeholder || '';
      field.spellcheck = false;
      box.appendChild(field);
    }
    const actions = el('div', 'dialog-actions');
    const cancel = el('button', 'btn', 'Cancel');
    cancel.type = 'button';
    const ok = el('button', 'btn primary' + (danger ? ' danger' : ''), confirmLabel);
    ok.type = 'submit';
    actions.append(cancel, ok);
    box.appendChild(actions);
    backdrop.appendChild(box);
    uiDoc().body.appendChild(backdrop);

    const finish = (result) => {
      release();
      removeAnimated(backdrop);
      resolve(result);
    };
    const release = pushEscape(() => finish(null));
    cancel.addEventListener('click', () => finish(null));
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) finish(null);
    });
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(input ? field.value.trim() : true);
    });
    requestAnimationFrame(() => (field ? (field.focus(), field.select()) : ok.focus()));
  });
}

/* ------------------------------------------------------------------ */
/* HTML sanitizer for notes (allowlist; everything else is dropped)    */
/* ------------------------------------------------------------------ */

const ALLOWED_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'CODE', 'PRE', 'A', 'DIV', 'SPAN', 'HR']);
// Extra tags allowed for reader-mode articles
const RICH_TAGS = new Set([...ALLOWED_TAGS, 'H4', 'H5', 'H6', 'IMG', 'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'SUP', 'SUB', 'SMALL', 'MARK', 'DL', 'DT', 'DD', 'ABBR', 'TIME', 'CITE', 'Q', 'SECTION', 'ARTICLE', 'KBD', 'VAR']);

function sanitizeHtml(html, { rich = false } = {}) {
  const allowed = rich ? RICH_TAGS : ALLOWED_TAGS;
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  const walk = (parent) => {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) continue;
      if (node.nodeType !== Node.ELEMENT_NODE || !allowed.has(node.tagName)) {
        // Unwrap unknown elements but keep their text; drop scripts/styles entirely
        if (node.nodeType === Node.ELEMENT_NODE && !/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|TEMPLATE)$/.test(node.tagName)) {
          walk(node);
          node.replaceWith(...node.childNodes);
        } else {
          node.remove();
        }
        continue;
      }
      for (const attr of [...node.attributes]) {
        const keep = (node.tagName === 'A' && attr.name === 'href' && /^https?:/i.test(attr.value))
          || (rich && node.tagName === 'IMG' && attr.name === 'src' && /^(https:|data:image\/(png|jpe?g|gif|webp);)/i.test(attr.value))
          || (rich && node.tagName === 'IMG' && attr.name === 'alt')
          || (rich && (node.tagName === 'TD' || node.tagName === 'TH') && (attr.name === 'colspan' || attr.name === 'rowspan') && /^\d{1,2}$/.test(attr.value));
        if (!keep) node.removeAttribute(attr.name);
      }
      walk(node);
    }
  };
  walk(template.content);
  return template.innerHTML;
}

/* ------------------------------------------------------------------ */
/* Tiny markdown renderer (DOM nodes only — never innerHTML)           */
/* ------------------------------------------------------------------ */

function appendInline(parent, text) {
  // **bold**, `code`, *italic*
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const token = m[0];
    if (token.startsWith('**')) parent.appendChild(el('strong', null, token.slice(2, -2)));
    else if (token.startsWith('`')) parent.appendChild(el('code', null, token.slice(1, -1)));
    else parent.appendChild(el('em', null, token.slice(1, -1)));
    last = m.index + token.length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function renderMarkdown(container, markdown) {
  container.replaceChildren();
  let list = null;
  let code = null;
  for (const raw of String(markdown).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line.startsWith('```')) {
      if (code) {
        container.appendChild(code);
        code = null;
      } else {
        code = el('pre');
      }
      list = null;
      continue;
    }
    if (code) {
      code.appendChild(document.createTextNode((code.textContent ? '\n' : '') + raw));
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (heading) {
      list = null;
      const h = el(`h${Math.min(heading[1].length + 2, 5)}`);
      appendInline(h, heading[2]);
      container.appendChild(h);
    } else if (bullet || numbered) {
      const tag = bullet ? 'UL' : 'OL';
      if (!list || list.tagName !== tag) {
        list = el(tag.toLowerCase());
        container.appendChild(list);
      }
      const li = el('li');
      appendInline(li, (bullet || numbered)[1]);
      list.appendChild(li);
    } else if (!line.trim()) {
      list = null;
    } else {
      list = null;
      const p = el('p');
      appendInline(p, line);
      container.appendChild(p);
    }
  }
  if (code) container.appendChild(code);
}

module.exports = {
  NEWTAB_URL, SEARCH_ENGINES, PRIVATE, PRIVATE_PARTITION, store, setSpaceEngine, searchEngine, searchUrl, isNewTabUrl, resolveInput, looksLikeUrl,
  displayUrl, compactUrl, hostOf, uid, ICONS, $, el, icon, iconElement, iconButton, formatBytes, timeAgo,
  dayLabel, pushEscape, popEscape, handleEscape, toast, contextMenu, closeContextMenu, dialog, removeAnimated, setPopupDocument,
  sanitizeHtml, renderMarkdown,
};
