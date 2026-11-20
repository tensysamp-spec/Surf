// Clear browsing data: cookies, site storage and the HTTP cache for every session a
// window's pages use. A normal window clears the default session (tabs and web panels),
// every isolated space ("persist:space-<id>") and any other saved partition; a private
// window clears only its own in-memory partition. History, archive and downloads live
// in the window's storage and are cleared there (src/cleardata.js).

const { app, ipcMain, session, webContents } = require('electron');
const path = require('path');
const fs = require('fs');

// Everything a site can store, except the HTTP cache (a separate option)
const SITE_DATA = ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'fileSystems', 'webSQL', 'backgroundFetch'];

module.exports = function setupClearData(M) {
  // Saved partitions are folders under <profile>/Partitions (persist:space-abc → space-abc)
  function savedPartitions() {
    try {
      return fs.readdirSync(path.join(app.getPath('userData'), 'Partitions'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => `persist:${d.name}`);
    } catch {
      return [];
    }
  }

  function targetSessions(sender) {
    const win = M.ownerWindow(sender);
    if (M.isPrivateWindow(win)) return [M.sessionFor(sender)];
    const set = new Set([session.defaultSession]);
    for (const name of savedPartitions()) set.add(session.fromPartition(name));
    // Spaces made isolated this run may not have written their folder yet
    for (const contents of webContents.getAllWebContents()) {
      if (contents.session.isPersistent()) set.add(contents.session);
    }
    return [...set];
  }

  // Surf's own window (file://) keeps tabs, settings and history in the default session's
  // localStorage, and extensions keep theirs there too: never touch those
  function protectedOrigins(ses) {
    if (ses !== session.defaultSession) return [];
    const extensions = ses.extensions ? ses.extensions.getAllExtensions() : [];
    return ['file://', ...extensions.map((ext) => `chrome-extension://${ext.id}`)];
  }

  ipcMain.handle('clear-browsing-data', async (event, { siteData, cache } = {}) => {
    const sessions = targetSessions(event.sender);
    for (const ses of sessions) {
      if (siteData) {
        const excludeOrigins = protectedOrigins(ses);
        await ses.clearData({ dataTypes: SITE_DATA, ...(excludeOrigins.length ? { excludeOrigins } : {}) });
      }
      if (cache) {
        await ses.clearCache();
        await ses.clearData({ dataTypes: ['cache'] });
      }
    }
    return { sessions: sessions.length };
  });
};
