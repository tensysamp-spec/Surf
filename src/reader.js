// Reader mode: Mozilla Readability runs inside the page to extract the article,
// then we show a clean, sanitized view over the tab (light/dark, adjustable type).

const fs = require('fs');
const ctx = require('./ctx');
const U = require('./util');

const READABILITY = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8');
const READERABLE = fs.readFileSync(require.resolve('@mozilla/readability/Readability-readerable.js'), 'utf8');

const PREFS_KEY = 'browser.reader';
let prefs = { size: 19, font: 'serif', ...U.store.get(PREFS_KEY, {}) };
const savePrefs = () => U.store.set(PREFS_KEY, prefs);

// Called after each page load: is there an article here?
async function check(tab) {
  if (tab.kind !== 'web' || !tab.ready || !/^https?:/i.test(tab.url)) {
    tab.readerable = false;
    return;
  }
  try {
    tab.readerable = !!(await tab.webview.executeJavaScript(`${READERABLE}\n;isProbablyReaderable(document, { minContentLength: 180, minScore: 30 })`));
  } catch {
    tab.readerable = false;
  }
  if (tab.entryId === ctx.tabs.activeEntryId) ctx.nav.update();
}

// Article extraction (also used by Read Aloud)
async function extract(tab) {
  if (!tab || tab.kind !== 'web' || !tab.ready) return null;
  try {
    return await tab.webview.executeJavaScript(`${READABILITY}
;(() => {
  const a = new Readability(document.cloneNode(true), { charThreshold: 300 }).parse();
  return a && { title: a.title, byline: a.byline, siteName: a.siteName, content: a.content, textContent: a.textContent, length: a.length, lang: a.lang, dir: a.dir };
})()`);
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function open(tab = ctx.tabs.activeTab()) {
  if (!tab || tab.kind !== 'web' || !tab.ready) return;
  if (tab.readerEl) {
    close(tab);
    return;
  }
  const article = await extract(tab);
  if (!article || !article.content) {
    U.toast('This page doesn’t have a reader view');
    return;
  }
  render(tab, article);
}

function render(tab, article) {
  const view = U.el('div', 'reader-view tab-overlay');
  const scroll = U.el('div', 'reader-scroll');

  const toolbar = U.el('div', 'reader-toolbar');
  const smaller = U.el('button', 'chip', 'A−');
  const larger = U.el('button', 'chip', 'A+');
  const font = U.el('button', 'chip', prefs.font === 'serif' ? 'Sans' : 'Serif');
  const listen = U.iconButton('volume', 'Read aloud', () => ctx.speech.readActive(), 'icon-btn');
  const close_ = U.iconButton('close', 'Close reader (Esc)', () => close(tab));
  smaller.title = 'Smaller text';
  larger.title = 'Larger text';
  font.title = 'Switch typeface';
  toolbar.append(listen, smaller, larger, font, close_);

  const doc = U.el('article', `reader-article font-${prefs.font}`);
  doc.style.fontSize = `${prefs.size}px`;
  if (article.dir) doc.dir = article.dir;
  if (article.lang) doc.lang = article.lang;
  const meta = U.el('div', 'reader-site', article.siteName || U.compactUrl(tab.url));
  const title = U.el('h1', 'reader-title', article.title || tab.title);
  const minutes = Math.max(1, Math.round((article.length || 0) / 5 / 230));
  const byline = U.el('div', 'reader-byline', [article.byline, `${minutes} min read`].filter(Boolean).join(' · '));
  const body = U.el('div', 'reader-body');
  // Article HTML comes from the page: allowlist-sanitize before it touches our UI
  body.innerHTML = U.sanitizeHtml(article.content, { rich: true });
  doc.append(meta, title, byline, body);
  scroll.append(toolbar, doc);
  view.appendChild(scroll);

  // Links open as tabs; nothing in the reader may navigate the browser UI itself
  view.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute('href');
    if (href && /^https?:/i.test(href)) {
      if (e.metaKey || e.ctrlKey) ctx.tabs.openTab(href, { activate: false });
      else ctx.peek.open(href);
    }
  });

  smaller.addEventListener('click', () => setSize(doc, prefs.size - 1));
  larger.addEventListener('click', () => setSize(doc, prefs.size + 1));
  font.addEventListener('click', () => {
    prefs.font = prefs.font === 'serif' ? 'sans' : 'serif';
    doc.className = `reader-article font-${prefs.font}`;
    font.textContent = prefs.font === 'serif' ? 'Sans' : 'Serif';
    savePrefs();
  });

  tab.readerEl = view;
  tab.readerRelease = U.pushEscape(() => close(tab));
  U.$('webviews-container').appendChild(view);
  ctx.page.syncOverlays();
  ctx.nav.update();
}

function setSize(doc, size) {
  prefs.size = Math.max(14, Math.min(28, size));
  doc.style.fontSize = `${prefs.size}px`;
  savePrefs();
}

function close(tab) {
  if (!tab || !tab.readerEl) return;
  tab.readerEl.remove();
  tab.readerEl = null;
  if (tab.readerRelease) tab.readerRelease();
  tab.readerRelease = null;
  if (tab.entryId === ctx.tabs.activeEntryId) ctx.nav.update();
}

function toggle() {
  const tab = ctx.tabs.activeTab();
  if (tab && tab.readerEl) close(tab);
  else open(tab);
}

function bindTab(tab) {
  tab.webview.addEventListener('did-stop-loading', () => check(tab));
  tab.webview.addEventListener('did-navigate', () => close(tab));
}

ctx.reader = { bindTab, open, close, toggle, extract };
