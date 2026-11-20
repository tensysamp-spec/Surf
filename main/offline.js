// Offline copies of reading-list articles: the sanitized reader HTML plus its metadata,
// one JSON file per article under userData/Offline Articles. Files (not the window's
// IndexedDB) because they live with the profile, aren't subject to Chromium's
// best-effort storage eviction, survive a window origin change, and are easy to inspect
// or delete. Private windows never reach this: they keep copies in memory only.

const { app, ipcMain, webContents, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const MAX_ARTICLE = 6 * 1024 * 1024; // one article's JSON, images included
const MAX_TOTAL = 300 * 1024 * 1024; // the whole store
const MAX_IMAGE = 200 * 1024; // images are only inlined when small…
const MAX_IMAGES_TOTAL = 2 * 1024 * 1024; // …and only up to this much per article
const MAX_IMAGE_COUNT = 40;
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp)$/i;

module.exports = function setupOffline(M) {
  const dir = () => path.join(app.getPath('userData'), 'Offline Articles');
  const keyOf = (url) => crypto.createHash('sha1').update(String(url)).digest('hex');
  const fileOf = (url) => path.join(dir(), `${keyOf(url)}.json`);
  // Only the browser window's own (non-private) UI may read or write the store
  const allowed = (event) => {
    const win = M.windowOf(event.sender);
    return M.isBrowserWindow(win) && !M.isPrivateWindow(win);
  };
  const validUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url) && url.length < 4096;

  function entries() {
    try {
      return fs.readdirSync(dir()).filter((f) => /^[0-9a-f]{40}\.json$/.test(f)).map((f) => {
        const file = path.join(dir(), f);
        return { file, size: fs.statSync(file).size };
      });
    } catch {
      return [];
    }
  }

  ipcMain.handle('offline-save', (event, article) => {
    if (!allowed(event) || !article || !validUrl(article.url)) return { ok: false, error: 'Not allowed' };
    const json = JSON.stringify({ ...article, savedAt: Date.now() });
    if (json.length > MAX_ARTICLE) return { ok: false, error: 'Article is too large to save offline' };
    const file = fileOf(article.url);
    const others = entries().filter((e) => e.file !== file).reduce((sum, e) => sum + e.size, 0);
    if (others + json.length > MAX_TOTAL) return { ok: false, error: 'Offline storage is full — remove some saved articles' };
    fs.mkdirSync(dir(), { recursive: true });
    // Write then rename, so a crash never leaves a half-written copy behind
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);
    return { ok: true, size: json.length };
  });

  ipcMain.handle('offline-get', (event, url) => {
    if (!allowed(event) || !validUrl(url)) return null;
    try {
      return JSON.parse(fs.readFileSync(fileOf(url), 'utf8'));
    } catch {
      return null;
    }
  });

  ipcMain.handle('offline-delete', (event, url) => {
    if (!allowed(event) || !validUrl(url)) return false;
    fs.rmSync(fileOf(url), { force: true });
    return true;
  });

  // Drop copies whose article is no longer on the reading list
  ipcMain.handle('offline-prune', (event, keepUrls) => {
    if (!allowed(event) || !Array.isArray(keepUrls)) return 0;
    const keep = new Set(keepUrls.filter(validUrl).map((u) => `${keyOf(u)}.json`));
    let removed = 0;
    for (const e of entries()) {
      if (keep.has(path.basename(e.file))) continue;
      fs.rmSync(e.file, { force: true });
      removed++;
    }
    return removed;
  });

  ipcMain.handle('offline-usage', (event) => {
    if (!allowed(event)) return { count: 0, bytes: 0 };
    const all = entries();
    return { count: all.length, bytes: all.reduce((sum, e) => sum + e.size, 0) };
  });

  // Small images as data: URLs, fetched with the tab's own session (cookies, isolated Spaces).
  // Main fetches them because the window's file:// origin would hit CORS.
  ipcMain.handle('offline-inline-images', async (event, { urls, webContentsId }) => {
    if (!allowed(event) || !Array.isArray(urls)) return {};
    const wc = webContentsId ? webContents.fromId(webContentsId) : null;
    const ses = wc ? wc.session : session.defaultSession;
    const out = {};
    let total = 0;
    for (const url of [...new Set(urls)].filter((u) => /^https:\/\//i.test(u)).slice(0, MAX_IMAGE_COUNT)) {
      if (total >= MAX_IMAGES_TOTAL) break;
      try {
        const res = await ses.fetch(url, { signal: AbortSignal.timeout(8000) });
        const type = (res.headers.get('content-type') || '').split(';')[0].trim();
        const declared = Number(res.headers.get('content-length') || 0);
        if (!res.ok || !IMAGE_TYPES.test(type) || declared > MAX_IMAGE) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_IMAGE || total + buf.length > MAX_IMAGES_TOTAL) continue;
        total += buf.length;
        out[url] = `data:${type.toLowerCase()};base64,${buf.toString('base64')}`;
      } catch {
        // Unreachable or slow image: the copy just goes without it
      }
    }
    return out;
  });
};
