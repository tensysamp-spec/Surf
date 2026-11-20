// Crash recovery in the window: keeps saved state on disk, puts back what a crash would lose
// (scroll positions, the open Library drawer), says so after an unclean exit, and turns a
// crashed page into a friendly "This page crashed" state instead of a blank tab.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const SESSION_KEY = 'browser.session';
const ISSUES_URL = 'https://github.com/tensysamp-spec/surf/issues/new';
const FLUSH_EVERY = 2000; // ms; at most this much is lost if Surf is killed
const SNAPSHOT_EVERY = 5000;

// What the last run left behind: { drawer, scroll: { entryId: { url, y } } }
const saved = U.PRIVATE ? {} : U.store.get(SESSION_KEY, {});
let lastSnapshot = JSON.stringify(saved);
let dirty = false;

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */

// localStorage is written to disk lazily by Chromium, seconds later; a crash in between
// loses it. Ask the main process to write it out shortly after anything changes.
function flush() {
  if (!dirty) return;
  dirty = false;
  ipcRenderer.send('flush-storage');
}

// Scroll positions of the pages on screen, and whether the Library drawer is open
async function snapshot() {
  const scroll = { ...(saved.scroll || {}) };
  // Forget tabs that were closed
  for (const id of Object.keys(scroll)) if (!ctx.tabs.findEntry(id)) delete scroll[id];
  for (const id of ctx.tabs.displayed) {
    const tab = ctx.tabs.live.get(id);
    if (!tab || tab.kind !== 'web' || !tab.ready || tab.crashed || tab.restoringScroll) continue;
    try {
      const y = await tab.webview.executeJavaScript('Math.round(window.scrollY)');
      if (y > 0) scroll[id] = { url: tab.url, y };
      else delete scroll[id];
    } catch { /* page busy or gone */ }
  }
  saved.scroll = scroll;
  saved.drawer = ctx.library.isOpen() ? ctx.library.current() : null;
  const json = JSON.stringify(saved);
  if (json === lastSnapshot) return;
  lastSnapshot = json;
  U.store.set(SESSION_KEY, saved);
}

/* ------------------------------------------------------------------ */
/* Per-tab: scroll restore and crashed pages                           */
/* ------------------------------------------------------------------ */

// Put a page back where it was scrolled to. Pages that build up their content late get a
// few more tries, unless the reader has scrolled in the meantime.
function restoreScroll(tab) {
  const spot = saved.scroll && saved.scroll[tab.entryId];
  if (!spot || spot.url !== tab.url) return;
  tab.restoringScroll = true;
  const tries = [0, 400, 1200, 2500];
  let lastY = 0;
  const attempt = (i) => {
    if (i >= tries.length || tab.crashed || !tab.webview.isConnected) {
      tab.restoringScroll = false;
      return;
    }
    setTimeout(async () => {
      try {
        const { before, after } = await tab.webview.executeJavaScript(
          `(() => { const before = Math.round(window.scrollY); if (before === ${lastY}) window.scrollTo({ top: ${Number(spot.y)}, behavior: "instant" }); return { before, after: Math.round(window.scrollY) }; })()`,
        );
        // Stop once it's there, or if the reader moved the page themselves
        if (before !== lastY || Math.abs(after - spot.y) < 4) {
          tab.restoringScroll = false;
          return;
        }
        lastY = after;
      } catch { /* try again */ }
      attempt(i + 1);
    }, tries[i]);
  };
  attempt(0);
}

function showCrashed(tab, details) {
  if (tab.errorEl) tab.errorEl.remove();
  tab.crashed = true;
  const page = U.el('div', 'error-page tab-overlay crash-page');
  const box = U.el('div', 'error-box');
  box.appendChild(U.icon('zap'));
  box.appendChild(U.el('h2', null, 'This page crashed'));
  box.appendChild(U.el('p', 'error-host', U.hostOf(tab.url)));
  box.appendChild(U.el('p', null, details.reason === 'oom'
    ? 'It ran out of memory. Reloading usually brings it back.'
    : 'Something went wrong while showing this page. Reloading usually brings it back.'));
  const actions = U.el('div', 'error-actions');
  const reload = U.el('button', 'btn primary', 'Reload');
  reload.addEventListener('click', () => reloadCrashed(tab));
  actions.appendChild(reload);
  box.appendChild(actions);
  page.appendChild(box);
  tab.errorEl = page;
  U.$('webviews-container').appendChild(page);
  ctx.page.syncOverlays();
  ctx.sidebar.updateEntry(tab.entryId);
}

function reloadCrashed(tab) {
  if (tab.errorEl) tab.errorEl.remove();
  tab.errorEl = null;
  tab.crashed = false;
  ctx.tabs.loadInTab(tab, tab.url);
}

function bindTab(tab) {
  const wv = tab.webview;
  let firstLoad = true;
  wv.addEventListener('did-stop-loading', () => {
    if (!firstLoad || U.PRIVATE) return;
    firstLoad = false;
    restoreScroll(tab);
  });
  wv.addEventListener('render-process-gone', (e) => {
    const details = e.details || {};
    // A page closed by Surf itself (unloading a tab) exits cleanly
    if (details.reason === 'clean-exit' || !wv.isConnected) return;
    tab.loading = false;
    showCrashed(tab, details);
    if (tab.entryId === ctx.tabs.activeEntryId) ctx.nav.update();
  });
  wv.addEventListener('did-start-loading', () => { tab.crashed = false; });
}

/* ------------------------------------------------------------------ */
/* After a crash                                                       */
/* ------------------------------------------------------------------ */

function reportUrl(status) {
  const last = status.crashes[status.crashes.length - 1];
  const title = `Crash: ${last.what} process ${last.reason}`;
  const body = [
    'What were you doing when Surf crashed?',
    '',
    '',
    '---',
    `Surf ${status.version}, Electron ${status.electron}, ${status.os}`,
    ...status.crashes.map((c) => `- ${c.what}: ${c.reason} (exit code ${c.exitCode})`),
  ].join('\n');
  return `${ISSUES_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

async function checkLastExit() {
  let status = null;
  try {
    status = await ipcRenderer.invoke('recovery-status');
  } catch { /* main process without recovery */ }
  if (!status) return;
  if (saved.drawer) ctx.library.open(saved.drawer);
  // Offer a report only when we saw something crash; a force quit or power loss leaves
  // nothing worth filing
  const report = status.crashes.length > 0;
  U.toast('Surf quit unexpectedly — your tabs are back', {
    duration: report ? 9000 : 5000,
    ...(report ? { action: () => ctx.tabs.openTab(reportUrl(status)), actionLabel: 'Report' } : {}),
  });
}

function setup() {
  if (U.PRIVATE) return;
  U.store.onWrite = () => { dirty = true; };
  setInterval(flush, FLUSH_EVERY);
  setInterval(snapshot, SNAPSHOT_EVERY);
  window.addEventListener('beforeunload', () => {
    ctx.tabs.saveNow();
    saved.drawer = ctx.library.isOpen() ? ctx.library.current() : null;
    U.store.set(SESSION_KEY, saved);
    ipcRenderer.send('flush-storage');
  });
  checkLastExit();
}

ctx.recovery = { setup, bindTab, flush };
