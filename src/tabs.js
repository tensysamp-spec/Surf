// Tab model: Spaces with pinned + today sections, folders, split views,
// global favorites, archive, and the live <webview>s behind them.
//
// Persistent nodes:
//   Entry  { type: 'entry', id, url, title, favicon, kind: 'web'|'note'|'easel', refId, customTitle, lastActive }
//   Folder { type: 'folder', id, name, open, children: Entry[] }
//   Split  { type: 'split', id, children: Entry[] }   (today section only)
// A live tab (webview or internal view) exists only for entries that have been opened.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const KEYS = {
  spaces: 'browser.spaces',
  favorites: 'browser.favorites',
  archive: 'browser.archive',
  activeSpace: 'browser.activeSpace',
};

const THEMES = [
  { name: 'Lavender', a: '#c9b8fa', b: '#ece6fd', c: '#f2c6e9', accent: '#6a52d6', dark: { a: '#372a6b', b: '#17161f', c: '#48264f', accent: '#ad9fff' } },
  { name: 'Sky', a: '#b2d2fb', b: '#e6f0fd', c: '#bde9ef', accent: '#2a72c6', dark: { a: '#1a3f6b', b: '#11161f', c: '#13464b', accent: '#7cc4ff' } },
  { name: 'Mint', a: '#ade2c7', b: '#e7f6ee', c: '#d4eead', accent: '#1f8755', dark: { a: '#1e4834', b: '#111814', c: '#2e411a', accent: '#74d6a0' } },
  { name: 'Blush', a: '#f6b9cd', b: '#fcebf1', c: '#fbd0b3', accent: '#c43a6b', dark: { a: '#592a46', b: '#1a1419', c: '#552d22', accent: '#ff9cc2' } },
  { name: 'Sand', a: '#efca92', b: '#f9efdf', c: '#f4bea5', accent: '#a9660c', dark: { a: '#523a19', b: '#18150f', c: '#4e2b1f', accent: '#ffc46b' } },
  { name: 'Paper', a: '#d8d8e0', b: '#f2f2f4', c: '#e3e3ec', accent: '#4a4a55', dark: { a: '#303037', b: '#151517', c: '#27272f', accent: '#c8c8d0' } },
];

const ARCHIVE_LIMIT = 500;
const SPLIT_MAX = 4;
const SPLIT_GAP = 8;

let spaces = [];
let favorites = [];
let archive = [];
let activeSpaceId = null;
let activeEntryId = null;
let displayed = []; // entry ids visible right now (1, or 2–4 in a split)
const live = new Map(); // entryId -> tab

const container = () => U.$('webviews-container');

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

function newEntry({ url, title, favicon, kind = 'web', refId = null }) {
  return {
    type: 'entry',
    id: U.uid(),
    url,
    title: title || (U.isNewTabUrl(url) ? 'New Tab' : U.hostOf(url)) || 'Untitled',
    favicon: favicon || null,
    kind,
    refId,
    customTitle: null,
    lastActive: Date.now(),
  };
}

function newSpace(name, theme = 0) {
  return { id: U.uid(), name, theme, pinned: [], today: [], activeEntryId: null };
}

