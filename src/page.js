// Page-level tools: find in page, zoom, link hover preview, loading bar,
// friendly error pages, HTML fullscreen, and site permission prompts.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const T = () => ctx.tabs;

/* ------------------------------------------------------------------ */
/* Find in page (⌘F)                                                   */
/* ------------------------------------------------------------------ */

let findRelease = null;
let findTab = null;

const findOpen = () => !U.$('find-bar').hidden;

function openFind() {
  const tab = T().activeTab();
  if (!tab || tab.kind !== 'web') return;
  if (findTab && findTab !== tab) closeFind();
  findTab = tab;
  const bar = U.$('find-bar');
  const input = U.$('find-input');
  bar.hidden = false;
  input.focus();
  input.select();
  if (!findRelease) findRelease = U.pushEscape(closeFind);
  if (input.value) find(true);
}

function closeFind() {
  U.$('find-bar').hidden = true;
  U.$('find-count').textContent = '';
  if (findTab && findTab.ready) {
    try { findTab.webview.stopFindInPage('keepSelection'); } catch { /* gone */ }
  }
  findTab = null;
  if (findRelease) findRelease();
  findRelease = null;
}

function find(newSession = false, forward = true) {
  const text = U.$('find-input').value;
  if (!findTab || !findTab.ready) return;
  if (!text) {
    findTab.webview.stopFindInPage('clearSelection');
    U.$('find-count').textContent = '';
    return;
  }
  findTab.webview.findInPage(text, { forward, findNext: newSession });
}

function findStep(forward) {
  if (!findOpen()) {
    openFind();
    return;
  }
  find(false, forward);
}

function onFound(tab, result) {
  if (tab !== findTab || !result.finalUpdate) return;
  const count = U.$('find-count');
  count.textContent = result.matches ? `${result.activeMatchOrdinal} of ${result.matches}` : 'No matches';
  count.classList.toggle('none', !result.matches);
}

/* ------------------------------------------------------------------ */
/* Zoom (⌘+ / ⌘− / ⌘0), remembered per site                            */
/* ------------------------------------------------------------------ */

const ZOOM_KEY = 'browser.zoom';
const ZOOM_STEPS = [-3, -2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3, 4];
let zoomLevels = U.store.get(ZOOM_KEY, {});
const zoomHost = (url) => U.hostOf(url).replace(/^www\./, '');
const zoomPercent = (level) => Math.round(Math.pow(1.2, level) * 100);

function applyZoom(tab) {
  if (!tab || tab.kind !== 'web' || !tab.ready) return;
  const level = zoomLevels[zoomHost(tab.url)] || 0;
  try { tab.webview.setZoomLevel(level); } catch { /* not ready */ }
}

function zoom(direction) {
  const tab = T().activeTab();
  if (!tab || tab.kind !== 'web' || !tab.ready || U.isNewTabUrl(tab.url)) return;
  const host = zoomHost(tab.url);
  const current = zoomLevels[host] || 0;
  let next = 0;
  if (direction > 0) next = ZOOM_STEPS.find((s) => s > current) ?? current;
  else if (direction < 0) next = [...ZOOM_STEPS].reverse().find((s) => s < current) ?? current;
  if (next === 0) delete zoomLevels[host];
  else zoomLevels[host] = next;
  U.store.set(ZOOM_KEY, zoomLevels);
  for (const t of T().live.values()) {
    if (t.kind === 'web' && zoomHost(t.url) === host) applyZoom(t);
  }
  updateZoomBadge();
  U.toast(`Zoom ${zoomPercent(next)}%`, { duration: 1200 });
}

function updateZoomBadge() {
  const badge = U.$('zoom-btn');
  const tab = T().activeTab();
  const level = tab && tab.kind === 'web' ? zoomLevels[zoomHost(tab.url)] || 0 : 0;
  badge.hidden = !level;
  badge.textContent = `${zoomPercent(level)}%`;
  badge.title = 'Reset zoom (⌘0)';
}

/* ------------------------------------------------------------------ */
/* Link hover preview, loading bar                                     */
/* ------------------------------------------------------------------ */

