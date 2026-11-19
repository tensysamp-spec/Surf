// Address bar suggestions: inline-completes sites you've visited, and shows a dropdown
// of open tabs, history matches, and live search suggestions as you type.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const T = () => ctx.tabs;
let items = [];
let index = -1;
let query = '';
let remoteTimer = null;
let remoteFor = '';
let remote = [];

// Site search: type a keyword, press Tab, then your query (like Arc / Chrome)
const SITES = [
  { name: 'YouTube', keys: ['youtube', 'yt'], url: 'https://www.youtube.com/results?search_query=' },
  { name: 'GitHub', keys: ['github', 'gh'], url: 'https://github.com/search?q=' },
  { name: 'Wikipedia', keys: ['wikipedia', 'wiki', 'wp'], url: 'https://en.wikipedia.org/w/index.php?search=' },
  { name: 'Reddit', keys: ['reddit', 'r'], url: 'https://www.reddit.com/search/?q=' },
  { name: 'Amazon', keys: ['amazon', 'amz'], url: 'https://www.amazon.com/s?k=' },
  { name: 'Google', keys: ['google', 'g'], url: 'https://www.google.com/search?q=' },
  { name: 'Google Images', keys: ['images', 'img'], url: 'https://www.google.com/search?tbm=isch&q=' },
  { name: 'Google Maps', keys: ['maps'], url: 'https://www.google.com/maps/search/' },
  { name: 'DuckDuckGo', keys: ['duckduckgo', 'ddg'], url: 'https://duckduckgo.com/?q=' },
  { name: 'X', keys: ['x', 'twitter'], url: 'https://x.com/search?q=' },
  { name: 'Stack Overflow', keys: ['stackoverflow', 'so'], url: 'https://stackoverflow.com/search?q=' },
  { name: 'npm', keys: ['npm'], url: 'https://www.npmjs.com/search?q=' },
  { name: 'MDN', keys: ['mdn'], url: 'https://developer.mozilla.org/en-US/search?q=' },
  { name: 'IMDb', keys: ['imdb'], url: 'https://www.imdb.com/find/?q=' },
  { name: 'Spotify', keys: ['spotify'], url: 'https://open.spotify.com/search/' },
  { name: 'Google Translate', keys: ['translate', 'tr'], url: 'https://translate.google.com/?text=' },
];
let siteMode = null;

function matchSite(typed) {
  const t = typed.trim().toLowerCase();
  if (!t || /\s/.test(t)) return null;
  // Exact keyword first, then prefix of a full name (at least 2 letters)
  return SITES.find((s) => s.keys.includes(t)) || (t.length >= 2 ? SITES.find((s) => s.keys[0].startsWith(t)) : null) || null;
}

function enterSiteMode(site) {
  siteMode = site;
  const chip = U.$('site-chip');
  chip.textContent = site.name;
  chip.hidden = false;
  input().value = '';
  input().placeholder = `Search ${site.name}`;
  U.$('omnibox').classList.add('site-mode');
  refresh('');
}

function exitSiteMode() {
  if (!siteMode) return;
  siteMode = null;
  U.$('site-chip').hidden = true;
  input().placeholder = 'Search or enter address';
  U.$('omnibox').classList.remove('site-mode');
}

const input = () => U.$('url-input');
const box = () => U.$('omni-suggest');
const isOpen = () => !box().hidden;

/* ------------------------------------------------------------------ */
/* Inline completion: "git" -> "git|hub.com"                           */
/* ------------------------------------------------------------------ */

function inlineCompletion(text) {
  if (!text || /\s/.test(text) || text.includes('/')) return null;
  const lower = text.toLowerCase();
  const counts = new Map();
  const add = (url, weight) => {
    const host = U.hostOf(url).replace(/^www\./, '');
    if (host.startsWith(lower)) counts.set(host, (counts.get(host) || 0) + weight);
  };
  for (const f of T().favorites) add(f.url, 20);
  for (const h of ctx.library.history().slice(0, 1500)) add(h.url, 1);
  let best = null;
  let bestCount = 0;
  for (const [host, count] of counts) {
    if (count > bestCount || (count === bestCount && best && host.length < best.length)) {
      best = host;
      bestCount = count;
    }
  }
  return best && best !== lower ? best : null;
}

/* ------------------------------------------------------------------ */
/* Suggestions                                                         */
/* ------------------------------------------------------------------ */

