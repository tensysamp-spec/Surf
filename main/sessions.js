// Per-session setup: ad/tracker blocking (with privacy stats + per-site shields),
// downloads, and permission prompts. Applied to the default session, every Space
// profile, and private windows.

const { app, ipcMain, session, webContents, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const BLOCKED_DOMAINS = new Set([
  // Google ads & analytics
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'adservice.google.com', 'googletagmanager.com', 'googletagservices.com', '2mdn.net',
  // Ad exchanges / networks
  'adnxs.com', 'adsrvr.org', 'amazon-adsystem.com', 'criteo.com', 'criteo.net', 'taboola.com',
  'outbrain.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com',
  'advertising.com', 'adform.net', 'serving-sys.com', 'smartadserver.com', 'bidswitch.net',
  '3lift.com', 'sharethrough.com', 'teads.tv', 'yieldmo.com', 'media.net', 'zedo.com',
  'moatads.com', 'adsafeprotected.com', 'doubleverify.com',
  // Trackers / analytics
  'scorecardresearch.com', 'quantserve.com', 'hotjar.com', 'mixpanel.com', 'fullstory.com',
  'crazyegg.com', 'mouseflow.com', 'connect.facebook.net', 'analytics.twitter.com',
  'ads-twitter.com', 'ads.linkedin.com', 'bat.bing.com', 'analytics.tiktok.com', 'ads.yahoo.com',
]);

module.exports = function setupSessions(M) {
  /* ---------------------------------------------------------------- */
  /* Shields: blocking, per-site exceptions, privacy report           */
  /* ---------------------------------------------------------------- */

  let shieldsEnabled = true;
  let blockedTotal = 0;
  const blockedPerContents = new Map(); // webContentsId -> count

  const shieldsFile = () => path.join(app.getPath('userData'), 'shields.json');
  const statsFile = () => path.join(app.getPath('userData'), 'privacy.json');
  let disabledHosts = new Set();
  let stats = { since: Date.now(), total: 0, sites: {}, trackers: {} };
  try { disabledHosts = new Set(JSON.parse(fs.readFileSync(shieldsFile(), 'utf8'))); } catch { /* none */ }
  try { stats = { ...stats, ...JSON.parse(fs.readFileSync(statsFile(), 'utf8')) }; } catch { /* none */ }

  let statsTimer = null;
  const saveStats = () => {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(() => fs.promises.writeFile(statsFile(), JSON.stringify(stats)).catch(() => {}), 4000);
  };

  // Cookie banners, HTTPS-only, fingerprinting, Global Privacy Control (main/privacy.js)
  const privacy = require('./privacy')(M, {
    countBanner: () => {
      stats.banners = (stats.banners || 0) + 1;
      saveStats();
    },
  });

  // Returns the blocked domain from the list, or null
  function blockedDomain(hostname) {
    let host = hostname.toLowerCase();
    while (host.includes('.')) {
      if (BLOCKED_DOMAINS.has(host)) return host;
      host = host.slice(host.indexOf('.') + 1);
    }
    return null;
  }

  const siteHost = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  };

  function sendBlockedUpdate(contentsId) {
    const contents = webContents.fromId(contentsId);
    if (!contents) return;
    M.sendToOwner(contents, 'blocked-update', {
      webContentsId: contentsId,
      count: blockedPerContents.get(contentsId) || 0,
      total: blockedTotal,
    });
  }

  function setupBlocker(ses) {
    // Private windows still block, but leave no trace in the saved privacy report
    const record = ses.isPersistent();
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      const upgrade = privacy.httpsUpgrade(details, ses);
      if (upgrade) return callback(upgrade);
      if (!shieldsEnabled) return callback({});
      let hostname;
      try {
        hostname = new URL(details.url).hostname;
      } catch {
        return callback({});
      }
      const domain = blockedDomain(hostname);
      if (!domain) return callback({});

      const contents = details.webContents;
      const site = contents && !contents.isDestroyed() ? siteHost(contents.getURL()) : null;
      if (site && disabledHosts.has(site)) return callback({});

      blockedTotal++;
      if (record) {
        stats.total++;
        stats.trackers[domain] = (stats.trackers[domain] || 0) + 1;
        if (site) stats.sites[site] = (stats.sites[site] || 0) + 1;
        saveStats();
      }

      const id = details.webContentsId;
      if (id != null) {
        blockedPerContents.set(id, (blockedPerContents.get(id) || 0) + 1);
        sendBlockedUpdate(id);
      }
      callback({ cancel: true });
    });
  }

  ipcMain.on('set-shields', (_event, enabled) => {
    shieldsEnabled = !!enabled;
  });
  ipcMain.handle('get-blocked', (_event, id) => ({ count: blockedPerContents.get(id) || 0, total: blockedTotal }));
  ipcMain.handle('shields-site-get', (_event, host) => !disabledHosts.has(String(host).replace(/^www\./, '')));
  ipcMain.handle('shields-site-set', (_event, { host, enabled }) => {
    const h = String(host).replace(/^www\./, '');
    if (enabled) disabledHosts.delete(h);
    else disabledHosts.add(h);
    fs.promises.writeFile(shieldsFile(), JSON.stringify([...disabledHosts])).catch(() => {});
    return true;
  });
  ipcMain.handle('privacy-report', () => stats);
  ipcMain.handle('privacy-reset', () => {
    stats = { since: Date.now(), total: 0, sites: {}, trackers: {} };
    saveStats();
    return stats;
  });

  /* ---------------------------------------------------------------- */
  /* Downloads                                                        */
  /* ---------------------------------------------------------------- */

  const downloads = new Map();
  let nextDownloadId = 1;

  function uniqueSavePath(filename) {
    const dir = app.getPath('downloads');
    const ext = path.extname(filename);
    const base = path.basename(filename, ext) || 'download';
    let candidate = path.join(dir, filename || 'download');
    for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})${ext}`);
    return candidate;
  }

  function setupDownloads(ses) {
    ses.on('will-download', (_event, item, contents) => {
      const id = `${Date.now()}-${nextDownloadId++}`;
      item.setSavePath(uniqueSavePath(item.getFilename()));
      downloads.set(id, item);
      const target = contents && !contents.isDestroyed() ? contents : null;
      const report = (state) => {
        const payload = {
          id,
          filename: path.basename(item.getSavePath()),
          url: item.getURL(),
          savePath: item.getSavePath(),
          total: item.getTotalBytes(),
          received: item.getReceivedBytes(),
          paused: item.isPaused(),
          state,
          startTime: item.getStartTime() * 1000,
        };
        if (target && !target.isDestroyed()) M.sendToOwner(target, 'download-update', payload);
        else M.sendToMain('download-update', payload);
      };
      report('progressing');
      item.on('updated', (_e, state) => report(state === 'interrupted' ? 'interrupted' : 'progressing'));
      item.once('done', (_e, state) => {
        report(state);
        downloads.delete(id);
      });
    });
  }

  ipcMain.on('download-action', (_event, { id, action, savePath }) => {
    const item = downloads.get(id);
    switch (action) {
      case 'cancel': if (item) item.cancel(); break;
      case 'pause': if (item) item.pause(); break;
      case 'resume': if (item && item.canResume()) item.resume(); break;
      case 'open': if (savePath) shell.openPath(savePath); break;
      case 'show': if (savePath) shell.showItemInFolder(savePath); break;
    }
  });

  /* ---------------------------------------------------------------- */
  /* Permissions: ask once per site instead of Electron's allow-all   */
  /* ---------------------------------------------------------------- */

  const ASKABLE = new Set(['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'clipboard-read', 'idle-detection', 'window-management']);
  const ALWAYS_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock']);
  const permissionsFile = () => path.join(app.getPath('userData'), 'permissions.json');
  let sitePermissions = null;
  const pending = new Map();

  function loadPermissions() {
    if (sitePermissions) return sitePermissions;
    try {
      sitePermissions = JSON.parse(fs.readFileSync(permissionsFile(), 'utf8'));
    } catch {
      sitePermissions = {};
    }
    return sitePermissions;
  }
  const savePermissions = () => fs.promises.writeFile(permissionsFile(), JSON.stringify(sitePermissions)).catch(() => {});

  function permissionKey(origin, permission, details) {
    const kind = permission === 'media' ? `media:${(details.mediaTypes || []).slice().sort().join('+') || 'av'}` : permission;
    return `${origin}|${kind}`;
  }

  function setupPermissions(ses, { remember }) {
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (contents.getType() !== 'webview') return callback(true);
      if (ALWAYS_ALLOW.has(permission)) return callback(true);
      if (!ASKABLE.has(permission) || !M.isBrowserWindow(M.ownerWindow(contents))) return callback(false);
      let origin;
      try {
        origin = new URL(details.requestingUrl || contents.getURL()).origin;
      } catch {
        return callback(false);
      }
      const key = permissionKey(origin, permission, details);
      const saved = loadPermissions()[key];
      if (saved !== undefined) return callback(saved);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      pending.set(id, { callback, key, remember });
      M.sendToOwner(contents, 'permission-request', { id, origin, permission, mediaTypes: details.mediaTypes || [] });
    });

    ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      if (!contents || contents.getType() !== 'webview') return true;
      if (ALWAYS_ALLOW.has(permission)) return true;
      if (!ASKABLE.has(permission)) return false;
      return loadPermissions()[permissionKey(requestingOrigin, permission, { mediaTypes: details && details.mediaType ? [details.mediaType] : [] })] === true;
    });
  }

  ipcMain.on('permission-response', (_event, { id, allow, remember }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    // Private windows never remember choices
    if (remember && request.remember) {
      loadPermissions()[request.key] = !!allow;
      savePermissions();
    }
    request.callback(!!allow);
  });
  ipcMain.handle('permissions-reset', () => {
    sitePermissions = {};
    savePermissions();
    return true;
  });
  ipcMain.handle('permissions-count', () => Object.keys(loadPermissions()).length);

  /* ---------------------------------------------------------------- */
  /* Apply to every session (default, Space profiles, private)        */
  /* ---------------------------------------------------------------- */

  const configured = new WeakSet();
  function configure(ses) {
    if (configured.has(ses)) return;
    configured.add(ses);
    setupBlocker(ses);
    privacy.configure(ses);
    setupDownloads(ses);
    setupPermissions(ses, { remember: ses.isPersistent() });
  }

  return {
    configureAll() {
      configure(session.defaultSession);
      app.on('session-created', configure);
    },
    resetBlockedCount(contents) {
      blockedPerContents.set(contents.id, 0);
      sendBlockedUpdate(contents.id);
    },
    forgetContents(id) {
      blockedPerContents.delete(id);
    },
  };
};
