// Privacy protections on top of Shields: cookie banner handling, HTTPS-only mode,
// fingerprinting protection and Global Privacy Control. Settings live here (not in the
// window's localStorage) because every window and session shares them. Page-side work is
// done by privacy-preload.js, registered as a session preload in every web frame.

const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULTS = {
  cookieBanners: 'reject', // 'reject' | 'hide' | 'off'
  httpsOnly: false,
  fingerprinting: 'private', // 'private' | 'always' | 'off'
  gpc: true,
  httpsExceptions: [], // hosts allowed over plain http
  bannerOffHosts: [], // sites where banners are left alone
};

// High-entropy client hints: exact browser/OS versions and hardware. The low-entropy ones
// (brand, major version, mobile, platform) are kept, since sites rely on them.
const HIGH_ENTROPY_HINTS = [
  'sec-ch-ua-full-version', 'sec-ch-ua-full-version-list', 'sec-ch-ua-platform-version',
  'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-model', 'sec-ch-ua-wow64', 'sec-ch-ua-form-factors',
];

const bareHost = (host) => String(host || '').toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');

// Local names and IP addresses almost never have a certificate: never upgrade them
function isLocalHost(host) {
  return !host.includes('.') || /\.(local|localhost|internal|lan|home|test)$/.test(host)
    || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[');
}

module.exports = function setupPrivacy(M, { countBanner }) {
  const file = () => path.join(app.getPath('userData'), 'privacy-settings.json');
  let settings = { ...DEFAULTS };
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; } catch { /* first run */ }
  const save = () => fs.promises.writeFile(file(), JSON.stringify(settings)).catch(() => {});

  // Private windows add exceptions for their own lifetime only
  const privateExceptions = new WeakMap(); // session -> Set of hosts
  const httpsAllowed = (ses, host) => settings.httpsExceptions.includes(host)
    || (privateExceptions.get(ses) || new Set()).has(host);

  const fingerprintingOn = (ses) => settings.fingerprinting === 'always'
    || (settings.fingerprinting === 'private' && !ses.isPersistent());

  /* ---------------------------------------------------------------- */
  /* HTTPS-only: upgrade top-level http navigations                    */
  /* ---------------------------------------------------------------- */

  const upgrades = new Map(); // webContentsId -> { host, at } while an upgraded load is in flight

  // Called from the blocker's onBeforeRequest (a session has only one such listener).
  // Returns a webRequest response to use, or null to carry on.
  function httpsUpgrade(details, ses) {
    if (!settings.httpsOnly || details.resourceType !== 'mainFrame') return null;
    const contents = details.webContents;
    if (!contents || contents.isDestroyed() || contents.getType() !== 'webview') return null;
    let url;
    try { url = new URL(details.url); } catch { return null; }
    if (url.protocol !== 'http:') return null;
    const host = bareHost(url.hostname);
    if (isLocalHost(host) || httpsAllowed(ses, host)) return null;
    const pending = upgrades.get(contents.id);
    if (pending && pending.host === host && Date.now() - pending.at < 15000) {
      // The https page redirected back to http: the site has no working https version.
      // Cancel; the window shows the HTTPS-only page for this load.
      upgrades.delete(contents.id);
      return { cancel: true };
    }
    upgrades.set(contents.id, { host, at: Date.now() });
    url.protocol = 'https:';
    if (url.port === '80') url.port = '';
    M.sendToOwner(contents, 'https-upgraded', { webContentsId: contents.id, from: details.url, to: url.href });
    return { redirectURL: url.href };
  }

  ipcMain.handle('https-exception-add', (event, host) => {
    host = bareHost(host);
    const ses = M.sessionFor(event.sender);
    if (!ses.isPersistent()) {
      if (!privateExceptions.has(ses)) privateExceptions.set(ses, new Set());
      privateExceptions.get(ses).add(host);
    } else if (!settings.httpsExceptions.includes(host)) {
      settings.httpsExceptions.push(host);
      save();
    }
    return true;
  });

  /* ---------------------------------------------------------------- */
  /* Request headers: Global Privacy Control, client hints             */
  /* ---------------------------------------------------------------- */

  function setupHeaders(ses) {
    ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
      const headers = details.requestHeaders;
      if (settings.gpc) headers['Sec-GPC'] = '1';
      if (fingerprintingOn(ses)) {
        for (const name of Object.keys(headers)) {
          if (HIGH_ENTROPY_HINTS.includes(name.toLowerCase())) delete headers[name];
        }
      }
      callback({ requestHeaders: headers });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Page side: config for privacy-preload.js, banner reports          */
  /* ---------------------------------------------------------------- */

  const bannerPerContents = new Map(); // webContentsId -> 'rejected' | 'hidden'

  // Sent synchronously by the preload at document start in every frame
  ipcMain.on('privacy-frame-config', (event, topUrl) => {
    let site = '';
    try { site = bareHost(new URL(topUrl).hostname); } catch { /* opaque */ }
    const ses = event.sender.session;
    const banners = settings.cookieBanners !== 'off' && !settings.bannerOffHosts.includes(site) ? settings.cookieBanners : 'off';
    event.returnValue = { banners, gpc: settings.gpc, fingerprinting: fingerprintingOn(ses) };
  });

  ipcMain.on('privacy-banner-handled', (event, action) => {
    const contents = event.sender;
    if (bannerPerContents.get(contents.id) === action || bannerPerContents.get(contents.id) === 'rejected') return;
    const first = !bannerPerContents.has(contents.id);
    bannerPerContents.set(contents.id, action);
    // Private windows leave no trace in the saved report
    if (first && contents.session.isPersistent()) countBanner();
  });

  ipcMain.handle('privacy-banner-status', (_event, id) => bannerPerContents.get(id) || null);
  ipcMain.handle('privacy-settings-get', () => settings);
  ipcMain.handle('privacy-settings-set', (_event, { key, value }) => {
    if (!(key in DEFAULTS)) return settings;
    settings[key] = value;
    save();
    return settings;
  });
  ipcMain.handle('privacy-banner-site-set', (_event, { host, enabled }) => {
    host = bareHost(host);
    settings.bannerOffHosts = settings.bannerOffHosts.filter((h) => h !== host);
    if (!enabled) settings.bannerOffHosts.push(host);
    save();
    return true;
  });

  // Pages: preloads also run in iframes (consent dialogs and third-party frames live there);
  // guests still get no Node. Per-page state resets on every navigation.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (_e, webPreferences) => {
      webPreferences.nodeIntegrationInSubFrames = true;
    });
    if (contents.getType() !== 'webview') return;
    const id = contents.id;
    contents.on('did-navigate', () => {
      bannerPerContents.delete(id);
      upgrades.delete(id);
    });
    // An upgraded page that redirects straight back to http has no working https version
    contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
      const pending = upgrades.get(id);
      if (!isMainFrame || !pending || !/^http:/i.test(url)) return;
      let host = '';
      try { host = bareHost(new URL(url).hostname); } catch { return; }
      if (host !== pending.host) return;
      event.preventDefault();
      upgrades.delete(id);
      M.sendToOwner(contents, 'https-only-failed', { webContentsId: id });
    });
    contents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) upgrades.delete(id);
    });
    contents.once('destroyed', () => {
      bannerPerContents.delete(id);
      upgrades.delete(id);
    });
  });

  function configure(ses) {
    setupHeaders(ses);
    try {
      ses.registerPreloadScript({ type: 'frame', id: 'surf-privacy', filePath: path.join(__dirname, 'privacy-preload.js') });
    } catch (err) {
      console.error('Privacy preload not registered:', err.message);
    }
  }

  return { configure, httpsUpgrade };
};
