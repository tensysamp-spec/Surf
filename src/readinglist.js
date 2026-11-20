// Reading list: pages saved to read later, shown as a tab in the Library drawer.
// Add with ⇧⌘L, the tab's context menu, or the command bar.

const ctx = require('./ctx');
const U = require('./util');

const T = () => ctx.tabs;
const KEY = 'browser.readingList'; // fresh (memory only) in private windows

let items = U.store.get(KEY, []); // [{ id, url, title, favicon, added, read, offline, words, minutes }]
let filter = 'unread';

function save() {
  U.store.set(KEY, items);
  updateBadge();
  ctx.library.refresh('reading');
}

const unreadCount = () => items.filter((i) => !i.read).length;
const has = (url) => items.some((i) => i.url === url);

// Saving a page that's already on the list moves it back to the top as unread.
// With a loaded tab, an offline copy is saved too when reader extraction works.
function add(url, title, favicon, tab) {
  if (!url || !/^https?:/i.test(url)) {
    U.toast('Only web pages can go on the reading list');
    return;
  }
  const existing = items.find((i) => i.url === url);
  items = items.filter((i) => i !== existing);
  const keep = existing ? { offline: existing.offline, words: existing.words, minutes: existing.minutes } : {};
  items.unshift({ id: existing ? existing.id : U.uid(), url, title: title || U.hostOf(url), favicon: favicon || null, added: Date.now(), read: false, ...keep });
  save();
  U.toast(existing ? 'Already on your reading list — moved to the top' : 'Added to reading list', { action: () => ctx.library.open('reading'), actionLabel: 'Show' });
  if (tab && tab.kind === 'web' && tab.ready && tab.url === url) storeOffline(tab, null, { quiet: true });
}

// Save (or refresh) the tab's offline copy and note it on its reading-list item
async function storeOffline(tab, article, { quiet = false } = {}) {
  const copy = await ctx.offline.saveTab(tab, article, { quiet });
  const item = copy && items.find((i) => i.url === copy.url);
  if (!item) return null;
  Object.assign(item, { offline: true, words: copy.words, minutes: copy.minutes });
  save();
  return copy;
}

// "Save offline" in the reader: puts the page on the list (if needed) with its copy
async function saveOffline(tab, article) {
  if (!items.some((i) => i.url === tab.url)) {
    items.unshift({ id: U.uid(), url: tab.url, title: (article && article.title) || tab.title || U.hostOf(tab.url), favicon: tab.favicon || null, added: Date.now(), read: false });
    save();
  }
  const copy = await storeOffline(tab, article);
  if (copy) U.toast('Saved for offline reading', { action: () => ctx.library.open('reading'), actionLabel: 'Show' });
}

function addEntry(entry) {
  const tab = T().live.get(entry.id);
  add((tab && tab.url) || entry.url, T().entryTitle(entry), T().entryFavicon(entry), tab);
}

function addActive() {
  const tab = T().activeTab();
  if (!tab || tab.kind !== 'web' || U.isNewTabUrl(tab.url)) {
    U.toast('Open a web page to add it to your reading list');
    return;
  }
  add(tab.url, tab.title, tab.favicon, tab);
}

function setRead(item, read) {
  item.read = read;
  save();
}

function remove(item) {
  items = items.filter((i) => i !== item);
  if (item.offline) ctx.offline.remove(item.url);
  save();
}

function removeOffline(item) {
  ctx.offline.remove(item.url);
  delete item.offline;
  save();
}

function clearRead() {
  for (const item of items) if (item.read && item.offline) ctx.offline.remove(item.url);
  items = items.filter((i) => !i.read);
  save();
}

// Opening an item with an offline copy shows the copy (works with no network);
// "Open page" in its menu, or ⌥-click, goes to the live page instead.
function openItem(item, { background = false, live = false } = {}) {
  if (item.offline && !live) ctx.reader.openOffline(item);
  else T().openTab(item.url, { activate: !background });
  if (!background) ctx.library.close();
  setRead(item, true);
}