let statusTimer = null;
let hovered = null;
function showLinkStatus(tab, url) {
  const status = U.$('link-status');
  clearTimeout(statusTimer);
  hovered = url && tab.entryId === T().activeEntryId ? url : null;
  if (!url || tab.entryId !== T().activeEntryId) {
    statusTimer = setTimeout(() => status.classList.remove('show'), 120);
    return;
  }
  status.textContent = url.replace(/^https?:\/\/(www\.)?/, '');
  status.classList.add('show');
}

function updateLoadBar() {
  const tab = T().activeTab();
  const loading = !!tab && tab.kind === 'web' && tab.loading && !U.isNewTabUrl(tab.url);
  U.$('load-bar').classList.toggle('loading', loading);
}

/* ------------------------------------------------------------------ */
/* Friendly error page                                                 */
/* ------------------------------------------------------------------ */

const ERROR_TEXT = {
  '-105': ['This site can’t be found', 'Check the address for typos, or search for it instead.'],
  '-106': ['You’re offline', 'Check your internet connection, then try again.'],
  '-102': ['This site refused to connect', 'The server isn’t accepting connections right now.'],
  '-118': ['This site took too long to respond', 'The server may be busy. Try again in a moment.'],
  '-7': ['This site took too long to respond', 'The server may be busy. Try again in a moment.'],
  '-109': ['This site can’t be reached', 'The address may be unavailable.'],
  '-137': ['This site can’t be found', 'Check the address for typos, or search for it instead.'],
  '-200': ['Your connection isn’t private', 'The site’s security certificate isn’t valid. Going there could expose your data.'],
  '-201': ['Your connection isn’t private', 'The site’s security certificate has expired or isn’t valid yet.'],
  '-202': ['Your connection isn’t private', 'The site’s security certificate isn’t trusted.'],
};

function showError(tab, e) {
  clearError(tab);
  if (ctx.privacy.httpsFailed(tab, e)) return;
  const [title, hint] = ERROR_TEXT[String(e.errorCode)] || ['This page didn’t load', 'Something went wrong while loading this page.'];
  const host = U.hostOf(e.validatedURL);
  const page = U.el('div', 'error-page tab-overlay');
  const box = U.el('div', 'error-box');
  box.appendChild(U.icon(e.errorCode === -106 ? 'globe' : 'shield'));
  box.appendChild(U.el('h2', null, title));
  box.appendChild(U.el('p', 'error-host', host));
  box.appendChild(U.el('p', null, hint));
  box.appendChild(U.el('code', null, e.errorDescription || `Error ${e.errorCode}`));
  const actions = U.el('div', 'error-actions');
  const retry = U.el('button', 'btn primary', 'Try again');
  retry.addEventListener('click', () => {
    clearError(tab);
    T().loadInTab(tab, e.validatedURL);
  });
  actions.appendChild(retry);
  if (['-105', '-137'].includes(String(e.errorCode))) {
    const search = U.el('button', 'btn', `Search for “${host}”`);
    search.addEventListener('click', () => {
      clearError(tab);
      T().loadInTab(tab, U.searchUrl(host));
    });
    actions.appendChild(search);
  }
  box.appendChild(actions);
  page.appendChild(box);
  tab.errorEl = page;
  U.$('webviews-container').appendChild(page);
  syncOverlays();
}

function clearError(tab) {
  if (tab.errorEl) tab.errorEl.remove();
  tab.errorEl = null;
}

// Overlays follow their tab's position (needed for split view)
function syncOverlays() {
  for (const tab of T().live.values()) {
    for (const overlay of [tab.errorEl, tab.readerEl]) {
      if (!overlay) continue;
      overlay.hidden = !tab.view.classList.contains('active');
      overlay.style.left = tab.view.style.left || '0';
      overlay.style.width = tab.view.style.width || '100%';
    }
  }
}

/* ------------------------------------------------------------------ */
/* HTML fullscreen (e.g. YouTube)                                      */
/* ------------------------------------------------------------------ */

function setFullscreen(tab, on) {
  document.body.classList.toggle('html-fullscreen', on);
  tab.view.classList.toggle('fullscreen-view', on);
  ipcRenderer.send('set-html-fullscreen', on);
}

