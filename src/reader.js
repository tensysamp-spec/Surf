// Reader mode: Mozilla Readability runs inside the page to extract the article,
// then we show a clean, sanitized view over the tab (fonts, width, spacing, themes).
// The same view renders offline copies from the reading list as an internal tab.

const fs = require('fs');
const ctx = require('./ctx');
const U = require('./util');

const READABILITY = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8');
const READERABLE = fs.readFileSync(require.resolve('@mozilla/readability/Readability-readerable.js'), 'utf8');

const PREFS_KEY = 'browser.reader';
const DEFAULTS = { size: 19, font: 'serif', width: 'medium', spacing: 'normal', theme: 'auto', images: false };
let prefs = { ...DEFAULTS, ...U.store.get(PREFS_KEY, {}) };
const savePrefs = () => U.store.set(PREFS_KEY, prefs); // private windows: memory only

const FONTS = [['serif', 'Serif'], ['sans', 'Sans'], ['mono', 'Mono']];
const WIDTHS = [['narrow', 'Narrow'], ['medium', 'Medium'], ['wide', 'Wide']];
const SPACINGS = [['tight', 'Tight'], ['normal', 'Normal'], ['loose', 'Loose']];
const THEMES = [['light', 'Light'], ['sepia', 'Sepia'], ['dark', 'Dark'], ['auto', 'Auto']];

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

// Article extraction (also used by Read Aloud and offline saving)
async function extract(tab) {
  if (!tab || tab.kind !== 'web' || !tab.ready) return null;
  try {
    const article = await tab.webview.executeJavaScript(`${READABILITY}
;(() => {
  const a = new Readability(document.cloneNode(true), { charThreshold: 300 }).parse();
  return a && { title: a.title, byline: a.byline, siteName: a.siteName, content: a.content, textContent: a.textContent, length: a.length, lang: a.lang, dir: a.dir, publishedTime: a.publishedTime };
})()`);
    return article && { ...article, url: tab.url };
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

/* ------------------------------------------------------------------ */
/* The reader view (shared by the overlay and offline copies)          */
/* ------------------------------------------------------------------ */

function formatDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// copy: { url, title, byline, siteName, published, lang, dir, html, words, minutes, savedAt }
// actions: toolbar buttons that differ between the overlay and an offline tab
function buildView(copy, { actions = [], offline = false } = {}) {
  const view = U.el('div', 'reader-view');
  const progress = U.el('div', 'reader-progress');
  const scroll = U.el('div', 'reader-scroll');

  const toolbar = U.el('div', 'reader-toolbar');
  const pill = U.el('div', 'reader-pill');
  const aa = U.el('button', 'reader-tool reader-aa', 'Aa');
  aa.title = 'Text and theme';
  aa.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePopover(aa);
  });
  pill.append(...actions, aa);
  toolbar.appendChild(pill);

  const doc = U.el('article', 'reader-article');
  if (copy.dir) doc.dir = copy.dir;
  if (copy.lang) doc.lang = copy.lang;
  const meta = U.el('div', 'reader-site', copy.siteName || U.compactUrl(copy.url));
  if (offline) {
    const label = U.el('span', 'reader-offline-label', 'Offline copy');
    if (copy.savedAt) label.title = `Saved ${new Date(copy.savedAt).toLocaleString()}`;
    meta.appendChild(label);
  }
  const title = U.el('h1', 'reader-title', copy.title || U.compactUrl(copy.url));
  const byline = U.el('div', 'reader-byline', [copy.byline, formatDate(copy.published)].filter(Boolean).join(' · '));
  const stats = U.el('div', 'reader-stats');
  stats.append(U.icon('clock'), U.el('span', null, `${copy.minutes} min read`), U.el('span', 'reader-stats-sep', '·'), U.el('span', null, `${copy.words.toLocaleString()} words`));
  const body = U.el('div', 'reader-body');
  // Article HTML comes from a page: allowlist-sanitize before it touches our UI
  body.innerHTML = U.sanitizeHtml(copy.html, { rich: true });
  // Remote images in an offline copy can't load without a network: hide them quietly
  for (const img of body.querySelectorAll('img')) img.addEventListener('error', () => img.remove());
  doc.append(meta, title);
  if (byline.textContent) doc.appendChild(byline);
  doc.append(stats, body);
  scroll.append(toolbar, doc);
  view.append(progress, scroll);

  // Links open as tabs; nothing in the reader may navigate the browser UI itself
  view.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link || link.closest('.reader-toolbar')) return;
    e.preventDefault();
    const href = link.getAttribute('href');
    if (href && /^https?:/i.test(href)) {
      if (e.metaKey || e.ctrlKey) ctx.tabs.openTab(href, { activate: false });
      else ctx.peek.open(href);
    }
  });

  let frame = 0;
  scroll.addEventListener('scroll', () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const max = scroll.scrollHeight - scroll.clientHeight;
      progress.style.transform = `scaleX(${max > 0 ? Math.min(1, scroll.scrollTop / max) : 0})`;
    });
  });

  applyPrefs(view);
  return view;
}

