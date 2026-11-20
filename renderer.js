// Entry point for the main window: loads every module, wires main-process events, boots.
const { ipcRenderer } = require('electron');

const ctx = require('./src/ctx');
const U = require('./src/util');
require('./src/settings');
require('./src/tabs');
require('./src/sitecolor');
require('./src/sidebar');
require('./src/nav');
require('./src/command');
require('./src/tabsearch');
require('./src/library');
require('./src/bookmarks');
require('./src/shortcuts');
require('./src/profiles');
require('./src/shelf');
require('./src/switcher');
require('./src/peek');
require('./src/boosts');
require('./src/media');
require('./src/internal');
require('./src/ai');
require('./src/page');
require('./src/suggest');
require('./src/reader');
require('./src/extensions');
require('./src/livefolders');
require('./src/panels');
require('./src/speech');
require('./src/highlights');
require('./src/screenshot');
require('./src/passwords');
require('./src/autofill');
require('./src/readinglist');
require('./src/privacy');
require('./src/intro');
require('./src/recovery');

/* ------------------------------------------------------------------ */
/* Main-process events                                                 */
/* ------------------------------------------------------------------ */

ipcRenderer.on('open-in-new-tab', (_e, { url, background }) => {
  ctx.tabs.openTab(url, { activate: !background });
  if (background) U.toast('Opened in background', { action: () => ctx.tabs.showEntry(ctx.tabs.activeSpace().today[0].id), actionLabel: 'Show' });
});

ipcRenderer.on('peek-url', (_e, url) => ctx.peek.open(url));

ipcRenderer.on('context-action', (_e, { type, url, webContentsId }) => {
  switch (type) {
    case 'new-tab': ctx.tabs.openTab(url, { activate: false }); break;
    case 'peek': ctx.peek.open(url); break;
    case 'split': ctx.tabs.splitWithUrl(url); break;
    case 'search': ctx.tabs.openTab(U.searchUrl(url)); break;
    case 'summarize-link': ctx.ai.summarizeLink(url); break;
    case 'translate': ctx.ai.translatePage(); break;
    case 'read-aloud': ctx.speech.readActive(); break;
    case 'screenshot': ctx.screenshot.menu(); break;
    case 'ask-selection': ctx.ai.askAbout(url); break;
    case 'highlight': {
      const tab = [...ctx.tabs.live.values()].find((t) => t.webContentsId === webContentsId) || ctx.tabs.activeTab();
      ctx.highlights.add(tab, url);
      break;
    }
    case 'reader': ctx.reader.toggle(); break;
  }
});

// Menu bar items that open a Settings section (e.g. Open Profile → Manage Profiles…)
ipcRenderer.on('open-settings', (_e, section) => ctx.settings.open(section));

ipcRenderer.on('fullscreen-changed', (_e, isFullscreen) => {
  document.body.classList.toggle('fullscreen', isFullscreen);
});

const SHORTCUTS = {
  'new-tab': () => ctx.command.toggle(),
  'tab-search': () => ctx.tabSearch.toggle(),
  'close-tab': () => {
    if (ctx.peek.isOpen()) ctx.peek.close();
    else if (ctx.command.isOpen()) ctx.command.close();
    else if (ctx.tabSearch.isOpen()) ctx.tabSearch.close();
    else ctx.tabs.closeActive();
  },
  'reopen-closed': () => ctx.tabs.reopenClosed(),
  reload: () => ctx.nav.reload(),
  'focus-url': () => {
    ctx.command.close();
    ctx.nav.focusUrl();
  },
  'toggle-sidebar': () => ctx.sidebar.toggleCollapsed(),
  'toggle-pin': () => ctx.tabs.togglePin(),
  'split-view': () => ctx.tabs.splitActiveWithNewTab(),
  'copy-url': () => ctx.nav.copyUrl(),
  capture: () => ctx.internal.startCapture(),
  history: () => ctx.library.toggle('history'),
  bookmarks: () => ctx.library.toggle('bookmarks'),
  'bookmark-page': () => ctx.bookmarks.addCurrent(),
  downloads: () => ctx.library.toggle('downloads'),
  'reading-list': () => ctx.readingList.addActive(),
  settings: () => ctx.settings.open(),
  back: () => ctx.nav.back(),
  forward: () => ctx.nav.forward(),
  'next-tab': () => ctx.switcher.step(1),
  'prev-tab': () => ctx.switcher.step(-1),
  escape: () => U.handleEscape(),
  find: () => ctx.page.openFind(),
  'find-next': () => ctx.page.findStep(true),
  'find-prev': () => ctx.page.findStep(false),
  'zoom-in': () => ctx.page.zoom(1),
  'zoom-out': () => ctx.page.zoom(-1),
  'zoom-reset': () => ctx.page.zoom(0),
  reader: () => ctx.reader.toggle(),
  compact: () => ctx.sidebar.toggleCompact(),
  devtools: () => ctx.page.openDevTools(),
  screenshot: () => ctx.screenshot.menu(),
};

