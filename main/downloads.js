// Downloads: where files are saved (folder / ask each time), pause, resume, cancel,
// "open when done", retry of failed downloads, and progress reports (with speed) to
// the browser window that started each download. Every Surf session gets the
// will-download handler through main/sessions.js.

const { app, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

// Files that are safe to open on their own when "Open safe files" is on
const SAFE_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.heic', '.svg', '.txt']);

module.exports = function setupDownloads(M) {
  const prefsFile = () => path.join(app.getPath('userData'), 'download-prefs.json');
  let prefs = { folder: '', ask: false, openSafe: false };
  try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) }; } catch { /* defaults */ }

  const downloads = new Map(); // id -> { item, openWhenDone }
  const retries = new Map(); // url -> { id, win } for downloads restarted with "Retry"
  let nextDownloadId = 1;

  // The chosen folder, or ~/Downloads when it's unset or gone
  function folder() {
    if (prefs.folder && fs.existsSync(prefs.folder)) return prefs.folder;
    return app.getPath('downloads');
  }

  function uniqueSavePath(filename) {
    const dir = folder();
    const ext = path.extname(filename);
    const base = path.basename(filename, ext) || 'download';
    let candidate = path.join(dir, filename || 'download');
    for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})${ext}`);
    return candidate;
  }

  // Isolated spaces use "persist:<name>" partitions, stored under Partitions/<name>;
  // remembered so "Retry" after a relaunch downloads with the same cookies
  function partitionOf(ses) {
    if (!ses.isPersistent() || ses === session.defaultSession) return null;
    const parts = (ses.storagePath || '').split(path.sep);
    const i = parts.lastIndexOf('Partitions');
    return i >= 0 && parts[i + 1] ? `persist:${parts[i + 1]}` : null;
  }

  function setup(ses) {
    ses.on('will-download', (_event, item, contents) => {
      const url = (item.getURLChain() || [])[0] || item.getURL();
      const retry = retries.get(url);
      retries.delete(url);
      const id = retry ? retry.id : `${Date.now()}-${nextDownloadId++}`;
      // Report to the window that started it; a private download never falls back to
      // the main window (whose list is saved)
      const startedIn = contents && !contents.isDestroyed() ? M.ownerWindow(contents) : null;
      const win = retry ? retry.win : startedIn;
      const sendTo = (payload) => {
        if (win && !win.isDestroyed()) win.webContents.send('download-update', payload);
        else if (ses.isPersistent()) M.sendToMain('download-update', payload);
      };

      if (prefs.ask) item.setSaveDialogOptions({ defaultPath: path.join(folder(), item.getFilename()) });
      // A retry writes over its own unfinished file instead of making "name (1)"
      else item.setSavePath(retry && retry.savePath ? retry.savePath : uniqueSavePath(item.getFilename()));
      const entry = { item, openWhenDone: prefs.openSafe && SAFE_EXT.has(path.extname(item.getFilename()).toLowerCase()) };
      downloads.set(id, entry);

      const report = (state) => {
        // While the save dialog is up there's no path yet: nothing to show
        if (!item.getSavePath()) return;
        sendTo({
          id,
          filename: path.basename(item.getSavePath()),
          url,
          partition: partitionOf(ses),
          savePath: item.getSavePath(),
          total: item.getTotalBytes(),
          received: item.getReceivedBytes(),
          speed: state === 'progressing' && !item.isPaused() ? item.getCurrentBytesPerSecond() : 0,
          paused: item.isPaused(),
          canResume: state === 'progressing' || state === 'interrupted' ? item.canResume() : false,
          openWhenDone: entry.openWhenDone,
          state,
          startTime: item.getStartTime() * 1000,
        });
      };
      report('progressing');
      item.on('updated', (_e, state) => report(state === 'interrupted' ? 'interrupted' : 'progressing'));
      item.once('done', (_e, state) => {
        downloads.delete(id);
        report(state);
      });
    });
  }

  ipcMain.on('download-action', (event, { id, action, savePath, url, partition, value, reuse }) => {
    const entry = downloads.get(id);
    const item = entry && entry.item;
    switch (action) {
      case 'cancel': if (item) item.cancel(); break;
      case 'pause': if (item) item.pause(); break;
      case 'resume': if (item && item.canResume()) item.resume(); break;
      case 'open': if (savePath) shell.openPath(savePath); break;
      case 'show': if (savePath) shell.showItemInFolder(savePath); break;
      case 'open-when-done': if (entry) entry.openWhenDone = !!value; break;
      case 'retry': {
        if (typeof url !== 'string' || !/^(https?|ftp|data|blob):/i.test(url)) break;
        if (item) item.cancel();
        // Same session as before: the space's partition, or this window's own (private) one
        const ses = typeof partition === 'string' && partition.startsWith('persist:') ? session.fromPartition(partition) : M.sessionFor(event.sender);
        // reuse: the renderer knows the file is this download's own unfinished one
        const own = reuse && typeof savePath === 'string' && path.isAbsolute(savePath) && fs.existsSync(path.dirname(savePath)) ? savePath : null;
        retries.set(url, { id, win: M.windowOf(event.sender), savePath: own });
        // The unfinished file from last time goes first (Chromium would otherwise write
        // next to it as "name (1)")
        if (own) fs.promises.rm(own, { force: true }).catch(() => {}).then(() => ses.downloadURL(url));
        else ses.downloadURL(url);
        break;
      }
    }
  });

  ipcMain.handle('download-prefs-get', () => ({ ...prefs, folder: folder(), defaultFolder: app.getPath('downloads') }));
  ipcMain.handle('download-prefs-set', (_event, changes) => {
    for (const key of ['folder', 'ask', 'openSafe']) if (changes && key in changes) prefs[key] = changes[key];
    fs.promises.writeFile(prefsFile(), JSON.stringify(prefs)).catch(() => {});
    return { ...prefs, folder: folder() };
  });
  ipcMain.handle('download-choose-folder', async (event) => {
    const result = await dialog.showOpenDialog(M.windowOf(event.sender) || M.getMainWindow(), {
      title: 'Download folder',
      defaultPath: folder(),
      buttonLabel: 'Choose',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    prefs.folder = result.filePaths[0];
    fs.promises.writeFile(prefsFile(), JSON.stringify(prefs)).catch(() => {});
    return prefs.folder;
  });

  return { setup };
};