function applyPrefs(view) {
  view.dataset.theme = prefs.theme;
  const doc = view.querySelector('.reader-article');
  if (!doc) return;
  doc.className = `reader-article font-${prefs.font} width-${prefs.width} spacing-${prefs.spacing}`;
  doc.style.fontSize = `${prefs.size}px`;
}

function setPref(key, value) {
  prefs[key] = value;
  savePrefs();
  for (const view of document.querySelectorAll('.reader-view')) applyPrefs(view);
}

/* ------------------------------------------------------------------ */
/* Text & theme popover                                                */
/* ------------------------------------------------------------------ */

let popover = null;
let popoverRelease = null;

function closePopover() {
  if (!popover) return;
  popover.remove();
  popover = null;
  document.removeEventListener('mousedown', onOutside, true);
  if (popoverRelease) popoverRelease();
  popoverRelease = null;
}

function onOutside(e) {
  if (popover && !popover.contains(e.target) && !e.target.closest('.reader-aa')) closePopover();
}

function segmented(options, key) {
  const row = U.el('div', 'reader-seg');
  for (const [value, label] of options) {
    const b = U.el('button', 'chip' + (prefs[key] === value ? ' active' : ''), label);
    if (key === 'font') b.classList.add(`reader-seg-font-${value}`);
    b.addEventListener('click', () => {
      setPref(key, value);
      for (const other of row.children) other.classList.toggle('active', other === b);
    });
    row.appendChild(b);
  }
  return row;
}

function togglePopover(anchor) {
  if (popover) {
    closePopover();
    return;
  }
  popover = U.el('div', 'popover reader-popover');
  const label = (text) => U.el('div', 'boost-label', text);

  const sizeRow = U.el('div', 'reader-seg reader-size');
  const sizeValue = U.el('span', 'reader-size-value', `${prefs.size}px`);
  const step = (delta) => {
    setPref('size', Math.max(14, Math.min(30, prefs.size + delta)));
    sizeValue.textContent = `${prefs.size}px`;
  };
  const smaller = U.el('button', 'chip', 'A−');
  const larger = U.el('button', 'chip reader-size-up', 'A+');
  smaller.title = 'Smaller text';
  larger.title = 'Larger text';
  smaller.addEventListener('click', () => step(-1));
  larger.addEventListener('click', () => step(1));
  sizeRow.append(smaller, sizeValue, larger);

  const themes = U.el('div', 'reader-themes');
  for (const [value, name] of THEMES) {
    const swatch = U.el('button', `reader-swatch swatch-${value}` + (prefs.theme === value ? ' active' : ''), value === 'auto' ? 'A' : '');
    swatch.title = value === 'auto' ? 'Auto (follow Surf’s appearance)' : name;
    swatch.addEventListener('click', () => {
      setPref('theme', value);
      for (const other of themes.children) other.classList.toggle('active', other === swatch);
    });
    themes.appendChild(swatch);
  }

  const imagesRow = U.el('label', 'settings-row');
  const imagesLabel = U.el('div', 'settings-label');
  imagesLabel.append(U.el('span', null, 'Keep small images offline'), U.el('small', null, 'Store images under 200 KB in offline copies'));
  const imagesToggle = U.el('input', 'settings-toggle');
  imagesToggle.type = 'checkbox';
  imagesToggle.checked = !!prefs.images;
  imagesToggle.addEventListener('change', () => setPref('images', imagesToggle.checked));
  imagesRow.append(imagesLabel, imagesToggle);

  popover.append(
    label('Font'), segmented(FONTS, 'font'),
    label('Size'), sizeRow,
    label('Line width'), segmented(WIDTHS, 'width'),
    label('Line spacing'), segmented(SPACINGS, 'spacing'),
    label('Theme'), themes,
    imagesRow,
  );
  document.body.appendChild(popover);
  const r = anchor.getBoundingClientRect();
  popover.style.left = `${Math.max(8, Math.min(r.right - popover.offsetWidth, window.innerWidth - popover.offsetWidth - 8))}px`;
  popover.style.top = `${r.bottom + 8}px`;
  popoverRelease = U.pushEscape(closePopover);
  document.addEventListener('mousedown', onOutside, true);
}

