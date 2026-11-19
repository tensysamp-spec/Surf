const { app, BrowserWindow, ipcMain, Menu, clipboard, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');

// Show "Surf" in the app menu, but keep the profile in the folder it has always used
// (the app was called "Browser" before), so tabs and settings carry over.
// SURF_PROFILE_DIR points it at a separate profile instead (used to record demo videos).
// Named profiles (Settings → Profiles) are separate folders that run as their own Surf process.
const defaultProfileDir = path.join(app.getPath('appData'), 'Browser');
const profileDir = process.env.SURF_PROFILE_DIR || defaultProfileDir;
app.setName('Surf');
app.setPath('userData', profileDir);

const shortcuts = require('./main/shortcuts');

/* ------------------------------------------------------------------ */
/* Window registry & message routing                                   */
/* ------------------------------------------------------------------ */

let mainWindow = null;
const browserWindows = new Set(); // main + private windows (full browser UI)
const miniWindows = new Set();
const escapeCaptured = new Map(); // window id -> bool
let privateCount = 0;
const privatePartitions = new Map(); // private window id -> its pages' in-memory partition

// Which top-level window does a webContents (or the <webview> inside it) belong to?
function ownerWindow(contents) {
  return BrowserWindow.fromWebContents(contents.hostWebContents || contents);
}
const windowOf = (contents) => BrowserWindow.fromWebContents(contents);
const isBrowserWindow = (win) => !!win && browserWindows.has(win);

function sendToWindow(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function sendToMain(channel, payload) {
  sendToWindow(mainWindow, channel, payload);
}
// Events from a page go to the browser window showing it (links from little windows go to main)
function sendToOwner(contents, channel, payload) {
  const win = ownerWindow(contents);
  sendToWindow(isBrowserWindow(win) ? win : mainWindow, channel, payload);
}

// The session a window's own requests should use: a private window's UI runs in the
// default session, but anything it fetches must use its private partition instead
function sessionFor(contents) {
  const win = ownerWindow(contents);
  const partition = win && privatePartitions.get(win.id);
  return partition ? session.fromPartition(partition) : contents.session;
}

const M = {
  ownerWindow,
  sessionFor,
  windowOf,
  isBrowserWindow,
  isPrivateWindow: (win) => !!win && privatePartitions.has(win.id),
  sendToMain,
  sendToOwner,
  getMainWindow: () => mainWindow,
  gesturesEnabled: () => features.prefs().gestures !== false,
  // Bring the main window forward, reopening it if it was closed (macOS keeps the app running)
  focusMain: () => {
    if (!mainWindow) return createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  },
  rebuildMenu: () => buildMenu(),
  profileDir,
  defaultProfileDir,
};

const sessions = require('./main/sessions')(M);
const ai = require('./main/ai')(M);
const tools = require('./main/tools')(M);
require('./main/autofill')(M);
const profiles = require('./main/profiles')(M);

/* ------------------------------------------------------------------ */
/* Misc IPC                                                            */
/* ------------------------------------------------------------------ */

ipcMain.on('copy-text', (_event, text) => clipboard.writeText(String(text)));

// Easel clips are saved as PNG files instead of bloating localStorage
ipcMain.handle('save-clip', async (_event, pngBytes) => {
  const dir = path.join(app.getPath('userData'), 'clips');
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  await fs.promises.writeFile(file, Buffer.from(pngBytes));
  return 'file://' + file;
});

// Escape normally belongs to the page; a window asks for it while an overlay is open
ipcMain.on('set-escape-capture', (event, on) => {
  const win = windowOf(event.sender);
  if (win) escapeCaptured.set(win.id, !!on);
});

// HTML fullscreen (e.g. YouTube) takes over the whole window
const htmlFullscreen = new Set();
ipcMain.on('set-html-fullscreen', (event, on) => {
  const win = windowOf(event.sender);
  if (!win) return;
  if (on && !win.isFullScreen()) {
    htmlFullscreen.add(win.id);
    win.setFullScreen(true);
  } else if (!on && htmlFullscreen.has(win.id)) {
    htmlFullscreen.delete(win.id);
    win.setFullScreen(false);
  }
});

// Compact mode hides the macOS window buttons until the sidebar peeks in
ipcMain.on('set-traffic-lights', (event, visible) => {
  const win = windowOf(event.sender);
  if (win && process.platform === 'darwin') win.setWindowButtonVisibility(!!visible);
});

ipcMain.on('open-little-window', (_event, url) => createMiniWindow(url));
ipcMain.on('open-private-window', () => createPrivateWindow());
ipcMain.on('mini-promote', (event, url) => {
  openInMainWindow(url);
  const win = windowOf(event.sender);
  if (win) win.close();
});

/* ------------------------------------------------------------------ */
/* Keyboard shortcuts                                                  */
/* ------------------------------------------------------------------ */

// Shortcuts are captured in the main process so they work even when a
// <webview> has keyboard focus (the host page never sees those key events).
// Most come from the table in main/shortcuts.js, with the user's overrides from Settings.
const recording = new Set(); // windows where Settings is recording a new shortcut

function matchShortcut(input, win) {
  if (input.type !== 'keyDown') return null;
  // Let the keys through to Settings while it records one
  if (win && recording.has(win.id)) return null;

  const isMac = process.platform === 'darwin';
  const key = input.key.toLowerCase();
  const mod = isMac ? input.meta : input.control;

  // Fixed shortcuts (not customizable)
  if (input.key === 'F5') return 'reload';
  if (input.key === 'Escape') return win && escapeCaptured.get(win.id) ? 'escape' : null;
  if (input.control && key === 'tab') return input.shift ? 'prev-tab' : 'next-tab';

  // Spaces: Ctrl+1..9 on macOS, Alt+1..9 elsewhere
  const spaceMod = isMac ? input.control && !input.meta : input.alt && !input.control;
  if (spaceMod && /^Digit[1-9]$/.test(input.code)) return `space-${input.code.slice(5)}`;

  const combo = shortcuts.comboFromInput(input);
  const action = combo && shortcuts.actionFor(combo, features.prefs().shortcuts);
  if (action) return action;

  if (mod && !input.alt && !input.shift && /^[1-9]$/.test(key)) return `tab-${key}`;
  return null;
}

// Settings asks for raw keys while it records a shortcut
ipcMain.on('shortcut-recording', (event, on) => {
  const win = windowOf(event.sender);
  if (!win) return;
  if (on) recording.add(win.id);
  else recording.delete(win.id);
});

ipcMain.handle('shortcuts-get', () => features.prefs().shortcuts || {});

ipcMain.handle('shortcuts-set', (_event, overrides) => {
  // Keep only valid entries; anything else falls back to the default
  const clean = {};
  for (const [id, combo] of Object.entries(overrides || {})) {
    if (id in shortcuts.DEFAULTS && (combo === null || (typeof combo === 'string' && !shortcuts.problem(combo)))) clean[id] = combo;
  }
  features.setPref('shortcuts', clean);
  buildMenu();
  for (const win of browserWindows) sendToWindow(win, 'shortcuts-changed', clean);
  return clean;
});

/* ------------------------------------------------------------------ */
/* Page context menu                                                   */
/* ------------------------------------------------------------------ */

function buildContextMenu(contents, params) {
  const win = ownerWindow(contents);
  const inBrowser = isBrowserWindow(win);
  const action = (type, value) => () => {
    if (inBrowser) sendToWindow(win, 'context-action', { type, url: value, webContentsId: contents.id });
    else if (type === 'search' || type === 'new-tab') openInMainWindow(type === 'new-tab' ? value : null, type === 'search' ? value : null);
  };
  const template = [];

  if (params.linkURL) {
    template.push(
      { label: 'Open Link in New Tab', click: action('new-tab', params.linkURL) },
      ...(inBrowser ? [
        { label: 'Open Link in Peek', click: action('peek', params.linkURL) },
        { label: 'Open Link in Split View', click: action('split', params.linkURL) },
        // Little windows use the default session, so a private window opens the link in a private tab instead
        { label: 'Open Link in Little Window', click: contents.session.isPersistent() ? () => createMiniWindow(params.linkURL) : action('new-tab', params.linkURL) },
        { label: 'Summarize Link with AI', click: action('summarize-link', params.linkURL) },
      ] : []),
      { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' },
    );
  }

  if (params.mediaType === 'image' && params.srcURL) {
    template.push(
      { label: 'Open Image in New Tab', click: action('new-tab', params.srcURL) },
      { label: 'Save Image As…', click: () => contents.downloadURL(params.srcURL) },
      { label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) },
      { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
      { type: 'separator' },
    );
  }

  if (params.isEditable) {
    template.push(
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      { type: 'separator' },
    );
  } else if (params.selectionText && params.selectionText.trim()) {
    const text = params.selectionText.trim();
    const short = text.length > 24 ? text.slice(0, 24) + '…' : text;
    template.push(
      { role: 'copy' },
      { label: `Search for “${short}”`, click: action('search', text) },
      ...(inBrowser ? [
        { label: 'Highlight', click: action('highlight', text) },
        { label: `Ask Claude about “${short}”`, click: action('ask-selection', text) },
      ] : []),
      { type: 'separator' },
    );
  }

  if (inBrowser && !params.linkURL && !params.isEditable && !params.selectionText) {
    template.push(
      { label: 'Reader View', click: action('reader') },
      { label: 'Read Aloud', click: action('read-aloud') },
      { label: 'Translate Page', click: action('translate') },
      { label: 'Take Screenshot', click: action('screenshot') },
      { type: 'separator' },
    );
  }

  const nav = contents.navigationHistory;
  template.push(
    { label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() },
    { label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() },
    { label: 'Reload', click: () => contents.reload() },
    { type: 'separator' },
    { label: 'Inspect Element', click: () => contents.inspectElement(params.x, params.y) },
  );

  return Menu.buildFromTemplate(template);
}

/* ------------------------------------------------------------------ */
/* Windows                                                             */
/* ------------------------------------------------------------------ */

// Remember the main window's size and position between launches
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return state.x < a.x + a.width - 100 && state.x + state.width > a.x + 100 && state.y >= a.y - 20 && state.y < a.y + a.height - 100;
    });
    return visible ? state : { width: state.width, height: state.height };
  } catch {
    return { width: 1280, height: 800 };
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    fs.writeFileSync(windowStateFile(), JSON.stringify({ ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() }));
  } catch { /* not fatal */ }
}

