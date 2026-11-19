// Reading list: pages saved to read later, shown as a tab in the Library drawer.
// Add with ⇧⌘L, the tab's context menu, or the command bar.

const ctx = require('./ctx');
const U = require('./util');

const T = () => ctx.tabs;
const KEY = 'browser.readingList'; // fresh (memory only) in private windows

let items = U.store.get(KEY, []); // [{ id, url, title, favicon, added, read }]
let filter = 'unread';

function save() {
  U.store.set(KEY, items);
  updateBadge();
  ctx.library.refresh('reading');
}

const unreadCount = () => items.filter((i) => !i.read).length;
const has = (url) => items.some((i) => i.url === url);

// Saving a page that's already on the list moves it back to the top as unread
function add(url, title, favicon) {
  if (!url || !/^https?:/i.test(url)) {
    U.toast('Only web pages can go on the reading list');
    return;
  }
  const existing = items.find((i) => i.url === url);
  items = items.filter((i) => i !== existing);
  items.unshift({ id: existing ? existing.id : U.uid(), url, title: title || U.hostOf(url), favicon: favicon || null, added: Date.now(), read: false });
  save();
  U.toast(existing ? 'Already on your reading list — moved to the top' : 'Added to reading list', { action: () => ctx.library.open('reading'), actionLabel: 'Show' });
}

function addEntry(entry) {
  const tab = T().live.get(entry.id);
  add((tab && tab.url) || entry.url, T().entryTitle(entry), T().entryFavicon(entry));
}

function addActive() {
  const tab = T().activeTab();
  if (!tab || tab.kind !== 'web' || U.isNewTabUrl(tab.url)) {
    U.toast('Open a web page to add it to your reading list');
    return;
  }
  add(tab.url, tab.title, tab.favicon);
}

function setRead(item, read) {
  item.read = read;
  save();
}

function remove(item) {
  items = items.filter((i) => i !== item);
  save();
}

function clearRead() {
  items = items.filter((i) => !i.read);
  save();
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
    let message = 'Save pages to read later with ⇧⌘L, or “Add to reading list” in a tab’s menu.';
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
    text.append(U.el('span', 'h-title', item.title), U.el('span', 'h-url', U.hostOf(item.url)));
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
    row.addEventListener('click', (e) => {
      const background = e.metaKey || e.ctrlKey;
      T().openTab(item.url, { activate: !background });
      if (!background) ctx.library.close();
      setRead(item, true);
    });
    list.appendChild(row);
  }
}

ctx.readingList = { add, addEntry, addActive, has, render, clearRead, updateBadge, unreadCount, all: () => items };