/* ------------------------------------------------------------------ */
/* Overlay on a live tab                                               */
/* ------------------------------------------------------------------ */

function tool(iconName, title, onClick, text) {
  const b = U.el('button', 'reader-tool');
  b.title = title;
  b.appendChild(U.icon(iconName));
  if (text) b.appendChild(U.el('span', null, text));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(e, b);
  });
  return b;
}

function savedOffline(url) {
  const item = ctx.readingList.all().find((i) => i.url === url);
  return !!(item && item.offline);
}

function render(tab, article) {
  const { words, minutes } = ctx.offline.stats(article.textContent);
  const copy = {
    url: tab.url, title: article.title || tab.title, byline: article.byline, siteName: article.siteName,
    published: article.publishedTime, lang: article.lang, dir: article.dir, html: article.content, words, minutes,
  };
  const listen = tool('volume', 'Read aloud', () => ctx.speech.readActive());
  const saveBtn = tool('download', 'Save an offline copy to your reading list', async (_e, b) => {
    b.disabled = true;
    await ctx.readingList.saveOffline(tab, article);
    b.disabled = false;
    markSaved(b, savedOffline(tab.url));
  }, 'Save offline');
  markSaved(saveBtn, savedOffline(tab.url));
  const close_ = tool('close', 'Close reader (Esc)', () => close(tab));

  const view = buildView(copy, { actions: [listen, saveBtn] });
  view.classList.add('tab-overlay');
  view.querySelector('.reader-pill').appendChild(close_);

  tab.readerEl = view;
  tab.readerRelease = U.pushEscape(() => close(tab));
  U.$('webviews-container').appendChild(view);
  ctx.page.syncOverlays();
  ctx.nav.update();
}

function markSaved(button, saved) {
  button.classList.toggle('active', saved);
  button.lastChild.textContent = saved ? 'Saved offline' : 'Save offline';
}

function close(tab) {
  if (!tab || !tab.readerEl) return;
  closePopover();
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

/* ------------------------------------------------------------------ */
/* Offline copies as internal tabs (kind 'offline', url = the article) */
/* ------------------------------------------------------------------ */

function openOffline(item) {
  for (const space of ctx.tabs.spaces) {
    for (const entry of ctx.tabs.entriesIn([...space.pinned, ...space.today])) {
      if (entry.kind === 'offline' && entry.url === item.url) {
        ctx.tabs.showEntry(entry.id);
        return;
      }
    }
  }
  ctx.tabs.openTab(item.url, { kind: 'offline', refId: item.id, title: item.title, favicon: item.favicon });
}

function offlineView(entry) {
  const wrap = U.el('div', 'internal-view reader-offline');
  wrap.appendChild(U.el('div', 'history-empty', 'Loading offline copy…'));
  const original = () => ctx.tabs.openTab(entry.url);
  ctx.offline.get(entry.url).then((copy) => {
    if (!copy) {
      const missing = U.el('div', 'reader-missing');
      const btn = U.el('button', 'btn', 'Open the page');
      btn.addEventListener('click', original);
      missing.append(U.el('div', 'history-empty', 'This offline copy is no longer available.'), btn);
      wrap.replaceChildren(missing);
      return;
    }
    const open_ = tool('external', 'Open the original page in a new tab', original, 'Open original');
    wrap.replaceChildren(buildView(copy, { actions: [open_], offline: true }));
  });
  return wrap;
}

ctx.reader = { bindTab, open, close, toggle, extract, openOffline, offlineView, prefs: () => prefs };
