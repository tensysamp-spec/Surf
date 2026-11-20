// Crash recovery: notice when the last run didn't quit cleanly, keep the window's saved
// state flushed to disk, and bring crashed browser windows back.
//
// A "running" marker sits in the profile folder while Surf is open and is removed on a clean
// quit, so finding it at launch means the previous run crashed or was force-quit. Crashes we
// see happen (a window's renderer, the GPU process) are written into it, so the next launch
// knows whether there is something worth reporting.

const { app, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

module.exports = function setupRecovery(M) {
  const markerFile = () => path.join(app.getPath('userData'), 'running.json');
  let previous = null; // the marker left by an unclean exit, read once at launch
  let reported = false; // only the first window that asks hears about it
  let marker = null;

  function writeMarker() {
    try {
      fs.writeFileSync(markerFile(), JSON.stringify(marker));
    } catch { /* not fatal */ }
  }

  function start() {
    try {
      previous = JSON.parse(fs.readFileSync(markerFile(), 'utf8'));
    } catch (err) {
      // Unreadable but present still means an unclean exit
      previous = err.code === 'ENOENT' ? null : {};
    }
    marker = { pid: process.pid, started: Date.now(), version: app.getVersion(), crashes: [] };
    writeMarker();
  }

  function noteCrash(what, details) {
    if (!marker || !details || details.reason === 'clean-exit') return;
    marker.crashes = [...marker.crashes, { what, reason: details.reason, exitCode: details.exitCode, at: Date.now() }].slice(-5);
    writeMarker();
  }

  // localStorage reaches the disk lazily (seconds later); write it now
  function flush() {
    try {
      session.defaultSession.flushStorageData();
    } catch { /* not fatal */ }
  }

  // A browser window's own renderer crashed: reload it once. A second crash soon after is
  // left alone instead of looping.
  function watchWindow(win) {
    let lastReload = 0;
    win.webContents.on('render-process-gone', (_e, details) => {
      noteCrash('window', details);
      if (details.reason === 'clean-exit' || win.isDestroyed()) return;
      if (Date.now() - lastReload < 60 * 1000) return;
      lastReload = Date.now();
      win.webContents.reload();
    });
    // Closing the main window keeps the app running on macOS; get its last saves onto disk
    win.on('closed', flush);
  }

  app.on('child-process-gone', (_e, details) => {
    if (details.type === 'GPU' || details.type === 'Utility') noteCrash(details.type, details);
  });

  ipcMain.on('flush-storage', flush);

  // Asked by the main window at boot: did the last run end badly?
  ipcMain.handle('recovery-status', (event) => {
    if (!previous || reported || M.isPrivateWindow(M.ownerWindow(event.sender))) return null;
    reported = true;
    return {
      crashes: previous.crashes || [],
      version: previous.version || app.getVersion(),
      electron: process.versions.electron,
      os: `${process.platform} ${process.getSystemVersion ? process.getSystemVersion() : ''}`.trim(),
    };
  });

  app.on('before-quit', flush);
  app.on('will-quit', () => {
    flush();
    try {
      fs.unlinkSync(markerFile());
    } catch { /* already gone */ }
  });

  return { start, watchWindow, flush };
};
