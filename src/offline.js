// Offline copies of articles (for the reading list): the reader extraction, sanitized,
// stored by the main process as files under userData (see main/offline.js).
// Private windows keep copies in memory only, so nothing outlives the window.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const memory = new Map(); // private windows: url → copy

// Words and reading time from the article's plain text. CJK text has few spaces,
// so count its characters instead (about two per "word" is a fair reading pace).
function stats(text) {
  const t = String(text || '').trim();
  const cjk = (t.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
  const words = (t.match(/\S+/g) || []).length + Math.round(cjk / 2);
  return { words, minutes: Math.max(1, Math.round(words / 230)) };
}

// Turn a reader extraction into the stored copy. Images stay remote links unless
// inlining is on, in which case small ones become data: URLs (the rest are dropped).
async function build(tab, article, { images = false } = {}) {
  const holder = document.createElement('div');
  holder.innerHTML = U.sanitizeHtml(article.content, { rich: true });
  if (images) {
    const urls = [...holder.querySelectorAll('img[src^="https:"]')].map((img) => img.getAttribute('src'));
    const inlined = urls.length ? await ipcRenderer.invoke('offline-inline-images', { urls, webContentsId: tab && tab.webContentsId }) : {};
    for (const img of holder.querySelectorAll('img[src^="https:"]')) {
      const data = inlined[img.getAttribute('src')];
      if (data) img.setAttribute('src', data);
      else img.remove();
    }
  }
  const { words, minutes } = stats(article.textContent);
  return {
    url: article.url,
    title: article.title || '',
    byline: article.byline || '',
    siteName: article.siteName || '',
    published: article.publishedTime || '',
    lang: article.lang || '',
    dir: article.dir || '',
    html: U.sanitizeHtml(holder.innerHTML, { rich: true }),
    words,
    minutes,
  };
}

async function save(copy) {
  if (U.PRIVATE) {
    memory.set(copy.url, { ...copy, savedAt: Date.now() });
    return { ok: true };
  }
  return ipcRenderer.invoke('offline-save', copy);
}

async function get(url) {
  if (U.PRIVATE) return memory.get(url) || null;
  return ipcRenderer.invoke('offline-get', url);
}

function remove(url) {
  if (U.PRIVATE) memory.delete(url);
  else ipcRenderer.invoke('offline-delete', url);
}

// Keep only copies of articles still on the reading list
function prune(keepUrls) {
  if (U.PRIVATE) {
    for (const url of memory.keys()) if (!keepUrls.includes(url)) memory.delete(url);
    return;
  }
  ipcRenderer.invoke('offline-prune', keepUrls);
}

// Extract the tab's article (unless given) and store it. Returns the stored copy or null.
async function saveTab(tab, article, { quiet = false } = {}) {
  article = article || await ctx.reader.extract(tab);
  // Automatic saves skip pages whose "article" is just a stub (error pages, app shells)
  if (!article || !article.content || (quiet && (article.length || 0) < 500)) {
    if (!quiet) U.toast('This page doesn’t have an article to save');
    return null;
  }
  const copy = await build(tab, { ...article, url: article.url || tab.url }, { images: ctx.reader.prefs().images });
  const result = await save(copy);
  if (!result || !result.ok) {
    if (!quiet) U.toast((result && result.error) || 'Couldn’t save the article');
    return null;
  }
  return copy;
}

ctx.offline = { stats, build, save, get, remove, prune, saveTab };
