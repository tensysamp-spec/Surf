// Screenshots, password manager (encrypted with the macOS Keychain via safeStorage),
// and mouse gestures (right-drag on a page).

const { app, ipcMain, webContents, clipboard, ClipboardItem, nativeImage, safeStorage, systemPreferences, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const csv = require('./csv');

module.exports = function setupTools(M) {
  /* ---------------------------------------------------------------- */
  /* Shelf: drag a file off the shelf into Finder or another app      */
  /* ---------------------------------------------------------------- */

  ipcMain.on('shelf-drag-file', async (event, file) => {
    if (typeof file !== 'string' || !fs.existsSync(file)) return;
    const icon = await app.getFileIcon(file, { size: 'normal' }).catch(() => null);
    event.sender.startDrag({ file, icon: icon && !icon.isEmpty() ? icon : nativeImage.createFromNamedImage('NSImageNameMultipleDocuments') });
  });

  /* ---------------------------------------------------------------- */
  /* Site icons as data URLs, so the window can read their colors      */
  /* (a cross-origin <img> would taint the canvas)                    */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('fetch-icon', async (event, url, partition) => {
    if (typeof url !== 'string' || !/^https?:/i.test(url)) return null;
    try {
      // The asking tab's session: private windows and isolated Spaces don't send the default cookies
      const res = await M.sessionForPartition(event.sender, partition).fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return null;
      const type = (res.headers.get('content-type') || 'image/png').split(';')[0];
      if (!type.startsWith('image/')) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 512 * 1024) return null;
      return `data:${type};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  });

  ipcMain.handle('shelf-file-exists', (_event, file) => typeof file === 'string' && fs.existsSync(file));

  /* ---------------------------------------------------------------- */
  /* Screenshots                                                      */
  /* ---------------------------------------------------------------- */

  async function saveImage(image, label) {
    const stamp = new Date().toISOString().replace(/[:T]/g, '.').slice(0, 19);
    const name = `Screenshot ${label ? `${label} ` : ''}${stamp}.png`.replace(/[/\\:*?"<>|]/g, '-');
    const file = path.join(app.getPath('downloads'), name);
    const png = image.toPNG();
    await fs.promises.writeFile(file, png);
    // Electron 45's clipboard takes W3C-style ClipboardItems
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]).catch(() => {});
    return file;
  }

  // mode: 'visible' | 'full'
  ipcMain.handle('screenshot', async (_event, { webContentsId, mode, label }) => {
    const contents = webContents.fromId(webContentsId);
    if (!contents) return { error: 'Tab not found' };
    try {
      let image;
      if (mode === 'full') {
        // DevTools protocol can capture beyond the viewport
        const dbg = contents.debugger;
        const attachedHere = !dbg.isAttached();
        if (attachedHere) dbg.attach('1.3');
        try {
          const metrics = await dbg.sendCommand('Page.getLayoutMetrics');
          const size = metrics.cssContentSize || metrics.contentSize;
          const width = Math.ceil(size.width);
          const height = Math.min(Math.ceil(size.height), 16000);
          const shot = await dbg.sendCommand('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width, height, scale: 1 },
          });
          image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
        } finally {
          if (attachedHere) dbg.detach();
        }
      } else {
        image = await contents.capturePage();
      }
      return { path: await saveImage(image, label) };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Area screenshots are captured in the renderer, saved here
  ipcMain.handle('save-image', async (_event, { png, label }) => {
    try {
      return { path: await saveImage(nativeImage.createFromBuffer(Buffer.from(png)), label) };
    } catch (err) {
      return { error: err.message };
    }
  });

  /* ---------------------------------------------------------------- */
  /* Passwords                                                        */
  /* ---------------------------------------------------------------- */

  const vaultFile = () => path.join(app.getPath('userData'), 'passwords.bin');
  let vault = null; // { logins: [{ id, origin, username, password, created, used }], never: [origin] }

  function loadVault() {
    if (vault) return vault;
    try {
      const data = fs.readFileSync(vaultFile());
      vault = JSON.parse(safeStorage.decryptString(data));
    } catch {
      vault = { logins: [], never: [] };
    }
    return vault;
  }

  function saveVault() {
    if (!safeStorage.isEncryptionAvailable()) return false;
    fs.writeFileSync(vaultFile(), safeStorage.encryptString(JSON.stringify(vault)), { mode: 0o600 });
    return true;
  }

  ipcMain.handle('pw-available', () => safeStorage.isEncryptionAvailable());

  // Accounts saved for one origin (to offer autofill) — usernames only; passwords never
  // leave the main process except into the page itself via pw-fill
  ipcMain.handle('pw-for-origin', (event, origin) => {
    if (!M.isBrowserWindow(M.windowOf(event.sender))) return [];
    return loadVault().logins.filter((l) => l.origin === origin).map(({ id, username }) => ({ id, username }));
  });

  // Fill a login into a tab, after the user picked it in Surf's own UI. The code runs in an
  // isolated world, so page scripts can't intercept it or see the credentials before they're
  // in the fields, and only in the top frame of the exact origin the login was saved for.
  const PW_WORLD = 4242;
  const FILL_SCRIPT = (origin, username, password) => `(() => {
    if (window !== window.top || location.origin !== ${JSON.stringify(origin)}) return false;
    const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const findUser = (pw) => {
      const scope = pw.form || document;
      const inputs = [...scope.querySelectorAll('input')].filter((i) => ['text', 'email', 'tel', ''].includes(i.type) && visible(i));
      const before = inputs.filter((i) => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
      return before[before.length - 1] || inputs[0] || null;
    };
    // This world's own (untouched) setter, so frameworks like React notice the change
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const set = (el, v) => {
      if (!el || v == null) return;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const pw = [...document.querySelectorAll('input[type=password]')].find(visible) || document.querySelector('input[type=password]');
    // (a username-first sign-in page has no password field yet)
    const user = pw ? findUser(pw) : document.querySelector('input[type=email], input[autocomplete=username]');
    if (!pw && !user) return false;
    set(user, ${JSON.stringify(username)});
    set(pw, ${JSON.stringify(password)});
    return true;
  })()`;

  ipcMain.handle('pw-fill', async (event, { webContentsId, id }) => {
    if (!M.isBrowserWindow(M.windowOf(event.sender))) return false;
    // Only a tab (<webview>) inside the window that asked
    const contents = webContents.fromId(webContentsId);
    if (!contents || contents.isDestroyed() || contents.getType() !== 'webview' || !contents.hostWebContents || contents.hostWebContents.id !== event.sender.id) return false;
    const login = loadVault().logins.find((l) => l.id === id);
    if (!login) return false;
    let origin = null;
    try {
      origin = new URL(contents.getURL()).origin;
    } catch { /* no page */ }
    if (origin !== login.origin) return false;
    try {
      return !!(await contents.executeJavaScriptInIsolatedWorld(PW_WORLD, [{ code: FILL_SCRIPT(login.origin, login.username, login.password) }]));
    } catch {
      return false;
    }
  });

  ipcMain.handle('pw-should-offer', (_event, { origin, username, password }) => {
    const v = loadVault();
    if (v.never.includes(origin)) return 'never';
    const existing = v.logins.find((l) => l.origin === origin && l.username === username);
    if (existing && existing.password === password) return 'saved';
    return existing ? 'update' : 'new';
  });

  ipcMain.handle('pw-save', (_event, { origin, username, password }) => {
    const v = loadVault();
    const existing = v.logins.find((l) => l.origin === origin && l.username === username);
    if (existing) Object.assign(existing, { password, used: Date.now() });
    else v.logins.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, origin, username, password, created: Date.now(), used: Date.now() });
    return saveVault();
  });

  ipcMain.handle('pw-never', (_event, origin) => {
    const v = loadVault();
    if (!v.never.includes(origin)) v.never.push(origin);
    return saveVault();
  });

  ipcMain.handle('pw-list', () => loadVault().logins.map(({ id, origin, username, created, used }) => ({ id, origin, username, created, used })));

  ipcMain.handle('pw-delete', (_event, id) => {
    const v = loadVault();
    v.logins = v.logins.filter((l) => l.id !== id);
    return saveVault();
  });

  // Revealing / copying a password asks for Touch ID when available
  ipcMain.handle('pw-reveal', async (_event, id) => {
    const login = loadVault().logins.find((l) => l.id === id);
    if (!login) return { error: 'Not found' };
    if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
      try {
        await systemPreferences.promptTouchID(`show the password for ${login.username}`);
      } catch {
        return { error: 'cancelled' };
      }
    }
    return { password: login.password };
  });

  /* ---------------------------------------------------------------- */
  /* Password import / export (CSV from Chrome, Safari or Firefox)    */
  /* ---------------------------------------------------------------- */

  // Only the main window's profile has a vault; private windows can't import or export
  const vaultWindow = (event) => {
    const win = M.windowOf(event.sender);
    return M.isBrowserWindow(win) && !M.isPrivateWindow(win) ? win : null;
  };

  // http(s) logins are kept by origin (scheme + host + port), like the ones saved in Surf
  const loginOrigin = (url) => {
    try {
      const u = new URL(String(url).trim());
      return /^https?:$/.test(u.protocol) && u.hostname ? u.origin : null;
    } catch {
      return null;
    }
  };

  // All three browsers name these columns url/username/password (any case); the extra
  // columns (name, notes, OTPAuth, httpRealm, guid, times…) aren't needed
  function importRecords(records) {
    const v = loadVault();
    let added = 0, updated = 0, skipped = 0;
    for (const r of records) {
      const origin = loginOrigin(r.url || r.origin || r.website || '');
      const username = r.username || r.login || '';
      const password = r.password || '';
      if (!origin || !password) {
        skipped++;
        continue;
      }
      const existing = v.logins.find((l) => l.origin === origin && l.username === username);
      if (existing) {
        if (existing.password !== password) {
          existing.password = password;
          updated++;
        }
      } else {
        v.logins.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, origin, username, password, created: Date.now(), used: 0 });
        added++;
      }
    }
    return { added, updated, skipped };
  }

  ipcMain.handle('pw-import', async (event) => {
    const win = vaultWindow(event);
    if (!win) return { error: 'Not available in private windows' };
    if (!safeStorage.isEncryptionAvailable()) return { error: 'Secure storage isn’t available' };
    const pick = await dialog.showOpenDialog(win, {
      title: 'Import passwords',
      message: 'Choose a passwords CSV exported from Chrome, Safari or Firefox',
      buttonLabel: 'Import',
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (pick.canceled || !pick.filePaths[0]) return { cancelled: true };
    let records;
    try {
      const stat = await fs.promises.stat(pick.filePaths[0]);
      if (stat.size > 20 * 1024 * 1024) return { error: 'That file is too large' };
      records = csv.parseRecords(await fs.promises.readFile(pick.filePaths[0], 'utf8'));
    } catch (err) {
      return { error: err.message };
    }
    if (!records.length || !('password' in records[0]) || !('url' in records[0] || 'origin' in records[0] || 'website' in records[0])) {
      return { error: 'That doesn’t look like a passwords CSV (needs url, username and password columns)' };
    }
    const result = importRecords(records);
    if ((result.added || result.updated) && !saveVault()) return { error: 'Couldn’t save: secure storage isn’t available' };
    return result;
  });

  // Exports Chrome's format (name,url,username,password,note), which Safari and Firefox import too
  ipcMain.handle('pw-export', async (event) => {
    const win = vaultWindow(event);
    if (!win) return { error: 'Not available in private windows' };
    const logins = loadVault().logins;
    if (!logins.length) return { error: 'No saved passwords to export' };
    const confirm = await dialog.showMessageBox(win, {
      type: 'warning',
      message: `Export ${logins.length} password${logins.length === 1 ? '' : 's'}?`,
      detail: 'The file will NOT be encrypted. Anyone who can open it can read your passwords. Delete it once you’ve imported it elsewhere.',
      buttons: ['Export…', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (confirm.response !== 0) return { cancelled: true };
    if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
      try {
        await systemPreferences.promptTouchID('export your saved passwords');
      } catch {
        return { cancelled: true };
      }
    }
    const save = await dialog.showSaveDialog(win, {
      title: 'Export passwords',
      defaultPath: path.join(app.getPath('documents'), 'Surf Passwords.csv'),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (save.canceled || !save.filePath) return { cancelled: true };
    const rows = [['name', 'url', 'username', 'password', 'note']];
    for (const l of [...logins].sort((a, b) => a.origin.localeCompare(b.origin))) {
      rows.push([new URL(l.origin).host, l.origin, l.username, l.password, '']);
    }
    try {
      await fs.promises.writeFile(save.filePath, csv.stringify(rows), { mode: 0o600 });
    } catch (err) {
      return { error: err.message };
    }
    return { count: logins.length, path: save.filePath };
  });

  /* ---------------------------------------------------------------- */
  /* Mouse gestures: hold the right button and drag                   */
  /* ---------------------------------------------------------------- */

  const GESTURES = { L: 'back', R: 'forward', D: 'new-tab', DR: 'close-tab', UD: 'reload', U: 'scroll-top', DL: 'reopen-closed' };
  const STEP = 34;
  const state = new Map(); // contentsId -> { down, anchor, dirs, moved, pendingMenu, finishedAt }

  function watchGestures(contents) {
    const s = { down: false, anchor: null, dirs: '', moved: false, pendingMenu: null, finishedAt: 0 };
    state.set(contents.id, s);
    contents.once('destroyed', () => state.delete(contents.id));

    contents.on('input-event', (_event, input) => {
      if (!M.gesturesEnabled()) return;
      if (input.type === 'mouseDown' && input.button === 'right') {
        Object.assign(s, { down: true, anchor: { x: input.x, y: input.y }, dirs: '', moved: false });
      } else if (input.type === 'mouseMove' && s.down) {
        const dx = input.x - s.anchor.x;
        const dy = input.y - s.anchor.y;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < STEP) return;
        const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U');
        if (!s.dirs.endsWith(dir)) s.dirs += dir;
        s.anchor = { x: input.x, y: input.y };
        s.moved = true;
      } else if (input.type === 'mouseUp' && input.button === 'right' && s.down) {
        s.down = false;
        if (s.moved && s.dirs) {
          s.finishedAt = Date.now();
          s.pendingMenu = null;
          const action = GESTURES[s.dirs];
          M.sendToOwner(contents, 'gesture', { action: action || null, dirs: s.dirs, webContentsId: contents.id });
        } else if (s.pendingMenu) {
          const menu = s.pendingMenu;
          s.pendingMenu = null;
          menu();
        }
      }
    });
  }

  // Context menus wait for the right button to be released, so a drag can be a gesture instead
  function showContextMenu(contents, popup) {
    const s = state.get(contents.id);
    if (!M.gesturesEnabled() || !s) return popup();
    if (Date.now() - s.finishedAt < 400) return; // a gesture just happened
    if (s.down) {
      s.pendingMenu = popup;
      setTimeout(() => {
        if (s.pendingMenu === popup && !s.moved) {
          s.pendingMenu = null;
          popup();
        }
      }, 1200);
      return;
    }
    popup();
  }

  return { watchGestures, showContextMenu };
};