/* ------------------------------------------------------------------ */
/* Permission prompts                                                  */
/* ------------------------------------------------------------------ */

const permissionQueue = [];

function permissionLabel({ permission, mediaTypes }) {
  if (permission === 'media') {
    const video = mediaTypes.includes('video');
    const audio = mediaTypes.includes('audio');
    if (video && audio) return ['use your camera and microphone', 'eye'];
    if (video) return ['use your camera', 'eye'];
    return ['use your microphone', 'volume'];
  }
  return {
    geolocation: ['know your location', 'globe'],
    notifications: ['show notifications', 'sparkles'],
    'clipboard-read': ['see text and images you copy', 'copy'],
    midi: ['use your MIDI devices', 'keyboard'],
    midiSysex: ['control your MIDI devices', 'keyboard'],
    'idle-detection': ['know when you’re using this device', 'clock'],
    'window-management': ['manage windows on your displays', 'window'],
  }[permission] || [`use ${permission}`, 'shield'];
}

function showNextPermission() {
  const host = U.$('permission-prompt');
  if (host.dataset.busy === '1' || !permissionQueue.length) return;
  const req = permissionQueue[0];
  host.dataset.busy = '1';
  host.replaceChildren();

  const [what, iconName] = permissionLabel(req);
  const text = U.el('div', 'perm-text');
  text.appendChild(U.icon(iconName));
  const msg = U.el('span');
  msg.appendChild(U.el('strong', null, U.hostOf(req.origin)));
  msg.appendChild(document.createTextNode(` wants to ${what}`));
  text.appendChild(msg);

  const respond = (allow, remember) => {
    ipcRenderer.send('permission-response', { id: req.id, allow, remember });
    permissionQueue.shift();
    host.hidden = true;
    host.dataset.busy = '0';
    setTimeout(showNextPermission, 150);
  };
  const actions = U.el('div', 'perm-actions');
  const block = U.el('button', 'btn', 'Block');
  block.addEventListener('click', () => respond(false, true));
  const once = U.el('button', 'btn', 'Allow once');
  once.addEventListener('click', () => respond(true, false));
  const allow = U.el('button', 'btn primary', 'Allow');
  allow.addEventListener('click', () => respond(true, true));
  actions.append(block, once, allow);

  host.append(text, actions);
  host.hidden = false;
}

ipcRenderer.on('permission-request', (_e, req) => {
  permissionQueue.push(req);
  showNextPermission();
});

/* ------------------------------------------------------------------ */
/* Trackpad swipe: two-finger horizontal swipe = back / forward        */
/* ------------------------------------------------------------------ */

// Positive wheel deltaX = swiping fingers to the right = go back (like Safari/Chrome)
ipcRenderer.on('swipe', async (_e, { webContentsId, amount, threshold, done }) => {
  const tab = [...T().live.values()].find((t) => t.webContentsId === webContentsId);
  const indicator = U.$('swipe-indicator');
  if (!tab || tab.entryId !== T().activeEntryId || !tab.ready) {
    indicator.className = '';
    return;
  }
  const back = amount > 0;
  let possible = false;
  try {
    possible = back ? tab.webview.canGoBack() : tab.webview.canGoForward();
  } catch { /* detached */ }

  if (done) {
    indicator.className = '';
    if (!possible || Math.abs(amount) < (threshold || 260)) return;
    // Don't hijack horizontal scrolling: only navigate when the page is at its edge
    let atEdge = true;
    try {
      atEdge = await tab.webview.executeJavaScript(back ? 'window.scrollX <= 0' : 'window.scrollX + window.innerWidth >= document.documentElement.scrollWidth - 1');
    } catch { /* assume edge */ }
    if (atEdge) (back ? tab.webview.goBack() : tab.webview.goForward());
    return;
  }

  if (!possible) {
    indicator.className = '';
    return;
  }
  const progress = Math.min(1, Math.abs(amount) / (threshold || 260));
  indicator.className = `${back ? 'back' : 'forward'} visible${progress >= 1 ? ' ready' : ''}`;
  indicator.style.setProperty('--p', progress.toFixed(3));
});

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Developer mode: local dev servers get an error counter + tools      */
/* ------------------------------------------------------------------ */