function itemMenu(item, x, y) {
  U.contextMenu([
    item.offline && { label: 'Open offline copy', icon: 'download', action: () => openItem(item) },
    { label: 'Open page', icon: 'globe', action: () => openItem(item, { live: true }) },
    { label: 'Open page in background', icon: 'plus', action: () => openItem(item, { live: true, background: true }) },
    { separator: true },
    { label: item.read ? 'Mark as unread' : 'Mark as read', icon: item.read ? 'bookmark' : 'eye', action: () => setRead(item, !item.read) },
    item.offline && { label: 'Remove offline copy', icon: 'trash', action: () => removeOffline(item) },
    { label: 'Remove from reading list', icon: 'close', action: () => remove(item) },
  ], x, y);
}

/* ------------------------------------------------------------------ */
/* Library tab                                                         */
/* ------------------------------------------------------------------ */

// A dot on the Library's Reading tab while there's something unread (the count is in the filter)
function updateBadge() {
  const btn = document.querySelector('#library-tabs button[data-tab="reading"]');
  if (!btn) return;
  const n = unreadCount();
  btn.classList.toggle('rl-unread', n > 0);
  btn.title = n ? `${n} unread` : '';
}

function render(list, query) {
  const filters = U.el('div', 'rl-filters');
  for (const [value, label] of [['unread', `Unread${unreadCount() ? ` (${unreadCount()})` : ''}`], ['all', 'All']]) {
    const chip = U.el('button', 'chip' + (filter === value ? ' active' : ''), label);
    chip.addEventListener('click', () => {
      filter = value;
      ctx.library.refresh('reading');
    });
    filters.appendChild(chip);
  }
  list.appendChild(filters);

  const shown = items.filter((i) => (filter === 'all' || !i.read)
    && (!query || i.title.toLowerCase().includes(query) || i.url.toLowerCase().includes(query)));
  if (!shown.length) {
    const keys = ctx.shortcuts.label('reading-list');
    let message = `Save pages to read later${keys ? ` with ${keys}, or` : ' with'} “Add to reading list” in a tab’s menu.`;
    if (query) message = 'No matching pages.';
    else if (items.length) message = 'All caught up — nothing unread.';
    list.appendChild(U.el('div', 'history-empty', message));
    return;
  }
  for (const item of shown) {
    const row = U.el('div', 'lib-item rl-item' + (item.read ? ' read' : ''));
    const iconWrap = U.el('span', 'h-icon');
    iconWrap.appendChild(U.iconElement(item.favicon, U.ICONS.globe));
    const text = U.el('div', 'h-text');
    const sub = U.el('span', 'h-url', U.hostOf(item.url) + (item.minutes ? ` · ${item.minutes} min read` : ''));
    text.append(U.el('span', 'h-title', item.title), sub);
    if (item.offline) {
      const badge = U.el('span', 'rl-offline');
      badge.append(U.icon('download'), U.el('span', null, 'Offline'));
      badge.title = 'Saved for offline reading';
      text.appendChild(badge);
    }
    row.append(U.el('span', 'rl-dot'), iconWrap, text, U.el('span', 'h-time', U.timeAgo(item.added)));
    const btns = U.el('span', 'lib-actions');
    btns.appendChild(U.iconButton(item.read ? 'bookmark' : 'eye', item.read ? 'Mark as unread' : 'Mark as read', (e) => {
      e.stopPropagation();
      setRead(item, !item.read);
    }, 'h-delete'));
    btns.appendChild(U.iconButton('close', 'Remove from reading list', (e) => {
      e.stopPropagation();
      remove(item);
    }, 'h-delete'));
    row.appendChild(btns);
    row.addEventListener('click', (e) => openItem(item, { background: e.metaKey || e.ctrlKey, live: e.altKey || e.metaKey || e.ctrlKey }));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      itemMenu(item, e.clientX, e.clientY);
    });
    list.appendChild(row);
  }
}

// Offline copies belong to reading-list items: drop any left behind (e.g. by a crash)
if (!U.PRIVATE) setTimeout(() => ctx.offline.prune(items.filter((i) => i.offline).map((i) => i.url)), 5000);

ctx.readingList = { add, addEntry, addActive, saveOffline, has, render, clearRead, updateBadge, unreadCount, all: () => items };