function build(text) {
  const q = text.trim();
  const needle = q.toLowerCase();
  const out = [];
  if (siteMode) {
    if (!q) return out;
    out.push({ kind: 'search', title: q, sub: `Search ${siteMode.name}`, url: siteMode.url + encodeURIComponent(q), iconName: 'search' });
    if (remoteFor === q) for (const r of remote) out.push({ kind: 'search', title: r, sub: siteMode.name, url: siteMode.url + encodeURIComponent(r), iconName: 'search' });
    return out.slice(0, 8);
  }
  if (!q) return out;

  const site = matchSite(q);
  if (site) out.push({ kind: 'site', title: `Search ${site.name}`, sub: 'Press Tab', site, iconName: 'search' });

  const resolved = U.resolveInput(q);
  if (U.looksLikeUrl(q)) out.push({ kind: 'url', title: U.compactUrl(resolved) || q, sub: 'Go to site', url: resolved, iconName: 'globe' });
  out.push({ kind: 'search', title: q, sub: `Search ${U.searchEngine().name}`, url: U.searchUrl(q), iconName: 'search' });

  // Open tabs
  const seen = new Set();
  const entries = [...T().favorites, ...T().spaces.flatMap((s) => T().entriesIn([...s.pinned, ...s.today]))];
  for (const e of entries) {
    if (out.filter((o) => o.kind === 'tab').length >= 2) break;
    if (e.id === T().activeEntryId || seen.has(e.id)) continue;
    const title = T().entryTitle(e);
    if (!(title.toLowerCase().includes(needle) || (e.url || '').toLowerCase().includes(needle))) continue;
    seen.add(e.id);
    out.push({ kind: 'tab', title, sub: 'Switch to tab', entryId: e.id, favicon: T().entryFavicon(e), iconName: e.kind === 'web' ? null : e.kind });
  }

  // History (deduped by URL, prefer title/host matches)
  const urls = new Set(out.map((o) => o.url));
  let historyCount = 0;
  for (const h of ctx.library.history()) {
    if (historyCount >= 4) break;
    if (urls.has(h.url)) continue;
    const host = U.hostOf(h.url).replace(/^www\./, '');
    if (!(h.title.toLowerCase().includes(needle) || host.startsWith(needle) || h.url.toLowerCase().includes(needle))) continue;
    urls.add(h.url);
    historyCount++;
    out.push({ kind: 'page', title: h.title, sub: U.compactUrl(h.url), url: h.url, favicon: h.favicon });
  }

  // Search suggestions from the network (arrive a moment later)
  if (remoteFor === q) {
    for (const s of remote) {
      if (s.toLowerCase() === needle) continue;
      out.push({ kind: 'search', title: s, sub: 'Search', url: U.searchUrl(s), iconName: 'search' });
    }
  }
  return out.slice(0, 10);
}

function paint() {
  const el = box();
  el.replaceChildren();
  if (!items.length) {
    el.hidden = true;
    return;
  }
  items.forEach((item, i) => {
    const row = U.el('div', 'suggest-item' + (i === index ? ' selected' : ''));
    const iconWrap = U.el('span', 'c-icon');
    iconWrap.appendChild(item.iconName ? U.icon(item.iconName) : U.iconElement(item.favicon, U.ICONS.globe));
    row.append(iconWrap, U.el('span', 'c-title', item.title), U.el('span', 'c-sub', item.sub));
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('click', () => run(item));
    row.addEventListener('mousemove', () => {
      if (index !== i) {
        index = i;
        paint();
      }
    });
    el.appendChild(row);
  });

  const rect = U.$('omnibox').getBoundingClientRect();
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.bottom + 6}px`;
  el.style.width = `${Math.max(rect.width, 420)}px`;
  el.hidden = false;
}

function refresh(text) {
  query = text;
  items = build(text);
  index = -1;
  paint();

  clearTimeout(remoteTimer);
  const q = text.trim();
  if (q.length >= 2 && (siteMode || !U.looksLikeUrl(q))) {
    remoteTimer = setTimeout(async () => {
      const results = await ipcRenderer.invoke('search-suggest', q);
      if (input().value.trim().toLowerCase().startsWith(q.toLowerCase()) && document.activeElement === input()) {
        remote = results;
        remoteFor = q;
        items = build(query);
        paint();
      }
    }, 140);
  }
}

function run(item) {
  if (item.kind === 'site') {
    enterSiteMode(item.site);
    return;
  }
  close();
  input().blur();
  if (item.kind === 'tab') T().showEntry(item.entryId);
  else T().navigateActive(item.url);
}

function close() {
  box().hidden = true;
  items = [];
  index = -1;
}

function setup() {
  const el = input();

  el.addEventListener('input', (e) => {
    const typed = el.value.slice(0, el.selectionStart);
    // Only complete while typing forward at the end of the text
    if (e.inputType === 'insertText' && el.selectionStart === el.value.length) {
      const completion = inlineCompletion(typed);
      if (completion && completion.startsWith(typed.toLowerCase())) {
        el.value = typed + completion.slice(typed.length);
        el.setSelectionRange(typed.length, el.value.length);
      }
    }
    refresh(typed);
  });

  el.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && !siteMode) {
      const typed = el.value.slice(0, el.selectionStart);
      const site = matchSite(typed);
      if (site) {
        e.preventDefault();
        enterSiteMode(site);
        return;
      }
    }
    if (siteMode && e.key === 'Enter' && index < 0) {
      e.preventDefault();
      const q = el.value.trim();
      if (q) {
        const url = siteMode.url + encodeURIComponent(q);
        close();
        exitSiteMode();
        el.blur();
        T().navigateActive(url);
      }
      return;
    }
    if (siteMode && e.key === 'Backspace' && !el.value) {
      e.preventDefault();
      exitSiteMode();
      return;
    }
    if (!isOpen()) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      // -1 means "what you typed"; cycle through it and every suggestion
      if (e.key === 'ArrowDown') index = index + 1 >= items.length ? -1 : index + 1;
      else index = index - 1 < -1 ? items.length - 1 : index - 1;
      const selected = items[index];
      if (selected && selected.kind !== 'tab') el.value = selected.kind === 'search' ? selected.title : selected.url;
      else if (!selected) el.value = query;
      paint();
    } else if (e.key === 'Enter' && index >= 0) {
      e.preventDefault();
      run(items[index]);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });

  el.addEventListener('blur', () => setTimeout(() => {
    close();
    exitSiteMode();
  }, 100));
  el.addEventListener('focus', () => {
    remote = [];
    remoteFor = '';
  });
}

ctx.suggest = { setup, close };