const isDevUrl = (url) => {
  try {
    const u = new URL(url);
    return ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(u.hostname) || u.hostname.endsWith('.local') || u.hostname.endsWith('.test') || u.protocol === 'file:' && !U.isNewTabUrl(url);
  } catch {
    return false;
  }
};

function updateDevPill() {
  const pill = U.$('dev-pill');
  const tab = T().activeTab();
  if (!tab || tab.kind !== 'web' || !isDevUrl(tab.url)) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  pill.replaceChildren();
  const label = U.el('span', 'dev-label');
  label.append(U.icon('code'), document.createTextNode(` ${U.hostOf(tab.url) || 'file'}`));
  pill.appendChild(label);
  const errors = U.el('button', 'dev-errors' + (tab.devErrors ? ' has' : ''), `${tab.devErrors || 0} error${tab.devErrors === 1 ? '' : 's'}`);
  errors.title = tab.devLastError || 'Console errors since load — click to open DevTools';
  errors.addEventListener('click', () => openDevTools(tab));
  pill.appendChild(errors);
  pill.appendChild(U.iconButton('reload', 'Hard reload (skip cache)', () => {
    tab.devErrors = 0;
    tab.webview.reloadIgnoringCache();
  }, 'icon-btn small'));
  pill.appendChild(U.iconButton('code', 'DevTools (⌥⌘I)', () => openDevTools(tab), 'icon-btn small'));
}

function openDevTools(tab = T().activeTab()) {
  if (!tab || tab.kind !== 'web' || !tab.ready) return;
  if (tab.webview.isDevToolsOpened()) tab.webview.closeDevTools();
  else tab.webview.openDevTools();
}

function bindTab(tab) {
  const wv = tab.webview;
  wv.addEventListener('did-start-loading', () => {
    tab.devErrors = 0;
    if (tab.entryId === T().activeEntryId) updateDevPill();
  });
  wv.addEventListener('console-message', (e) => {
    const level = typeof e.level === 'string' ? e.level : ['verbose', 'info', 'warning', 'error'][e.level];
    if (level !== 'error' || !isDevUrl(tab.url)) return;
    tab.devErrors = (tab.devErrors || 0) + 1;
    tab.devLastError = e.message;
    if (tab.entryId === T().activeEntryId) updateDevPill();
  });
  wv.addEventListener('found-in-page', (e) => onFound(tab, e.result));
  wv.addEventListener('update-target-url', (e) => showLinkStatus(tab, e.url));
  wv.addEventListener('dom-ready', () => applyZoom(tab));
  wv.addEventListener('did-start-loading', () => clearError(tab));
  wv.addEventListener('did-fail-load', (e) => {
    if (e.isMainFrame && e.errorCode !== -3) showError(tab, e);
  });
  wv.addEventListener('enter-html-full-screen', () => setFullscreen(tab, true));
  wv.addEventListener('leave-html-full-screen', () => setFullscreen(tab, false));
}

// Called whenever the active tab changes or loads
function onActiveChange() {
  const tab = T().activeTab();
  if (findTab && findTab !== tab) closeFind();
  U.$('link-status').classList.remove('show');
  updateLoadBar();
  updateZoomBadge();
  updateDevPill();
  syncOverlays();
}

function setup() {
  const input = U.$('find-input');
  input.addEventListener('input', () => find(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      find(false, !e.shiftKey);
    } else if (e.key === 'Escape') {
      closeFind();
    }
  });
  U.$('find-prev').addEventListener('click', () => find(false, false));
  U.$('find-next').addEventListener('click', () => find(false, true));
  U.$('find-close').addEventListener('click', closeFind);
  U.$('zoom-btn').addEventListener('mousedown', (e) => e.preventDefault());
  U.$('zoom-btn').addEventListener('click', () => zoom(0));
}

ctx.page = { hoveredLink: () => hovered, openDevTools, setup, bindTab, openFind, closeFind, findStep, zoom, onActiveChange, syncOverlays, updateLoadBar };