ipcRenderer.on('shortcut', (_e, action) => {
  if (SHORTCUTS[action]) SHORTCUTS[action]();
  else if (action.startsWith('tab-')) ctx.tabs.selectByNumber(Number(action.slice(4)));
  else if (action.startsWith('space-')) ctx.tabs.switchSpaceByNumber(Number(action.slice(6)));
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

document.body.classList.add(`platform-${process.platform}`);
ctx.sidebar.setup();
ctx.nav.setup();
ctx.command.setup();
ctx.tabSearch.setup();
ctx.library.setup();
ctx.shelf.setup();
ctx.switcher.setup();
ctx.peek.setup();
ctx.media.setup();
ctx.ai.setup();
ctx.page.setup();
ctx.suggest.setup();
ctx.extensions.setup();
ctx.panels.setup();
ctx.liveFolders.setup();
ctx.bookmarks.setup();
ctx.profiles.setup();

// Air Traffic Control: a link from another app routed to a Space
ipcRenderer.on('open-in-space', (_e, { url, spaceId }) => {
  const space = ctx.tabs.getSpace(spaceId);
  ctx.tabs.openTab(url, { spaceId: space ? spaceId : ctx.tabs.activeSpaceId, activate: false });
  ctx.tabs.showEntry((space || ctx.tabs.activeSpace()).today[0].id);
  if (space) U.toast(`Opened in ${space.name}`);
});

// Mouse gestures (right-drag on a page)
const GESTURE_LABELS = { back: '← Back', forward: '→ Forward', 'new-tab': '↓ New tab', 'close-tab': '↓→ Close tab', reload: '↑↓ Reload', 'scroll-top': '↑ Top', 'reopen-closed': '↓← Reopen tab' };
ipcRenderer.on('gesture', (_e, { action, webContentsId }) => {
  if (!action) {
    U.toast('Gesture not recognized', { duration: 1200 });
    return;
  }
  const tab = [...ctx.tabs.live.values()].find((t) => t.webContentsId === webContentsId);
  if (tab && tab.entryId !== ctx.tabs.activeEntryId) ctx.tabs.showEntry(tab.entryId, { focus: false });
  if (action === 'scroll-top') {
    if (tab) tab.webview.executeJavaScript('window.scrollTo({ top: 0, behavior: "smooth" })').catch(() => {});
  } else if (SHORTCUTS[action]) {
    SHORTCUTS[action]();
  }
  U.toast(GESTURE_LABELS[action] || action, { duration: 900 });
});

if (U.PRIVATE) {
  document.body.classList.add('private');
  document.title = 'Private — Surf';
}

ipcRenderer.on('shift-key', () => ctx.ai.linkPreview());
ctx.tabs.boot();
ctx.intro.maybeShowFirstRun();
ctx.recovery.setup();

U.$('settings-btn').addEventListener('click', () => ctx.settings.open());
U.$('profile-chip').addEventListener('click', () => ctx.settings.open('profiles'));