function load() {
  spaces = U.store.get(KEYS.spaces, null);
  favorites = U.store.get(KEYS.favorites, null);
  archive = U.store.get(KEYS.archive, []);

  // Migrate bookmarks from the previous version into favorites
  if (!favorites) {
    favorites = U.store.get('browser.bookmarks', []).map((b) => newEntry(b));
  }
  if (!Array.isArray(spaces) || spaces.length === 0) {
    spaces = [U.PRIVATE ? newSpace('Private', 0) : newSpace('Personal', U.store.get('browser.theme', 0) || 0)];
  }
  activeSpaceId = U.store.get(KEYS.activeSpace, spaces[0].id);
  if (!getSpace(activeSpaceId)) activeSpaceId = spaces[0].id;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
function saveNow() {
  clearTimeout(saveTimer);
  U.store.set(KEYS.spaces, spaces);
  U.store.set(KEYS.favorites, favorites);
  U.store.set(KEYS.archive, archive);
  U.store.set(KEYS.activeSpace, activeSpaceId);
}
window.addEventListener('beforeunload', saveNow);

/* ------------------------------------------------------------------ */
/* Lookup helpers                                                      */
/* ------------------------------------------------------------------ */

const getSpace = (id) => spaces.find((s) => s.id === id) || null;
const activeSpace = () => getSpace(activeSpaceId);

function* walk(list, parent = null) {
  for (let i = 0; i < list.length; i++) {
    const node = list[i];
    yield { node, list, index: i, parent };
    if (node.children) yield* walk(node.children, node);
  }
}

// Where does a node live? -> { node, list, index, parent, section, space }
function locate(id) {
  for (const hit of walk(favorites)) {
    if (hit.node.id === id) return { ...hit, section: 'fav', space: null };
  }
  for (const space of spaces) {
    for (const section of ['pinned', 'today']) {
      for (const hit of walk(space[section])) {
        if (hit.node.id === id) return { ...hit, section, space };
      }
    }
  }
  return null;
}

const findEntry = (id) => {
  const loc = locate(id);
  return loc && loc.node.type === 'entry' ? loc.node : null;
};

function entriesIn(list) {
  const out = [];
  for (const { node } of walk(list)) if (node.type === 'entry') out.push(node);
  return out;
}

// Keyboard order: pinned, then today (current space)
function orderedEntries() {
  const space = activeSpace();
  return [...entriesIn(space.pinned), ...entriesIn(space.today)];
}

function entryTitle(entry) {
  if (entry.customTitle) return entry.customTitle;
  const tab = live.get(entry.id);
  return (tab && tab.title) || entry.title || U.hostOf(entry.url);
}

const { pageKey, hslHex, paletteFromColor } = require('./tab-helpers');

// Pinned tabs and favorites keep a home page; has this one browsed away from it?
function isWandered(entry) {
  const tab = live.get(entry.id);
  if (!tab || !tab.url || !tab.homeLanded || !entry.url || U.isNewTabUrl(entry.url)) return false;
  const now = pageKey(tab.url);
  return now !== pageKey(tab.homeLanded) && now !== pageKey(entry.url);
}

function resetToHome(id) {
  const entry = findEntry(id);
  if (!entry) return;
  const tab = live.get(id);
  if (activeEntryId !== id) showEntry(id);
  if (!tab) return;
  tab.homeLanded = null;
  loadInTab(tab, entry.url);
}

// Make the page a pinned tab has wandered to its new home
function rehome(id) {
  const entry = findEntry(id);
  const tab = live.get(id);
  if (!entry || !tab || !tab.url) return;
  entry.url = tab.url;
  if (tab.favicon) entry.favicon = tab.favicon;
  tab.homeLanded = tab.url;
  ctx.sidebar.render();
  save();
}

function entryFavicon(entry) {
  const tab = live.get(entry.id);
  return (tab && tab.favicon) || entry.favicon;
}

function removeFromList(loc) {
  loc.list.splice(loc.list.indexOf(loc.node), 1);
  if (loc.parent && loc.parent.type === 'split') fixSplit(loc.parent);
}

// A split with one pane left turns back into a normal tab
function fixSplit(split) {
  if (split.children.length > 1) return;
  const loc = locate(split.id);
  if (!loc) return;
  const i = loc.list.indexOf(split);
  loc.list.splice(i, 1, ...split.children);
}

/* ------------------------------------------------------------------ */
/* Live tabs                                                           */
/* ------------------------------------------------------------------ */

function ensureLive(entry) {
  if (live.has(entry.id)) return live.get(entry.id);

  let tab;
  if (entry.kind === 'web') {
    const webview = document.createElement('webview');
    webview.setAttribute('allowpopups', '');
    // Private windows and isolated Spaces get their own cookie jar
    const partition = partitionFor(entry.id);
    if (partition) webview.setAttribute('partition', partition);
    webview.setAttribute('src', entry.url);
    webview.dataset.entryId = entry.id;
    tab = {
      entryId: entry.id,
      kind: 'web',
      view: webview,
      webview,
      url: entry.url,
      title: entry.title,
      favicon: entry.favicon,
      loading: true,
      ready: false,
      blocked: 0,
      webContentsId: null,
      audible: false,
      mediaPlaying: false,
      muted: false,
    };
    bindWebviewEvents(tab);
    ctx.page.bindTab(tab);
    ctx.reader.bindTab(tab);
    ctx.passwords.bindTab(tab);
    ctx.autofill.bindTab(tab);
    ctx.highlights.bindTab(tab);
  } else {
    const view = ctx.internal.createView(entry);
    tab = {
      entryId: entry.id,
      kind: entry.kind,
      view,
      webview: null,
      url: entry.url,
      title: entry.title,
      favicon: null,
      loading: false,
      ready: true,
      blocked: 0,
    };
    view.addEventListener('mousedown', () => focusPane(entry.id));
  }
  tab.view.classList.add('tab-view');
  live.set(entry.id, tab);
  container().appendChild(tab.view);
  return tab;
}

function partitionFor(entryId) {
  if (U.PRIVATE_PARTITION) return U.PRIVATE_PARTITION;
  const loc = locate(entryId);
  return loc && loc.space && loc.space.isolated ? `persist:space-${loc.space.id}` : null;
}

function unload(entryId) {
  const tab = live.get(entryId);
  if (!tab) return;
  live.delete(entryId);
  tab.view.remove();
  if (tab.errorEl) tab.errorEl.remove();
  if (tab.readerEl) ctx.reader.close(tab);
  if (tab.pdfEl) ctx.pdfAnnotate.close(tab, { force: true });
  ctx.media.forget(tab);
}

/* ------------------------------------------------------------------ */
/* Showing tabs                                                        */
/* ------------------------------------------------------------------ */

function showEntry(id, { focus = true } = {}) {
  const loc = locate(id);
  if (!loc || loc.node.type !== 'entry') return;

  // Switching to a tab in another space switches the space too
  if (loc.space && loc.space.id !== activeSpaceId) {
    activeSpaceId = loc.space.id;
    applyTheme(loc.space);
    U.setSpaceEngine(loc.space.searchEngine);
  }
  if (loc.node.unread) loc.node.unread = false;

  const group = loc.parent && loc.parent.type === 'split' ? loc.parent.children : [loc.node];
  const ids = group.map((e) => e.id);
  for (const e of group) {
    ensureLive(e);
    e.lastActive = Date.now();
  }

  activeEntryId = id;
  activeSpace().activeEntryId = id;
  layout(ids);

  if (focus) {
    const tab = live.get(id);
    if (tab && tab.kind === 'web') tab.webview.focus();
  }

  ctx.sidebar.render();
  ctx.nav.update(true);
  save();
}

function layout(ids) {
  const leaving = displayed.filter((id) => !ids.includes(id));
  ctx.media.onHide(leaving.map((id) => live.get(id)).filter(Boolean));

  const n = ids.length;
  const split = n > 1;
  container().classList.toggle('split', split);

  for (const tab of live.values()) {
    const i = ids.indexOf(tab.entryId);
    const visible = i !== -1;
    // A page that wasn't on screen fades in instead of popping
    if (visible && !displayed.includes(tab.entryId)) {
      tab.view.classList.remove('view-enter');
      void tab.view.offsetWidth;
      tab.view.classList.add('view-enter');
      setTimeout(() => tab.view.classList.remove('view-enter'), 260);
    }
    tab.view.classList.toggle('active', visible);
    if (visible && split) {
      tab.view.style.width = `calc((100% - ${(n - 1) * SPLIT_GAP}px) / ${n})`;
      tab.view.style.left = `calc(${i} * ((100% - ${(n - 1) * SPLIT_GAP}px) / ${n} + ${SPLIT_GAP}px))`;
    } else {
      tab.view.style.width = '';
      tab.view.style.left = '';
    }
  }

  displayed = ids;
  ctx.media.onShow(ids.map((id) => live.get(id)).filter(Boolean));
  updatePaneRing();
  ctx.page.syncOverlays();
}

// Highlight the focused pane in a split
function updatePaneRing() {
  let ring = U.$('pane-ring');
  if (!ring) {
    ring = U.el('div');
    ring.id = 'pane-ring';
    container().appendChild(ring);
  }
  const n = displayed.length;
  const i = displayed.indexOf(activeEntryId);
  ring.hidden = n < 2 || i === -1;
  if (!ring.hidden) {
    ring.style.width = `calc((100% - ${(n - 1) * SPLIT_GAP}px) / ${n})`;
    ring.style.left = `calc(${i} * ((100% - ${(n - 1) * SPLIT_GAP}px) / ${n} + ${SPLIT_GAP}px))`;
  }
}

// Clicking into another pane of a split makes it the active tab
function focusPane(entryId) {
  if (!displayed.includes(entryId) || activeEntryId === entryId) return;
  activeEntryId = entryId;
  activeSpace().activeEntryId = entryId;
  const entry = findEntry(entryId);
  if (entry) entry.lastActive = Date.now();
  updatePaneRing();
  ctx.sidebar.render();
  ctx.nav.update(true);
}

function activeTab() {
  return live.get(activeEntryId) || null;
}

/* ------------------------------------------------------------------ */
/* Opening & closing                                                   */
/* ------------------------------------------------------------------ */

function openTab(url = U.NEWTAB_URL, opts = {}) {
  const { activate = true, kind = 'web', refId = null, title, favicon, spaceId = activeSpaceId, index = 0 } = opts;
  const space = getSpace(spaceId) || activeSpace();
  const entry = newEntry({ url, title, favicon, kind, refId });
  space.today.splice(index, 0, entry);
  if (activate) {
    showEntry(entry.id);
    if (kind === 'web' && U.isNewTabUrl(url)) ctx.nav.focusUrl();
  } else {
    ensureLive(entry);
    ctx.sidebar.render();
  }
  save();
  return entry;
}

function navigateActive(input) {
  const url = U.resolveInput(input);
  const tab = activeTab();
  if (!url) return;
  if (!tab || tab.kind !== 'web') {
    openTab(url);
    return;
  }
  loadInTab(tab, url);
}

function loadInTab(tab, url) {
  tab.url = url;
  if (tab.ready) {
    // ERR_ABORTED just means the previous load was superseded — not an error
    tab.webview.loadURL(url).catch((err) => {
      if (err.code !== 'ERR_ABORTED') console.error(err);
    });
  } else {
    tab.webview.src = url;
  }
  tab.webview.focus();
  ctx.nav.update(true);
}

function archiveEntry(entry, spaceId) {
  if (entry.kind === 'web' && U.isNewTabUrl(entry.url)) return;
  const tab = live.get(entry.id);
  archive.unshift({
    id: U.uid(),
    url: (tab && tab.url) || entry.url,
    title: entryTitle(entry),
    favicon: entryFavicon(entry),
    kind: entry.kind,
    refId: entry.refId,
    archivedAt: Date.now(),
    spaceId,
  });
  if (archive.length > ARCHIVE_LIMIT) archive.length = ARCHIVE_LIMIT;
}

function closeEntry(id) {
  const loc = locate(id);
  if (!loc || loc.node.type !== 'entry') return;
  const wasDisplayed = displayed.includes(id);
  const order = orderedEntries().map((e) => e.id);
  const orderIndex = order.indexOf(id);

  if (loc.section === 'today') {
    archiveEntry(loc.node, loc.space.id);
    removeFromList(loc);
  }
  // Favorites and pinned tabs stay in the sidebar; closing just unloads them
  unload(id);

  if (wasDisplayed) {
    const remaining = displayed.filter((d) => d !== id && live.has(d));
    if (remaining.length) {
      showEntry(remaining[0]);
    } else {
      const next = orderedEntries().filter((e) => e.id !== id);
      const candidate = next[Math.min(Math.max(orderIndex, 0), next.length - 1)];
      const space = activeSpace();
      if (space.today.length === 0 || !candidate) openTab();
      else showEntry(candidate.id);
    }
  }
  ctx.sidebar.render();
  save();
}

function closeActive() {
  if (activeEntryId) closeEntry(activeEntryId);
}

function reopenClosed() {
  const item = archive.shift();
  if (!item) {
    U.toast('Nothing to reopen');
    return;
  }
  restoreArchived(item);
}

function restoreArchived(item) {
  archive = archive.filter((a) => a !== item);
  openTab(item.url, { kind: item.kind, refId: item.refId, title: item.title, favicon: item.favicon });
  save();
}

function cycle(step) {
  const order = orderedEntries();
  if (order.length < 2) return;
  const i = order.findIndex((e) => e.id === activeEntryId);
  showEntry(order[(i + step + order.length) % order.length].id);
}

function selectByNumber(n) {
  const order = orderedEntries();
  const target = n === 9 ? order[order.length - 1] : order[n - 1];
  if (target) showEntry(target.id);
}

function duplicate(id) {
  const entry = findEntry(id);
  if (!entry) return;
  const tab = live.get(id);
  openTab((tab && tab.url) || entry.url, { kind: entry.kind, refId: entry.refId });
}

/* ------------------------------------------------------------------ */
/* Pinning, favorites, folders                                         */
/* ------------------------------------------------------------------ */

function togglePin(id = activeEntryId) {
  const loc = locate(id);
  if (!loc || loc.node.type !== 'entry') return;
  if (loc.section === 'today') {
    removeFromList(loc);
    loc.space.pinned.push(loc.node);
    U.toast('Pinned');
  } else if (loc.section === 'pinned') {
    removeFromList(loc);
    loc.space.today.unshift(loc.node);
    U.toast('Unpinned');
  } else {
    return;
  }
  refreshAfterMove(id);
}

function isFavorite(id) {
  return favorites.some((f) => f.id === id);
}

function toggleFavorite(id = activeEntryId) {
  const loc = locate(id);
  if (!loc || loc.node.type !== 'entry' || loc.node.kind !== 'web') return;
  if (loc.section === 'fav') {
    removeFromList(loc);
    activeSpace().today.unshift(loc.node);
  } else {
    removeFromList(loc);
    favorites.push(loc.node);
  }
  refreshAfterMove(id);
}

function refreshAfterMove(id) {
  // The entry may have left a split; re-show so the layout matches
  if (displayed.includes(id)) showEntry(activeEntryId === id ? id : activeEntryId, { focus: false });
  ctx.sidebar.render();
  ctx.nav.update();
  save();
}

async function createFolder(section = 'pinned', withEntryId = null) {
  const name = await U.dialog({ title: 'New folder', placeholder: 'Folder name', confirmLabel: 'Create' });
  if (!name) return;
  const space = activeSpace();
  const folder = { type: 'folder', id: U.uid(), name, open: true, children: [] };
  space[section].unshift(folder);
  if (withEntryId) {
    const loc = locate(withEntryId);
    if (loc && loc.node.type === 'entry') {
      removeFromList(loc);
      folder.children.push(loc.node);
    }
  }
  ctx.sidebar.render();
  save();
}

async function renameFolder(id) {
  const loc = locate(id);
  if (!loc) return;
  const name = await U.dialog({ title: 'Rename folder', value: loc.node.name, confirmLabel: 'Rename' });
  if (!name) return;
  loc.node.name = name;
  ctx.sidebar.render();
  save();
}

function deleteFolder(id) {
  const loc = locate(id);
  if (!loc || loc.node.type !== 'folder') return;
  loc.list.splice(loc.list.indexOf(loc.node), 1, ...loc.node.children);
  ctx.sidebar.render();
  save();
}

function toggleFolder(id) {
  const loc = locate(id);
  if (!loc) return;
  loc.node.open = !loc.node.open;
  ctx.sidebar.render();
  save();
}

async function renameEntry(id) {
  const entry = findEntry(id);
  if (!entry) return;
  const name = await U.dialog({ title: 'Rename tab', value: entryTitle(entry), confirmLabel: 'Rename', message: 'Leave empty to use the page title.' });
  if (name === null) return;
  entry.customTitle = name || null;
  ctx.sidebar.render();
  save();
}

function clearToday() {
  const space = activeSpace();
  for (const entry of entriesIn(space.today)) {
    archiveEntry(entry, space.id);
    unload(entry.id);
  }
  space.today = [];
  const firstPinned = entriesIn(space.pinned)[0];
  if (firstPinned) showEntry(firstPinned.id);
  else openTab();
  ctx.sidebar.render();
  save();
  U.toast('Today’s tabs archived', { action: () => ctx.library.open('archive'), actionLabel: 'View' });
}

// Imported bookmarks become a collapsed pinned folder in the current space
function importBookmarks(sourceName, bookmarks) {
  const seen = new Set();
  const children = [];
  for (const b of bookmarks || []) {
    if (!b.url || seen.has(b.url) || children.length >= 400) continue;
    seen.add(b.url);
    children.push(newEntry({ url: b.url, title: b.title, favicon: `https://icons.duckduckgo.com/ip3/${U.hostOf(b.url)}.ico` }));
  }
  if (!children.length) return 0;
  activeSpace().pinned.push({ type: 'folder', id: U.uid(), name: `${sourceName} bookmarks`, open: false, children });
  ctx.sidebar.render();
  save();
  return children.length;
}

/* ------------------------------------------------------------------ */
/* Split view                                                          */
/* ------------------------------------------------------------------ */

// Splits only live in the today section; pinned/favorite tabs get a today copy
function todayEntryFor(id) {
  const loc = locate(id);
  if (!loc) return null;
  if (loc.section === 'today') return loc.node;
  const tab = live.get(id);
  const copy = newEntry({ url: (tab && tab.url) || loc.node.url, title: entryTitle(loc.node), favicon: entryFavicon(loc.node), kind: loc.node.kind, refId: loc.node.refId });
  activeSpace().today.unshift(copy);
  return copy;
}

// Is this tab already in a full split? (Checked before todayEntryFor, so a full split
// doesn't leave stray today copies of pinned/favorite tabs behind)
function splitFull(id) {
  const loc = locate(id);
  if (!loc || !loc.parent || loc.parent.type !== 'split' || loc.parent.children.length < SPLIT_MAX) return false;
  U.toast(`A split view holds up to ${SPLIT_MAX} tabs`);
  return true;
}

function splitWith(baseId, otherId) {
  if (splitFull(baseId)) return;
  const base = todayEntryFor(baseId);
  const other = todayEntryFor(otherId);
  if (!base || !other || base.id === other.id) return;

  const baseLoc = locate(base.id);
  let split = baseLoc.parent && baseLoc.parent.type === 'split' ? baseLoc.parent : null;

  const otherLoc = locate(other.id);
  removeFromList(otherLoc);

  if (!split) {
    const loc = locate(base.id);
    split = { type: 'split', id: U.uid(), children: [] };
    loc.list.splice(loc.list.indexOf(base), 1, split);
    split.children.push(base);
  }
  split.children.push(other);
  showEntry(other.id);
}

function splitWithUrl(url) {
  if (!activeEntryId || splitFull(activeEntryId)) return;
  const entry = newEntry({ url });
  activeSpace().today.unshift(entry);
  splitWith(activeEntryId, entry.id);
  if (U.isNewTabUrl(url)) ctx.nav.focusUrl();
}

function splitActiveWithNewTab() {
  splitWithUrl(U.NEWTAB_URL);
}

function unsplit(splitId) {
  const loc = locate(splitId);
  if (!loc || loc.node.type !== 'split') return;
  loc.list.splice(loc.list.indexOf(loc.node), 1, ...loc.node.children);
  if (activeEntryId) showEntry(activeEntryId, { focus: false });
  save();
}

function splitOf(id) {
  const loc = locate(id);
  return loc && loc.parent && loc.parent.type === 'split' ? loc.parent : null;
}

/* ------------------------------------------------------------------ */
/* Drag & drop moves                                                   */
/* ------------------------------------------------------------------ */

// target: { section: 'fav'|'pinned'|'today', spaceId, parentId (folder/split) | null, index }
function moveNode(nodeId, target) {
  const loc = locate(nodeId);
  if (!loc) return;
  const node = loc.node;

  if (target.section === 'fav' && (node.type !== 'entry' || node.kind !== 'web')) return;
  if (target.section === 'pinned' && node.type === 'split') return;
  if (target.parentId) {
    const parentLoc = locate(target.parentId);
    if (!parentLoc || node.type !== 'entry') return;
    if (parentLoc.node.type === 'split' && parentLoc.node.children.length >= SPLIT_MAX && loc.parent !== parentLoc.node) return;
  }
  if (node.id === target.parentId) return;

  // Resolve the destination list before removing, then adjust the index
  const destList = () => {
    if (target.parentId) return locate(target.parentId).node.children;
    if (target.section === 'fav') return favorites;
    return getSpace(target.spaceId)[target.section];
  };
  let list = destList();
  let index = target.index == null ? list.length : target.index;
  if (loc.list === list && loc.list.indexOf(node) < index) index--;

  removeFromList(loc);
  list = destList(); // a split may have dissolved
  list.splice(Math.max(0, Math.min(index, list.length)), 0, node);

  if (node.type === 'entry' && displayed.includes(node.id)) showEntry(activeEntryId, { focus: false });
  else if (node.type === 'entry' && activeEntryId === node.id) showEntry(node.id, { focus: false });
  ctx.sidebar.render();
  ctx.nav.update();
  save();
}

/* ------------------------------------------------------------------ */
/* Spaces                                                              */
/* ------------------------------------------------------------------ */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

// The palette for a space: its custom color if it has one, else its preset
function themeFor(space) {
  if (space.color) return paletteFromColor(space.color);
  const index = space.theme || 0;
  return THEMES[((index % THEMES.length) + THEMES.length) % THEMES.length];
}

function applyTheme(space) {
  const base = themeFor(space);
  // Main sets nativeTheme from the Appearance setting, so this media query reflects it
  const dark = darkQuery.matches || U.PRIVATE;
  document.body.classList.toggle('dark', dark);
  const theme = dark ? base.dark : base;
  const root = document.documentElement.style;
  root.setProperty('--tint-a', theme.a);
  root.setProperty('--tint-b', theme.b);
  root.setProperty('--tint-c', theme.c);
  root.setProperty('--accent', theme.accent);
  root.setProperty('--accent-soft', theme.accent + '29');
}

function switchSpace(id) {
  const space = getSpace(id);
  if (!space) return;
  // Slide the sidebar in from the side the new space sits on
  const from = spaces.findIndex((s) => s.id === activeSpaceId);
  document.body.dataset.spaceDir = spaces.indexOf(space) < from ? 'prev' : 'next';
  activeSpaceId = id;
  applyTheme(space);
  U.setSpaceEngine(space.searchEngine);

  const remembered = space.activeEntryId && locate(space.activeEntryId);
  const usable = remembered && remembered.node.type === 'entry' && (remembered.section === 'fav' || remembered.space === space);
  if (usable) {
    showEntry(space.activeEntryId);
  } else {
    const first = entriesIn(space.today)[0] || entriesIn(space.pinned)[0];
    if (first) showEntry(first.id);
    else openTab();
  }
  document.body.classList.remove('space-anim');
  void document.body.offsetWidth;
  document.body.classList.add('space-anim');
  save();
}

function switchSpaceByNumber(n) {
  const space = spaces[n - 1];
  if (space) switchSpace(space.id);
}

async function addSpace() {
  const name = await U.dialog({ title: 'New space', placeholder: 'e.g. Work, Personal, Research', confirmLabel: 'Create' });
  if (!name) return;
  const space = newSpace(name, spaces.length % THEMES.length);
  spaces.push(space);
  switchSpace(space.id);
}

async function renameSpace(id) {
  const space = getSpace(id);
  if (!space) return;
  const name = await U.dialog({ title: 'Rename space', value: space.name, confirmLabel: 'Rename' });
  if (!name) return;
  space.name = name;
  ctx.sidebar.render();
  save();
}

async function deleteSpace(id) {
  if (spaces.length < 2) {
    U.toast('You need at least one space');
    return;
  }
  const space = getSpace(id);
  const ok = await U.dialog({
    title: `Delete “${space.name}”?`,
    message: 'Its tabs are moved to the archive. Pinned tabs and folders are removed.',
    confirmLabel: 'Delete',
    danger: true,
    input: false,
  });
  if (!ok) return;
  for (const entry of [...entriesIn(space.today), ...entriesIn(space.pinned)]) {
    archiveEntry(entry, space.id);
    unload(entry.id);
  }
  spaces = spaces.filter((s) => s !== space);
  if (activeSpaceId === id) switchSpace(spaces[0].id);
  ctx.sidebar.render();
  save();
}

function setSpaceTheme(id, theme) {
  const space = getSpace(id);
  if (!space) return;
  space.theme = theme;
  space.color = null;
  if (id === activeSpaceId) applyTheme(space);
  ctx.sidebar.render();
  save();
}

// color: { h, s, i }. With preview, only repaint the window (used while dragging).
function setSpaceColor(id, color, { preview = false } = {}) {
  const space = getSpace(id);
  if (!space) return;
  space.color = { ...color };
  if (id === activeSpaceId) applyTheme(space);
  if (preview) return;
  ctx.sidebar.render();
  save();
}

// Reorder spaces (drag in the spaces bar, or Move left/right); ⌃1–9 follow this order
function moveSpace(id, toIndex) {
  const from = spaces.findIndex((s) => s.id === id);
  if (from === -1) return;
  const [space] = spaces.splice(from, 1);
  spaces.splice(Math.max(0, Math.min(toIndex, spaces.length)), 0, space);
  ctx.sidebar.render();
  save();
}

// An emoji shown instead of the space's first letter (null = use the letter)
function setSpaceIcon(id, icon) {
  const space = getSpace(id);
  if (!space) return;
  space.icon = icon || null;
  ctx.sidebar.render();
  save();
}

function setSpaceSearchEngine(id, key) {
  const space = getSpace(id);
  if (!space) return;
  space.searchEngine = key || null;
  if (id === activeSpaceId) U.setSpaceEngine(space.searchEngine);
  save();
  U.toast(key ? `${space.name} searches with ${U.SEARCH_ENGINES[key].name}` : `${space.name} uses your default search engine`);
}

// Separate logins: the Space's tabs get their own cookies/storage (reloads its open tabs)
function toggleSpaceIsolation(id) {
  const space = getSpace(id);
  if (!space || U.PRIVATE) return;
  space.isolated = !space.isolated;
  for (const entry of [...entriesIn(space.pinned), ...entriesIn(space.today)]) unload(entry.id);
  save();
  if (id === activeSpaceId) switchSpace(id);
  else ctx.sidebar.render();
  U.toast(space.isolated ? `${space.name} now has its own logins` : `${space.name} now shares logins with other spaces`);
}

function moveToSpace(entryId, spaceId) {
  const loc = locate(entryId);
  const space = getSpace(spaceId);
  if (!loc || !space || loc.node.type !== 'entry') return;
  removeFromList(loc);
  space.today.unshift(loc.node);
  if (displayed.includes(entryId)) {
    unload(entryId);
    const first = orderedEntries()[0];
    if (first) showEntry(first.id);
    else openTab();
  }
  ctx.sidebar.render();
  save();
  U.toast(`Moved to ${space.name}`, { action: () => showEntry(entryId), actionLabel: 'Go' });
}

/* ------------------------------------------------------------------ */
/* Auto-archive                                                        */
/* ------------------------------------------------------------------ */

// Unused tabs unload to save memory; they reload when clicked
function hibernate() {
  const minutes = ctx.settings.get('hibernateMinutes');
  if (!minutes) return;
  const cutoff = Date.now() - minutes * 60 * 1000;
  let changed = false;
  for (const tab of [...live.values()]) {
    if (displayed.includes(tab.entryId) || tab.kind !== 'web') continue;
    if (tab.audible || tab.mediaPlaying || tab.loading) continue;
    const entry = findEntry(tab.entryId);
    if (entry && entry.lastActive < cutoff) {
      unload(tab.entryId);
      changed = true;
    }
  }
  if (changed) ctx.sidebar.render();
}

// Thumbnails for sidebar hover previews
async function captureThumb(tab) {
  if (!tab || tab.kind !== 'web' || !tab.ready || !displayed.includes(tab.entryId)) return;
  try {
    const image = await tab.webview.capturePage();
    // 720px wide (sharp on Retina at preview size); JPEG keeps the many open-tab thumbnails light
    if (!image.isEmpty()) tab.thumb = `data:image/jpeg;base64,${image.resize({ width: 720, quality: 'better' }).toJPEG(82).toString('base64')}`;
  } catch { /* not paintable right now */ }
}

function sweepArchive() {
  const hours = ctx.settings.get('archiveAfterHours');
  for (const id of displayed) {
    const entry = findEntry(id);
    if (entry) entry.lastActive = Date.now();
  }
  hibernate();
  if (!hours) return;
  const cutoff = Date.now() - hours * 3600 * 1000;
  let changed = false;

  for (const space of spaces) {
    // Like hibernate: a tab playing audio or media isn't stale, however long ago it was visited
    const playing = (e) => {
      const tab = live.get(e.id);
      return !!tab && (tab.audible || tab.mediaPlaying);
    };
    const stale = (e) => !displayed.includes(e.id) && e.lastActive < cutoff && !playing(e);
    const keep = [];
    for (const node of space.today) {
      if (node.type === 'entry' && stale(node)) {
        archiveEntry(node, space.id);
        unload(node.id);
        changed = true;
      } else if (node.type === 'split' && node.children.every(stale)) {
        node.children.forEach((e) => { archiveEntry(e, space.id); unload(e.id); });
        changed = true;
      } else {
        if (node.type === 'folder') {
          node.children = node.children.filter((e) => {
            if (!stale(e)) return true;
            archiveEntry(e, space.id);
            unload(e.id);
            changed = true;
            return false;
          });
        }
        keep.push(node);
      }
    }
    space.today = keep;
  }
  if (changed) {
    ctx.sidebar.render();
    save();
  }
}

/* ------------------------------------------------------------------ */
/* Webview events                                                      */
/* ------------------------------------------------------------------ */

function bindWebviewEvents(tab) {
  const wv = tab.webview;
  const isActive = () => tab.entryId === activeEntryId;
  const entry = () => findEntry(tab.entryId);
  const updateRow = () => ctx.sidebar.updateEntry(tab.entryId);

  wv.addEventListener('dom-ready', async () => {
    ctx.boosts.apply(tab);
    if (tab.ready) return;
    tab.ready = true;
    tab.webContentsId = wv.getWebContentsId();
    try {
      const { count } = await ipcRenderer.invoke('get-blocked', tab.webContentsId);
      tab.blocked = count;
    } catch { /* counts will arrive via updates */ }
    if (isActive()) ctx.nav.update();
  });

  wv.addEventListener('focus', () => focusPane(tab.entryId));

  wv.addEventListener('did-start-loading', () => {
    tab.loading = true;
    updateRow();
    if (isActive()) ctx.nav.update();
  });

  wv.addEventListener('did-stop-loading', () => {
    tab.loading = false;
    setTimeout(() => captureThumb(tab), 900);
    updateRow();
    if (isActive()) ctx.nav.update();
  });

  wv.addEventListener('did-navigate', (e) => {
    // Where the tab settled after loading its home URL (after any redirects)
    if (!tab.homeLanded) tab.homeLanded = e.url;
    tab.url = e.url;
    tab.favicon = null;
    if (U.isNewTabUrl(e.url)) tab.title = 'New Tab';
    const loc = locate(tab.entryId);
    // Today tabs remember where they are; pinned/favorites keep their home URL
    if (loc && loc.section === 'today') {
      loc.node.url = e.url;
      save();
    }
    updateRow();
    ctx.library.addHistory(tab);
    if (isActive()) ctx.nav.update(true);
  });

  wv.addEventListener('did-navigate-in-page', (e) => {
    if (!e.isMainFrame) return;
    tab.url = e.url;
    const loc = locate(tab.entryId);
    if (loc && loc.section === 'today') {
      loc.node.url = e.url;
      save();
    }
    ctx.library.addHistory(tab);
    if (isActive()) ctx.nav.update(true);
  });

  wv.addEventListener('page-title-updated', (e) => {
    tab.title = U.isNewTabUrl(tab.url) ? 'New Tab' : e.title || U.hostOf(tab.url);
    const node = entry();
    if (node && locate(node.id).section === 'today') {
      node.title = tab.title;
      save();
    }
    updateRow();
    ctx.library.updateHistory(tab);
    if (isActive()) ctx.nav.update();
  });

  wv.addEventListener('page-favicon-updated', (e) => {
    tab.favicon = e.favicons && e.favicons[0] ? e.favicons[0] : null;
    const node = entry();
    if (node && tab.favicon && (!node.favicon || locate(node.id).section === 'today')) {
      node.favicon = tab.favicon;
      save();
    }
    updateRow();
    ctx.library.updateHistory(tab);
  });

  wv.addEventListener('did-fail-load', (e) => {
    // -3 = ERR_ABORTED (user stopped / navigated away) — not a real failure
    if (!e.isMainFrame || e.errorCode === -3) return;
    tab.title = `Can't reach ${U.hostOf(e.validatedURL)}`;
    tab.loading = false;
    updateRow();
  });

  wv.addEventListener('media-started-playing', () => ctx.media.setPlaying(tab, true));
  wv.addEventListener('media-paused', () => ctx.media.setPlaying(tab, false));
}

ipcRenderer.on('blocked-update', (_e, { webContentsId, count, total }) => {
  ctx.nav.setBlockedTotal(total);
  for (const tab of live.values()) {
    if (tab.webContentsId === webContentsId) {
      tab.blocked = count;
      if (tab.entryId === activeEntryId) ctx.nav.updateShields();
    }
  }
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function boot() {
  darkQuery.addEventListener('change', () => applyTheme(activeSpace()));
  load();
  const space = activeSpace();
  applyTheme(space);
  switchSpace(space.id);
  setInterval(sweepArchive, 60 * 1000);
  setInterval(() => displayed.forEach((id) => captureThumb(live.get(id))), 10000);
}

ctx.tabs = {
  THEMES,
  isWandered,
  resetToHome,
  rehome,
  themeFor,
  captureThumb,
  boot,
  save,
  // state
  get spaces() { return spaces; },
  get favorites() { return favorites; },
  get archive() { return archive; },
  set archive(value) { archive = value; save(); },
  get activeSpaceId() { return activeSpaceId; },
  get activeEntryId() { return activeEntryId; },
  get displayed() { return displayed; },
  live,
  activeSpace,
  getSpace,
  locate,
  findEntry,
  entriesIn,
  orderedEntries,
  entryTitle,
  entryFavicon,
  activeTab,
  // actions
  openTab,
  showEntry,
  closeEntry,
  closeActive,
  reopenClosed,
  restoreArchived,
  navigateActive,
  loadInTab,
  cycle,
  selectByNumber,
  duplicate,
  unload,
  togglePin,
  isFavorite,
  toggleFavorite,
  createFolder,
  renameFolder,
  deleteFolder,
  toggleFolder,
  setSpaceColor,
  renameEntry,
  clearToday,
  importBookmarks,
  splitWith,
  splitWithUrl,
  splitActiveWithNewTab,
  unsplit,
  splitOf,
  moveNode,
  switchSpace,
  switchSpaceByNumber,
  addSpace,
  renameSpace,
  deleteSpace,
  setSpaceTheme,
  moveSpace,
  setSpaceIcon,
  moveToSpace,
  setSpaceSearchEngine,
  hibernate,
  toggleSpaceIsolation,
  partitionFor,
  newEntry,
  applyTheme,
};
