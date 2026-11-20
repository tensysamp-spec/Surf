// Site info popover: cookies count, "clear site data" and the certificate issuer.
// Always works on the tab's own session, so isolated Spaces and private windows
// only ever see (and clear) their own cookies.

const { ipcMain, session, webContents } = require('electron');
const tls = require('tls');

module.exports = function setupSiteInfo() {
  const sessionOf = (id) => {
    const contents = id != null ? webContents.fromId(id) : null;
    return contents && !contents.isDestroyed() ? contents.session : session.defaultSession;
  };
  const siteDomain = (host) => String(host).replace(/^www\./, '');

  // Cookies for the site and its subdomains, like Chrome's "cookies in use"
  ipcMain.handle('site-cookies', async (_event, { host, webContentsId }) => {
    try {
      const cookies = await sessionOf(webContentsId).cookies.get({ domain: siteDomain(host) });
      return { count: cookies.length };
    } catch {
      return { count: null };
    }
  });

  ipcMain.handle('site-clear-data', async (_event, { host, webContentsId }) => {
    const ses = sessionOf(webContentsId);
    const domain = siteDomain(host);
    // Storage is per origin: cover http/https with and without www
    const origins = [];
    for (const scheme of ['https', 'http']) for (const h of new Set([host, domain, `www.${domain}`])) origins.push(`${scheme}://${h}`);
    for (const origin of origins) {
      try { await ses.clearStorageData({ origin }); } catch { /* ignore */ }
    }
    // clearStorageData leaves cookies set on a parent/sub domain, so remove those one by one
    try {
      const cookies = await ses.cookies.get({ domain });
      await Promise.all(cookies.map((c) => {
        const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
        return ses.cookies.remove(url, c.name).catch(() => {});
      }));
    } catch { /* ignore */ }
    // Only this site's cached files, not the whole cache
    try { await ses.clearData({ dataTypes: ['cache'], origins }); } catch { /* ignore */ }
    return true;
  });

  // Who issued the site's certificate (a separate short TLS handshake; cached)
  const issuers = new Map();
  ipcMain.handle('site-certificate', (_event, { host, port = 443 }) => {
    const key = `${host}:${port}`;
    if (issuers.has(key)) return issuers.get(key);
    return new Promise((resolve) => {
      const done = (result) => {
        if (result) issuers.set(key, result);
        resolve(result);
      };
      const socket = tls.connect({ host, port, servername: host, timeout: 4000 }, () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.issuer) return done(null);
        done({
          issuer: cert.issuer.O || cert.issuer.CN || '',
          subject: (cert.subject && cert.subject.CN) || host,
          validTo: cert.valid_to ? Date.parse(cert.valid_to) : null,
          authorized: socket.authorized,
        });
      });
      socket.on('timeout', () => { socket.destroy(); done(null); });
      socket.on('error', () => done(null));
    });
  });
};