function createBrowserWindow({ query = {}, bounds = {}, background = '#f3f1f8' } = {}) {
  const win = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 800,
    x: bounds.x,
    y: bounds.y,
    minWidth: 720,
    minHeight: 480,
    title: 'Surf',
    backgroundColor: background,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    show: false,
    webPreferences: {
      webviewTag: true,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  browserWindows.add(win);
  win.loadFile(path.join(__dirname, 'index.html'), { query });
  // The browser UI itself never navigates away (e.g. a dropped link)
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('enter-full-screen', () => sendToWindow(win, 'fullscreen-changed', true));
  win.on('leave-full-screen', () => sendToWindow(win, 'fullscreen-changed', false));
  win.on('closed', () => {
    browserWindows.delete(win);
    escapeCaptured.delete(win.id);
  });
  return win;
}

function createWindow() {
  const state = loadWindowState();
  mainWindow = createBrowserWindow({ bounds: state });
  mainWindow.once('ready-to-show', () => {
    if (state.maximized) mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.on('close', saveWindowState);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// Private window: in-memory session, nothing saved
function createPrivateWindow() {
  privateCount++;
  const partition = `private-${Date.now()}-${privateCount}`;
  const win = createBrowserWindow({ query: { private: '1', partition }, background: '#1c1828' });
  const id = win.id;
  privatePartitions.set(id, partition);
  win.on('closed', () => privatePartitions.delete(id));
  win.once('ready-to-show', () => win.show());
  return win;
}

// "Little" window: a small, focused window for quick lookups
function createMiniWindow(url) {
  const win = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 380,
    minHeight: 360,
    title: 'Surf',
    backgroundColor: '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { webviewTag: true, nodeIntegration: true, contextIsolation: false },
  });
  win.loadFile(path.join(__dirname, 'mini.html'), { query: url ? { url } : {} });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  miniWindows.add(win);
  win.on('closed', () => miniWindows.delete(win));
  return win;
}
M.createMiniWindow = createMiniWindow;

function openInMainWindow(url, searchText = null) {
  if (!mainWindow) createWindow();
  const send = () => {
    if (searchText) sendToMain('context-action', { type: 'search', url: searchText });
    else if (url) sendToMain('open-in-new-tab', { url, background: false });
    mainWindow.show();
    mainWindow.focus();
  };
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', send);
  else send();
}

app.on('web-contents-created', (_event, contents) => {
  // Lock down every guest page: no Node, isolated context, no custom preload.
  contents.on('will-attach-webview', (_e, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });

  // A lone Shift tap (pressed and released with nothing else in between) while hovering
  // a link opens an AI link preview — not Shift held for a capital letter or Shift+click
  let shiftTap = false;
  contents.on('input-event', (_e, input) => {
    if (input.type === 'mouseDown') shiftTap = false;
  });

  contents.on('before-input-event', (event, input) => {
    const win = ownerWindow(contents);
    if (!win) return;
    if (input.type === 'keyDown' && !input.isAutoRepeat) {
      shiftTap = input.key === 'Shift' && !input.meta && !input.control && !input.alt;
    } else if (input.type === 'keyUp' && input.key === 'Shift') {
      // Never swallowed: the page still sees its Shift events
      if (shiftTap && isBrowserWindow(win)) sendToWindow(win, 'shift-key');
      shiftTap = false;
    }
    // Releasing Control commits the ⌃Tab tab switcher
    if (input.type === 'keyUp' && input.key === 'Control' && isBrowserWindow(win)) {
      sendToWindow(win, 'control-up');
    }
    const action = matchShortcut(input, win);
    if (!action) return;

    if (action === 'little-window') {
      event.preventDefault();
      createMiniWindow();
    } else if (action === 'private-window') {
      event.preventDefault();
      createPrivateWindow();
    } else if (isBrowserWindow(win)) {
      event.preventDefault();
      sendToWindow(win, 'shortcut', action);
    } else if (miniWindows.has(win) && ['close-tab', 'escape', 'focus-url', 'reload'].includes(action)) {
      event.preventDefault();
      sendToWindow(win, 'shortcut', action);
    }
  });

  if (contents.getType() === 'webview') {
    // target="_blank" / window.open -> new tab inside our browser; Shift+click -> Peek
    contents.setWindowOpenHandler(({ url, disposition, features: winFeatures }) => {
      // Only web pages may open tabs (no file:, javascript:, chrome:, …)
      if (!/^https?:\/\//i.test(url)) return { action: 'deny' };
      const win = ownerWindow(contents);
      if (!isBrowserWindow(win)) {
        openInMainWindow(url);
      } else if (disposition === 'new-window' && !winFeatures) {
        sendToWindow(win, 'peek-url', url);
      } else {
        sendToWindow(win, 'open-in-new-tab', { url, background: disposition === 'background-tab' });
      }
      return { action: 'deny' };
    });

    contents.on('context-menu', (_e, params) => {
      tools.showContextMenu(contents, () => {
        if (!contents.isDestroyed()) buildContextMenu(contents, params).popup({ window: ownerWindow(contents) || undefined });
      });
    });

    features.watchSwipes(contents);
    tools.watchGestures(contents);

    // Per-page blocked counter resets on every full navigation
    contents.on('did-navigate', () => sessions.resetBlockedCount(contents));
    const id = contents.id;
    contents.once('destroyed', () => sessions.forgetContents(id));
  }
});

function buildMenu() {
  const isMac = process.platform === 'darwin';
  // Menus show the user's current shortcuts; the keys themselves are handled in before-input-event
  // (registerAccelerator: false) so they also work inside pages
  const bindings = shortcuts.effective(features.prefs().shortcuts);
  const accel = (action) => ({ accelerator: shortcuts.toAccelerator(bindings[action]), registerAccelerator: false });
  const sendShortcut = (action) => {
    const focused = BrowserWindow.getFocusedWindow();
    sendToWindow(isBrowserWindow(focused) ? focused : mainWindow, 'shortcut', action);
  };
  const openSettings = (section) => {
    if (!mainWindow) createWindow();
    const focused = BrowserWindow.getFocusedWindow();
    const win = isBrowserWindow(focused) ? focused : mainWindow;
    const send = () => sendToWindow(win, 'open-settings', section);
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
    win.show();
  };
  const profileMenu = {
    label: 'Open Profile',
    submenu: [
      ...profiles.list().map((p) => ({
        label: p.name,
        type: 'checkbox',
        checked: p.current,
        click: () => profiles.open(p.id),
      })),
      { type: 'separator' },
      { label: 'Manage Profiles…', click: () => openSettings('profiles') },
    ],
  };
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', ...accel('settings'), click: () => sendShortcut('settings') },
        profileMenu,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Private Window', ...accel('private-window'), click: () => createPrivateWindow() },
        { label: 'New Little Window', ...accel('little-window'), click: () => createMiniWindow() },
        { type: 'separator' },
        { ...profileMenu, submenu: profileMenu.submenu.map((item) => ({ ...item })) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools', label: 'Toggle Surf DevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ role: 'front' }] : [])],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* Extra features (import, default browser, swipe, extensions, …)      */
/* ------------------------------------------------------------------ */

const features = require('./main-features')(M);

/* ------------------------------------------------------------------ */
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  // The packaged app gets its icon from the bundle; when run with `npm start`, set it here
  if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(__dirname, 'build', 'icon.png'));
  sessions.configureAll();
  buildMenu();

  // Launched by clicking a link in another app: show just the little window (unless set to tabs)
  const launchedForLink = features.onReady();
  if (!launchedForLink || features.prefs().linkTarget === 'tab') {
    createWindow();
    mainWindow.webContents.once('did-finish-load', () => features.flushPendingUrls());
  } else {
    features.flushPendingUrls();
  }

  app.on('activate', () => {
    if (!mainWindow) createWindow();
    else mainWindow.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

module.exports = { ai };
