// Main-process features: import from other browsers, search suggestions, default browser,
// trackpad swipe navigation, Chrome extensions, appearance prefs, and web-search AI.

const { app, BrowserWindow, ipcMain, session, nativeTheme, dialog, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const webStore = require('electron-chrome-web-store');

const run = promisify(execFile);

module.exports = function setupFeatures(M) {
  const { getMainWindow, sendToMain, sendToOwner, ownerWindow, isBrowserWindow } = M;
  const createMiniWindow = (url) => M.createMiniWindow(url);
  /* ---------------------------------------------------------------- */
  /* Preferences the main process needs before the UI loads           */
  /* ---------------------------------------------------------------- */

  const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
  let prefs = { appearance: 'system', linkTarget: 'little' };
  try {
    prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) };
  } catch { /* first run */ }

  function applyAppearance() {
    nativeTheme.themeSource = prefs.appearance === 'light' || prefs.appearance === 'dark' ? prefs.appearance : 'system';
  }
  applyAppearance();

  function setPref(key, value) {
    prefs[key] = value;
    fs.promises.writeFile(prefsFile(), JSON.stringify(prefs)).catch(() => {});
    if (key === 'appearance') applyAppearance();
  }
  ipcMain.on('set-pref', (_event, key, value) => setPref(key, value));

  /* ---------------------------------------------------------------- */
  /* Default browser + links opened from other apps                   */
  /* ---------------------------------------------------------------- */

  const pendingUrls = [];
  let ready = false;

  function openExternalLink(url) {
    if (!/^https?:/i.test(url)) return;
    if (!ready) {
      pendingUrls.push(url);
      return;
    }
    // Air Traffic Control: rules send matching links straight to a Space
    const rule = (prefs.atcRules || []).find((r) => r.pattern && url.toLowerCase().includes(r.pattern.toLowerCase()));
    const routeWin = getMainWindow();
    if (rule && routeWin) {
      sendToMain('open-in-space', { url, spaceId: rule.spaceId });
      routeWin.show();
      routeWin.focus();
      return;
    }
    if (prefs.linkTarget === 'tab') {
      const win = getMainWindow();
      if (win) {
        sendToMain('open-in-new-tab', { url, background: false });
        win.show();
        win.focus();
        return;
      }
    }
    createMiniWindow(url);
  }

  // macOS delivers links via open-url (can fire before the app is ready)
  app.on('open-url', (event, url) => {
    event.preventDefault();
    openExternalLink(url);
  });

  // Windows / Linux deliver links as command-line arguments to a second instance.
  // The lock is per profile folder, so another profile runs as its own instance, while
  // opening a profile that's already running just brings that one to the front.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  }
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((a) => /^https?:\/\//i.test(a));
    if (url) openExternalLink(url);
    else if (app.isReady()) M.focusMain();
  });

  ipcMain.handle('default-browser-status', () => ({
    isDefault: app.isDefaultProtocolClient('https') && app.isDefaultProtocolClient('http'),
    packaged: app.isPackaged,
  }));

  ipcMain.handle('set-default-browser', () => {
    const ok = app.setAsDefaultProtocolClient('http') && app.setAsDefaultProtocolClient('https');
    return ok;
  });

  /* ---------------------------------------------------------------- */
  /* Search suggestions for the address bar                           */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('search-suggest', async (_event, query) => {
    try {
      const res = await net.fetch(`https://duckduckgo.com/ac/?type=list&q=${encodeURIComponent(query)}`);
      const data = await res.json();
      return Array.isArray(data) && Array.isArray(data[1]) ? data[1].slice(0, 5) : [];
    } catch {
      return [];
    }
  });

  /* ---------------------------------------------------------------- */
  /* Import bookmarks & history from other browsers (macOS paths)     */
  /* ---------------------------------------------------------------- */

  const support = path.join(os.homedir(), 'Library', 'Application Support');
  const CHROMIUM_BROWSERS = [
    { id: 'chrome', name: 'Chrome', dir: path.join(support, 'Google', 'Chrome') },
    { id: 'arc', name: 'Arc', dir: path.join(support, 'Arc', 'User Data') },
    { id: 'brave', name: 'Brave', dir: path.join(support, 'BraveSoftware', 'Brave-Browser') },
    { id: 'edge', name: 'Edge', dir: path.join(support, 'Microsoft Edge') },
    { id: 'chromium', name: 'Chromium', dir: path.join(support, 'Chromium') },
  ];
  const SAFARI_DIR = path.join(os.homedir(), 'Library', 'Safari');

  function chromiumProfile(dir) {
    if (fs.existsSync(path.join(dir, 'Default', 'History'))) return path.join(dir, 'Default');
    try {
      const profile = fs.readdirSync(dir).find((d) => /^Profile \d+$/.test(d) && fs.existsSync(path.join(dir, d, 'History')));
      return profile ? path.join(dir, profile) : null;
    } catch {
      return null;
    }
  }

  ipcMain.handle('import-detect', () => {
    const found = CHROMIUM_BROWSERS.filter((b) => chromiumProfile(b.dir)).map(({ id, name }) => ({ id, name }));
    if (process.platform === 'darwin' && fs.existsSync(SAFARI_DIR)) found.push({ id: 'safari', name: 'Safari' });
    return found;
  });

  async function sqliteJson(dbPath, sql) {
    // Browsers keep their databases locked; query a copy
    const tmp = path.join(os.tmpdir(), `browser-import-${Date.now()}.db`);
    await fs.promises.copyFile(dbPath, tmp);
    try {
      const { stdout } = await run('/usr/bin/sqlite3', ['-json', '-readonly', tmp, sql], { maxBuffer: 64 * 1024 * 1024 });
      return stdout.trim() ? JSON.parse(stdout) : [];
    } finally {
      fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  }

  // Chromium timestamps: microseconds since 1601-01-01
  const chromiumTime = (t) => Math.round(Number(t) / 1000 - 11644473600000);

  // Each bookmark keeps its folder path (e.g. ["Bookmarks bar", "Recipes"]) for Surf's bookmarks
  function flattenChromiumBookmarks(node, out, folder = []) {
    if (!node) return;
    if (node.type === 'url' && /^https?:/i.test(node.url)) {
      out.push({ title: node.name || node.url, url: node.url, folder, added: Number(node.date_added) ? chromiumTime(node.date_added) : null });
    }
    const inner = node.type === 'folder' && node.name ? [...folder, node.name] : folder;
    for (const child of node.children || []) flattenChromiumBookmarks(child, out, inner);
  }

  async function importChromium(browser) {
    const profile = chromiumProfile(browser.dir);
    const bookmarks = [];
    try {
      const data = JSON.parse(await fs.promises.readFile(path.join(profile, 'Bookmarks'), 'utf8'));
      for (const root of Object.values(data.roots || {})) flattenChromiumBookmarks(root, bookmarks);
    } catch { /* no bookmarks file */ }
    const rows = await sqliteJson(path.join(profile, 'History'),
      "SELECT url, title, last_visit_time AS t FROM urls WHERE url LIKE 'http%' AND hidden = 0 ORDER BY last_visit_time DESC LIMIT 3000");
    const history = rows.map((r) => ({ url: r.url, title: r.title || r.url, time: chromiumTime(r.t) }));
    return { bookmarks, history };
  }

  async function importSafari() {
    const bookmarks = [];
    try {
      const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(SAFARI_DIR, 'Bookmarks.plist')], { maxBuffer: 32 * 1024 * 1024 });
      const FOLDER_NAMES = { BookmarksBar: 'Favorites', BookmarksMenu: 'Bookmarks Menu' };
      const walk = (node, folder) => {
        if (!node) return;
        if (node.URLString && /^https?:/i.test(node.URLString)) {
          bookmarks.push({ title: (node.URIDictionary && node.URIDictionary.title) || node.URLString, url: node.URLString, folder });
        }
        const inner = node.WebBookmarkType === 'WebBookmarkTypeList' && node.Title ? [...folder, FOLDER_NAMES[node.Title] || node.Title] : folder;
        for (const child of node.Children || []) {
          if (child.Title === 'com.apple.ReadingList') continue;
          walk(child, inner);
        }
      };
      walk(JSON.parse(stdout), []);
    } catch (err) {
      if (/not permitted|EPERM|EACCES/i.test(String(err))) throw new Error('fda');
    }
    const rows = await sqliteJson(path.join(SAFARI_DIR, 'History.db'),
      'SELECT i.url AS url, v.title AS title, MAX(v.visit_time) AS t FROM history_visits v JOIN history_items i ON v.history_item = i.id GROUP BY i.url ORDER BY t DESC LIMIT 3000');
    // Safari timestamps: seconds since 2001-01-01
    const history = rows.map((r) => ({ url: r.url, title: r.title || r.url, time: Math.round((r.t + 978307200) * 1000) }));
    return { bookmarks, history };
  }

  ipcMain.handle('import-run', async (_event, id) => {
    try {
      if (id === 'safari') return await importSafari();
      const browser = CHROMIUM_BROWSERS.find((b) => b.id === id);
      if (!browser) return { error: 'Unknown browser' };
      return await importChromium(browser);
    } catch (err) {
      if (err.message === 'fda' || /not permitted|EPERM|EACCES/i.test(String(err))) {
        return { error: 'fda' };
      }
      return { error: String(err.message || err) };
    }
  });

  // bookmarks.html (the Netscape format every browser reads and writes): the window builds and
  // parses the HTML, the main process only shows the file dialogs and touches the disk
  ipcMain.handle('bookmarks-export', async (event, html) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win, {
      title: 'Export bookmarks',
      defaultPath: path.join(app.getPath('downloads'), 'bookmarks.html'),
      filters: [{ name: 'Bookmarks (HTML)', extensions: ['html', 'htm'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(result.filePath, String(html), 'utf8');
    return result.filePath;
  });

  ipcMain.handle('bookmarks-import-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Import bookmarks',
      properties: ['openFile'],
      filters: [{ name: 'Bookmarks (HTML)', extensions: ['html', 'htm'] }],
    });
    const file = !result.canceled && result.filePaths[0];
    if (!file) return null;
    const { size } = await fs.promises.stat(file);
    if (size > 50 * 1024 * 1024) return { error: 'That file is too large to be a bookmarks file.' };
    return { name: path.basename(file), html: await fs.promises.readFile(file, 'utf8') };
  });

  ipcMain.on('open-fda-settings', () => {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
  });

  /* ---------------------------------------------------------------- */
  /* Trackpad swipe: two-finger horizontal swipe = back / forward     */
  /* ---------------------------------------------------------------- */

  const SWIPE_IDLE_MS = 160;
  const SWIPE_THRESHOLD = 260;

  function watchSwipes(contents) {
    let acc = 0;
    let active = false;
    let vertical = 0;
    let timer = null;

    const finish = () => {
      if (active) sendToOwner(contents, 'swipe', { webContentsId: contents.id, amount: acc, done: true });
      acc = 0;
      vertical = 0;
      active = false;
    };

    contents.on('input-event', (_event, input) => {
      if (input.type !== 'mouseWheel' || !input.hasPreciseScrollingDeltas) return;
      if (!isBrowserWindow(ownerWindow(contents))) return;
      const dx = input.deltaX || 0;
      const dy = input.deltaY || 0;
      clearTimeout(timer);
      timer = setTimeout(finish, SWIPE_IDLE_MS);

      // Ignore gestures that start mostly vertical (normal scrolling)
      if (!active) {
        vertical += Math.abs(dy);
        if (vertical > 12 && Math.abs(acc) < 12) return;
        if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
      }
      acc += dx;
      if (!active && Math.abs(acc) > 30) active = true;
      if (active) sendToOwner(contents, 'swipe', { webContentsId: contents.id, amount: acc, threshold: SWIPE_THRESHOLD, done: false });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Chrome extensions + the Chrome Web Store                         */
  /* ---------------------------------------------------------------- */

  const extFile = () => path.join(app.getPath('userData'), 'extensions.json');
  // Store installs managed (and auto-updated) by electron-chrome-web-store, as <id>/<version>_0/.
  // Not "Extensions": that would clash with the older extensions/ folder on macOS.
  const storeDir = () => path.join(app.getPath('userData'), 'WebStoreExtensions');
  let installed = []; // older installs: [{ path, store, id }] (unpacked folders, and store installs from before)
  const justInstalled = new Set(); // ids approved in the store's install dialog, to announce once loaded

  // Lets chromewebstore.google.com's "Add to Chrome" work in every tab, like in Chrome
  function setupWebStore() {
    const ses = session.defaultSession;
    webStore.installChromeWebStore({
      session: ses,
      extensionsPath: storeDir(),
      beforeInstall: async ({ id, localizedName, manifest, icon, browserWindow }) => {
        const perms = describePermissions([
          ...(manifest.permissions || []),
          ...(manifest.host_permissions || []),
          ...(manifest.content_scripts || []).flatMap((cs) => cs.matches || []),
        ]);
        const { response } = await dialog.showMessageBox(browserWindow || getMainWindow(), {
          type: 'none',
          icon: icon && !icon.isEmpty() ? icon.resize({ width: 64, height: 64 }) : undefined,
          message: `Add “${localizedName}”?`,
          detail: perms.length ? `It can:\n• ${perms.join('\n• ')}` : 'It doesn’t ask for any special permissions.',
          buttons: ['Add extension', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        });
        if (response !== 0) return { action: 'deny' };
        justInstalled.add(id);
        return { action: 'allow' };
      },
    }).catch((err) => console.error('Chrome Web Store setup failed:', err));

    ses.extensions.on('extension-loaded', (_event, ext) => {
      const announce = justInstalled.delete(ext.id);
      sendToMain('extensions-changed', announce ? { installed: ext.name } : {});
    });
    ses.extensions.on('extension-unloaded', () => sendToMain('extensions-changed', {}));
  }

  // Plain-language summary of what an extension asks for (like Chrome's install prompt)
  function describePermissions(perms) {
    const out = new Set();
    for (const p of perms) {
      if (p === '<all_urls>' || /^\*:\/\/\*\/\*$|^https?:\/\/\*\/\*$/.test(p)) out.add('Read and change all your data on all websites');
      else if (/:\/\//.test(p)) out.add(`Read and change your data on ${p.replace(/^[^:]+:\/\/(\*\.)?/, '').replace(/\/.*$/, '')}`);
      else if (p === 'tabs' || p === 'history' || p === 'webNavigation') out.add('Read your browsing history');
      else if (p === 'bookmarks') out.add('Read and change your bookmarks');
      else if (p === 'downloads') out.add('Manage your downloads');
      else if (p === 'clipboardRead') out.add('Read data you copy and paste');
      else if (p === 'clipboardWrite') out.add('Change data you copy and paste');
      else if (p === 'notifications') out.add('Show notifications');
      else if (p === 'cookies') out.add('Read and change cookies');
      else if (p === 'management') out.add('Manage your apps and extensions');
      else if (p === 'nativeMessaging') out.add('Communicate with cooperating native applications');
      else if (p === 'declarativeNetRequest' || p === 'webRequest') out.add('Block or change network requests');
    }
    return [...out];
  }

  const isStoreManaged = (ext) => ext && ext.path && ext.path.startsWith(storeDir() + path.sep);

  function saveExtensions() {
    fs.promises.writeFile(extFile(), JSON.stringify(installed)).catch(() => {});
  }

  async function loadSavedExtensions() {
    try {
      installed = JSON.parse(fs.readFileSync(extFile(), 'utf8'));
    } catch {
      installed = [];
    }
    for (const ext of installed) {
      try {
        await session.defaultSession.extensions.loadExtension(ext.path, { allowFileAccess: true });
      } catch (err) {
        console.error('Extension failed to load:', ext.path, err.message);
      }
    }
  }

  function describe(ext) {
    const m = ext.manifest || {};
    const action = m.action || m.browser_action || {};
    const icons = action.default_icon && typeof action.default_icon === 'object' ? action.default_icon : m.icons || {};
    const iconRel = typeof action.default_icon === 'string' ? action.default_icon : icons[Object.keys(icons).sort((a, b) => Number(b) - Number(a))[0]];
    return {
      id: ext.id,
      name: ext.name,
      version: ext.version,
      popup: action.default_popup || null,
      icon: iconRel ? `chrome-extension://${ext.id}/${String(iconRel).replace(/^\//, '')}` : null,
      options: m.options_ui ? m.options_ui.page : m.options_page || null,
    };
  }

  ipcMain.handle('ext-list', () => session.defaultSession.extensions.getAllExtensions().map(describe));

  async function addExtension(dir, store) {
    const ext = await session.defaultSession.extensions.loadExtension(dir, { allowFileAccess: true });
    installed = installed.filter((e) => e.path !== dir);
    installed.push({ path: dir, store, id: ext.id });
    saveExtensions();
    return describe(ext);
  }

  ipcMain.handle('ext-load-unpacked', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Choose an unpacked extension folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    try {
      return { ext: await addExtension(result.filePaths[0], false) };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Install by Chrome Web Store link or ID (same install path as the store's own button, so it auto-updates)
  ipcMain.handle('ext-install-store', async (_event, input) => {
    const match = String(input).match(/[a-p]{32}/);
    if (!match) return { error: 'Paste a Chrome Web Store link or a 32-letter extension ID.' };
    try {
      const ext = await webStore.installExtension(match[0], { session: session.defaultSession, extensionsPath: storeDir() });
      return { ext: describe(ext) };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('ext-remove', async (_event, id) => {
    const ses = session.defaultSession;
    if (isStoreManaged(ses.extensions.getExtension(id))) {
      await webStore.uninstallExtension(id, { session: ses, extensionsPath: storeDir() }).catch((err) => console.error(err));
      return true;
    }
    try {
      ses.extensions.removeExtension(id);
    } catch { /* already unloaded */ }
    const entry = installed.find((e) => e.id === id);
    installed = installed.filter((e) => e.id !== id);
    saveExtensions();
    if (entry && entry.store) await fs.promises.rm(entry.path, { recursive: true, force: true }).catch(() => {});
    return true;
  });

  // Extension popups get their own small window
  ipcMain.on('ext-open-page', (_event, { id, page, x, y }) => {
    const win = new BrowserWindow({
      width: 380,
      height: 560,
      x: x != null ? Math.round(x) : undefined,
      y: y != null ? Math.round(y) : undefined,
      parent: getMainWindow() || undefined,
      title: 'Extension',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    win.loadURL(`chrome-extension://${id}/${String(page).replace(/^\//, '')}`);
    win.on('blur', () => {
      if (!win.isDestroyed() && !win.webContents.isDevToolsOpened()) win.close();
    });
  });

  /* ---------------------------------------------------------------- */
  /* Downloads: rename (used by AI auto-naming)                       */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('rename-file', async (_event, { from, name }) => {
    const safe = String(name).replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '').slice(0, 150).trim();
    if (!safe) return { error: 'bad name' };
    const dir = path.dirname(from);
    const ext = path.extname(safe);
    const base = path.basename(safe, ext);
    let target = path.join(dir, safe);
    for (let n = 1; fs.existsSync(target); n++) target = path.join(dir, `${base} (${n})${ext}`);
    try {
      await fs.promises.rename(from, target);
      return { path: target, filename: path.basename(target) };
    } catch (err) {
      return { error: err.message };
    }
  });

  /* ---------------------------------------------------------------- */
  /* Hooks for main.js                                                */
  /* ---------------------------------------------------------------- */

  return {
    onReady() {
      ready = true;
      setupWebStore();
      loadSavedExtensions();
      // A link that launched the app opens on its own (like Arc's Little window)
      const launchUrl = process.argv.find((a) => /^https?:\/\//i.test(a));
      if (launchUrl) pendingUrls.push(launchUrl);
      return pendingUrls.length > 0;
    },
    flushPendingUrls() {
      while (pendingUrls.length) openExternalLink(pendingUrls.shift());
    },
    watchSwipes,
    prefs: () => prefs,
    setPref,
  };
};
