// Bookmarks: a classic folder tree of saved pages, separate from favorites and pinned tabs.
// Shown in Library → Bookmarks; filled by the importer, bookmarks.html files, the command
// bar ("Bookmark this page") and right-clicking the star in the address bar.
//
//   Folder   { type: 'folder', id, title, added, open, children: (Folder|Bookmark)[] }
//   Bookmark { type: 'bookmark', id, title, url, favicon, added }
// The root is a folder with id 'root' (shown as the top level, never as a row).

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');
const BookmarksHtml = require('./bookmarks-html');

const T = () => ctx.tabs;
const KEY = 'browser.bookmarkTree'; // not 'browser.bookmarks': that old key is migrated into favorites
const DRAG_TYPE = 'text/x-surf-bookmark';

let root = U.store.get(KEY, null);
if (!root || root.type !== 'folder') root = { type: 'folder', id: 'root', title: 'Bookmarks', children: [] };
let urls = new Set(); // every bookmarked address, for quick "is this page bookmarked?" checks
const indexUrls = () => { urls = new Set([...walk(root)].filter((n) => n.type === 'bookmark').map((n) => n.url)); };
indexUrls();

function save() {
  indexUrls();
  U.store.set(KEY, root);
  if (ctx.library.isOpen()) ctx.library.refresh();
  ctx.nav.update();
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

function* walk(folder) {
  for (const node of folder.children) {
    yield node;
    if (node.type === 'folder') yield* walk(node);
  }
}

// { node, parent } for an id (the root has no parent)
function find(id, folder = root) {
  if (id === 'root') return { node: root, parent: null };
  for (const node of folder.children) {
    if (node.id === id) return { node, parent: folder };
    if (node.type === 'folder') {
      const hit = find(id, node);
      if (hit) return hit;
    }
  }
  return null;
}

const faviconFor = (url) => `https://icons.duckduckgo.com/ip3/${U.hostOf(url)}.ico`;
const isBookmarked = (url) => !!url && urls.has(url);
const bookmarkFor = (url) => [...walk(root)].find((n) => n.type === 'bookmark' && n.url === url) || null;

function newBookmark({ title, url, favicon, added }) {
  return { type: 'bookmark', id: U.uid(), title: title || U.hostOf(url) || url, url, favicon: favicon || faviconFor(url), added: added || Date.now() };
}
function newFolder(title) {
  return { type: 'folder', id: U.uid(), title, added: Date.now(), open: true, children: [] };
}

function add(fields, folderId = 'root') {
  const target = (find(folderId) || find('root')).node;
  const bookmark = newBookmark(fields);
  target.children.push(bookmark);
  save();
  return bookmark;
}

function update(id, fields) {
  const hit = find(id);
  if (!hit) return;
  Object.assign(hit.node, fields);
  save();
}

// Is `id` the folder `folderId` or one of its ancestors? (A folder can't move into itself)
function contains(id, folderId) {
  const hit = find(id);
  return !!hit && hit.node.type === 'folder' && (id === folderId || !!find(folderId, hit.node));
}

// Move a node into a folder, optionally before a sibling
function move(id, folderId, beforeId = null) {
  if (id === beforeId || contains(id, folderId)) return;
  const hit = find(id);
  const target = find(folderId);
  if (!hit || !target || target.node.type !== 'folder') return;
  hit.parent.children.splice(hit.parent.children.indexOf(hit.node), 1);
  const at = beforeId ? target.node.children.findIndex((n) => n.id === beforeId) : -1;
  if (at === -1) target.node.children.push(hit.node);
  else target.node.children.splice(at, 0, hit.node);
  if (target.node.type === 'folder' && target.node.id !== 'root') target.node.open = true;
  save();
}

function remove(id) {
  const hit = find(id);
  if (!hit || !hit.parent) return;
  const index = hit.parent.children.indexOf(hit.node);
  hit.parent.children.splice(index, 1);
  save();
  const what = hit.node.type === 'folder' ? `folder “${hit.node.title}”` : `“${hit.node.title}”`;
  U.toast(`Deleted ${what}`, {
    actionLabel: 'Undo',
    action: () => {
      const parent = find(hit.parent.id) ? find(hit.parent.id).node : root;
      parent.children.splice(Math.min(index, parent.children.length), 0, hit.node);
      save();
    },
    duration: 6000,
  });
}

// Matching bookmarks anywhere, with the folder they're in
function search(query) {
  const out = [];
  const visit = (folder, path) => {
    for (const node of folder.children) {
      if (node.type === 'folder') visit(node, [...path, node.title]);
      else if (node.title.toLowerCase().includes(query) || node.url.toLowerCase().includes(query)) out.push({ node, path });
    }
  };
  visit(root, []);
  return out;
}

/* ------------------------------------------------------------------ */
/* Adding pages, importing                                             */
/* ------------------------------------------------------------------ */

function activePage() {
  const tab = T().activeTab();
  if (!tab || tab.kind !== 'web' || !/^https?:/i.test(tab.url || '')) return null;
  // Pages without an icon report "data:,"; only keep a real image
  return { title: tab.title, url: tab.url, favicon: /^(https?:|data:image\/)/.test(tab.favicon || '') ? tab.favicon : null };
}

// Bookmark the current page, or edit its bookmark if it already has one
async function addCurrent() {
  const page = activePage();
  if (!page) return U.toast('Open a web page to bookmark it');
  const existing = bookmarkFor(page.url);
  if (existing) return edit(existing.id);
  const bookmark = add(page);
  U.toast(`Bookmarked “${bookmark.title}”`, { actionLabel: 'Edit', action: () => edit(bookmark.id), duration: 5000 });
}

// Imported bookmarks (Settings → Import) go in a folder named after the browser, keeping
// their folders. Importing again adds only what's new.
function importItems(sourceName, items) {
  const top = root.children.find((n) => n.type === 'folder' && n.title === `${sourceName} bookmarks`) || newFolder(`${sourceName} bookmarks`);
  if (!root.children.includes(top)) root.children.push(top);
  top.open = false;
  const known = new Set([...walk(top)].filter((n) => n.type === 'bookmark').map((n) => n.url));
  let added = 0;
  for (const item of items || []) {
    if (!item.url || !/^https?:/i.test(item.url) || known.has(item.url)) continue;
    known.add(item.url);
    let folder = top;
    for (const name of item.folder || []) {
      let next = folder.children.find((n) => n.type === 'folder' && n.title === name);
      if (!next) {
        next = Object.assign(newFolder(name), { open: false });
        folder.children.push(next);
      }
      folder = next;
    }
    folder.children.push(newBookmark({ title: item.title, url: item.url, added: item.added }));
    added++;
  }
  if (!top.children.length) root.children.splice(root.children.indexOf(top), 1);
  save();
  return added;
}

/* ------------------------------------------------------------------ */
/* bookmarks.html (Netscape bookmark file)                              */
/* ------------------------------------------------------------------ */

// Building and reading the file is pure (src/bookmarks-html.js), so it can be tested without a window
const toNetscape = () => BookmarksHtml.toNetscape(root);
const fromNetscape = (html) => BookmarksHtml.fromNetscape(html, { newFolder, newBookmark });

async function exportFile() {
  const file = await ipcRenderer.invoke('bookmarks-export', toNetscape());
  if (file) U.toast(`Exported ${urls.size} bookmark${urls.size === 1 ? '' : 's'}`, { actionLabel: 'Show', action: () => ipcRenderer.send('download-action', { action: 'show', savePath: file }) });
}

async function importFile() {
  const result = await ipcRenderer.invoke('bookmarks-import-file');
  if (!result) return;
  if (result.error) return U.toast(result.error);
  const { children, count } = fromNetscape(result.html);
  if (!count) return U.toast('No bookmarks found in that file');
  const folder = Object.assign(newFolder(`Imported ${new Date().toLocaleDateString()}`), { children });
  root.children.push(folder);
  save();
  U.toast(`Imported ${count} bookmark${count === 1 ? '' : 's'} from ${result.name}`, { duration: 5000 });
}

/* ------------------------------------------------------------------ */
/* Editing                                                             */
/* ------------------------------------------------------------------ */

function folderOptions(skipId = null) {
  const out = [['root', 'Bookmarks']];
  const visit = (folder, depth) => {
    for (const node of folder.children) {
      if (node.type !== 'folder' || node.id === skipId) continue;
      out.push([node.id, `${'\u00a0\u00a0\u00a0'.repeat(depth)}${node.title}`]);
      visit(node, depth + 1);
    }
  };
  visit(root, 1);
  return out;
}

// Title, address and folder in one dialog (U.dialog only has one field)
function edit(id) {
  const hit = find(id);
  if (!hit || !hit.parent) return Promise.resolve(false);
  const { node } = hit;
  const isFolder = node.type === 'folder';
  return new Promise((resolve) => {
    const backdrop = U.el('div', 'dialog-backdrop');
    const box = U.el('form', 'dialog');
    box.appendChild(U.el('h3', null, isFolder ? 'Edit folder' : 'Edit bookmark'));
    const titleInput = U.el('input', 'dialog-input');
    titleInput.value = node.title;
    titleInput.placeholder = 'Name';
    titleInput.spellcheck = false;
    box.appendChild(titleInput);
    let urlInput = null;
    if (!isFolder) {
      urlInput = U.el('input', 'dialog-input');
      urlInput.value = node.url;
      urlInput.placeholder = 'https://…';
      urlInput.spellcheck = false;
      box.appendChild(urlInput);
    }
    const folderSelect = U.el('select', 'settings-select bm-folder-select');
    for (const [value, label] of folderOptions(isFolder ? node.id : null)) {
      if (isFolder && contains(node.id, value)) continue;
      const o = U.el('option', null, label);
      o.value = value;
      o.selected = value === hit.parent.id;
      folderSelect.appendChild(o);
    }
    box.appendChild(folderSelect);
    const actions = U.el('div', 'dialog-actions');
    const cancel = U.el('button', 'btn', 'Cancel');
    cancel.type = 'button';
    const ok = U.el('button', 'btn primary', 'Save');
    ok.type = 'submit';
    actions.append(cancel, ok);
    box.appendChild(actions);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    const finish = (saved) => {
      release();
      U.removeAnimated(backdrop);
      resolve(saved);
    };
    const release = U.pushEscape(() => finish(false));
    cancel.addEventListener('click', () => finish(false));
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) finish(false); });
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      const fields = { title: titleInput.value.trim() || node.title };
      if (urlInput) {
        const url = U.resolveInput(urlInput.value);
        if (!url || !/^https?:/i.test(url)) return U.toast('Enter a web address (https://…)');
        if (url !== node.url) Object.assign(fields, { url, favicon: faviconFor(url) });
      }
      Object.assign(node, fields);
      if (folderSelect.value !== hit.parent.id) move(node.id, folderSelect.value);
      else save();
      finish(true);
    });
    requestAnimationFrame(() => { titleInput.focus(); titleInput.select(); });
  });
}

async function createFolder(parentId = 'root') {
  const title = await U.dialog({ title: 'New folder', placeholder: 'Folder name', confirmLabel: 'Create' });
  if (!title) return;
  const parent = (find(parentId) || find('root')).node;
  parent.children.push(newFolder(title));
  if (parent.id !== 'root') parent.open = true;
  save();
}

async function renameFolder(id) {
  const hit = find(id);
  if (!hit) return;
  const title = await U.dialog({ title: 'Rename folder', value: hit.node.title, confirmLabel: 'Rename' });
  if (!title) return;
  update(id, { title });
}

/* ------------------------------------------------------------------ */
/* Library tab                                                         */
/* ------------------------------------------------------------------ */

function openBookmark(node, e = {}) {
  if (e.metaKey || e.ctrlKey) {
    T().openTab(node.url, { activate: false });
    return U.toast('Opened in background');
  }
  T().navigateActive(node.url);
  ctx.library.close();
}

function openInNewTab(node) {
  T().openTab(node.url);
  ctx.library.close();
}

function bookmarkMenu(node, x, y) {
  U.contextMenu([
    { label: 'Open', icon: 'arrow', action: () => openBookmark(node) },
    { label: 'Open in New Tab', icon: 'plus', action: () => openInNewTab(node) },
    { label: 'Open in Split View', icon: 'split', action: () => { T().splitWithUrl(node.url); ctx.library.close(); } },
    { separator: true },
    { label: 'Edit…', icon: 'edit', action: () => edit(node.id) },
    { label: 'Copy Link', icon: 'link', action: () => { ipcRenderer.send('copy-text', node.url); U.toast('Copied'); } },
    { separator: true },
    { label: 'Delete', icon: 'trash', danger: true, action: () => remove(node.id) },
  ], x, y);
}

function folderMenu(node, x, y) {
  const links = node.children.filter((n) => n.type === 'bookmark');
  U.contextMenu([
    { label: `Open ${links.length} in New Tabs`, icon: 'layers', disabled: !links.length, action: () => { links.forEach((b) => T().openTab(b.url, { activate: false })); U.toast(`Opened ${links.length} tab${links.length === 1 ? '' : 's'}`); } },
    { label: 'New Folder Inside…', icon: 'folder', action: () => createFolder(node.id) },
    { separator: true },
    { label: 'Rename…', icon: 'edit', action: () => renameFolder(node.id) },
    { label: 'Delete Folder', icon: 'trash', danger: true, action: () => remove(node.id) },
  ], x, y);
}

// Rows are drag sources and drop targets: drop on a folder to move into it,
// on a bookmark to put it just before that one
function makeDraggable(row, node) {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData(DRAG_TYPE, node.id);
    if (node.type === 'bookmark') {
      e.dataTransfer.setData('text/uri-list', node.url);
      e.dataTransfer.setData('text/plain', node.url);
    }
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('bm-dragging');
  });
  row.addEventListener('dragend', () => row.classList.remove('bm-dragging'));
  row.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add(node.type === 'folder' ? 'bm-drop-into' : 'bm-drop-before');
  });
  row.addEventListener('dragleave', () => row.classList.remove('bm-drop-into', 'bm-drop-before'));
  row.addEventListener('drop', (e) => {
    const id = e.dataTransfer.getData(DRAG_TYPE);
    row.classList.remove('bm-drop-into', 'bm-drop-before');
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    if (node.type === 'folder') move(id, node.id);
    else move(id, find(node.id).parent.id, node.id);
  });
}

function bookmarkRow(node, depth, sub) {
  const row = U.el('div', 'lib-item bm-row');
  row.style.paddingLeft = `${10 + depth * 18}px`;
  const iconWrap = U.el('span', 'h-icon');
  iconWrap.appendChild(U.iconElement(node.favicon, U.ICONS.globe));
  const text = U.el('div', 'h-text');
  text.append(U.el('span', 'h-title', node.title), U.el('span', 'h-url', sub || U.compactUrl(node.url)));
  const btns = U.el('span', 'lib-actions');
  btns.appendChild(U.iconButton('plus', 'Open in new tab', (e) => { e.stopPropagation(); openInNewTab(node); }, 'h-delete'));
  btns.appendChild(U.iconButton('edit', 'Edit', (e) => { e.stopPropagation(); edit(node.id); }, 'h-delete'));
  btns.appendChild(U.iconButton('trash', 'Delete', (e) => { e.stopPropagation(); remove(node.id); }, 'h-delete'));
  row.append(iconWrap, text, btns);
  row.title = node.url;
  row.addEventListener('click', (e) => openBookmark(node, e));
  row.addEventListener('auxclick', (e) => { if (e.button === 1) openBookmark(node, { metaKey: true }); });
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); bookmarkMenu(node, e.clientX, e.clientY); });
  makeDraggable(row, node);
  return row;
}

function folderRow(node, depth) {
  const row = U.el('div', 'lib-item bm-row bm-folder' + (node.open ? ' open' : ''));
  row.style.paddingLeft = `${4 + depth * 18}px`;
  const chevron = U.el('span', 'bm-chevron');
  chevron.appendChild(U.icon('chevronRight'));
  const iconWrap = U.el('span', 'h-icon');
  iconWrap.appendChild(U.icon(node.open ? 'folderOpen' : 'folder'));
  const text = U.el('div', 'h-text');
  text.appendChild(U.el('span', 'h-title', node.title));
  const count = U.el('span', 'h-time', String(node.children.length));
  const btns = U.el('span', 'lib-actions');
  btns.appendChild(U.iconButton('edit', 'Rename', (e) => { e.stopPropagation(); renameFolder(node.id); }, 'h-delete'));
  btns.appendChild(U.iconButton('trash', 'Delete folder', (e) => { e.stopPropagation(); remove(node.id); }, 'h-delete'));
  row.append(chevron, iconWrap, text, count, btns);
  row.addEventListener('click', () => {
    node.open = !node.open;
    save();
  });
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); folderMenu(node, e.clientX, e.clientY); });
  makeDraggable(row, node);
  return row;
}

function renderTree(list, folder, depth) {
  for (const node of folder.children) {
    if (node.type === 'folder') {
      list.appendChild(folderRow(node, depth));
      if (node.open) {
        if (!node.children.length) {
          const hint = U.el('div', 'bm-empty-folder', 'Empty — drag bookmarks here');
          hint.style.paddingLeft = `${46 + depth * 18}px`;
          list.appendChild(hint);
        }
        renderTree(list, node, depth + 1);
      }
    } else {
      list.appendChild(bookmarkRow(node, depth));
    }
  }
}

function toolbar() {
  const bar = U.el('div', 'bm-toolbar');
  const addBtn = U.el('button', 'chip');
  addBtn.append(U.icon('star'), document.createTextNode(' Bookmark this page'));
  addBtn.disabled = !activePage();
  addBtn.addEventListener('click', addCurrent);
  const folderBtn = U.el('button', 'chip');
  folderBtn.append(U.icon('folder'), document.createTextNode(' New folder'));
  folderBtn.addEventListener('click', () => createFolder());
  const spacer = U.el('div', 'bm-toolbar-spacer');
  const more = U.iconButton('more', 'Import or export bookmarks.html', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    U.contextMenu([
      { label: 'Import bookmarks.html…', icon: 'download', action: importFile },
      { label: 'Export bookmarks.html…', icon: 'share', disabled: !urls.size, action: exportFile },
      { separator: true },
      { label: 'Import from another browser…', icon: 'globe', action: () => { ctx.library.close(); ctx.settings.open('import'); } },
    ], r.left, r.bottom + 4);
  }, 'icon-btn small');
  bar.append(addBtn, folderBtn, spacer, more);
  return bar;
}

function render(list, query) {
  list.appendChild(toolbar());
  if (query) {
    const hits = search(query);
    if (!hits.length) return list.appendChild(U.el('div', 'history-empty', 'No matching bookmarks.'));
    for (const { node, path } of hits.slice(0, 400)) {
      list.appendChild(bookmarkRow(node, 0, `${U.compactUrl(node.url)}${path.length ? ` · ${path.join(' › ')}` : ''}`));
    }
    return;
  }
  if (!root.children.length) {
    return list.appendChild(U.el('div', 'history-empty', `No bookmarks yet. Bookmark the page you’re on with the button above, by right-clicking the ★ in the address bar, or with ${ctx.shortcuts.tip('“Bookmark this page” in the command bar', 'new-tab')}.`));
  }
  const tree = U.el('div', 'bm-tree');
  renderTree(tree, root, 0);
  // Dropping on empty space moves to the top level
  tree.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault();
  });
  tree.addEventListener('drop', (e) => {
    const id = e.dataTransfer.getData(DRAG_TYPE);
    if (id) {
      e.preventDefault();
      move(id, 'root');
    }
  });
  list.appendChild(tree);
}

function setup() {
  // The star keeps adding favorites on click; right-click it for bookmarks
  U.$('bookmark-btn').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const tab = T().activeTab();
    const page = activePage();
    if (!tab || !page) return;
    const isFav = T().isFavorite(tab.entryId);
    const existing = bookmarkFor(page.url);
    U.contextMenu([
      { label: isFav ? 'Remove from Favorites' : 'Add to Favorites', icon: 'star', action: () => { T().toggleFavorite(tab.entryId); U.toast(isFav ? 'Removed from favorites' : 'Added to favorites'); } },
      { separator: true },
      existing
        ? { label: 'Edit Bookmark…', icon: 'edit', action: () => edit(existing.id) }
        : { label: 'Bookmark This Page', icon: 'folder', hint: ctx.shortcuts.label('bookmark-page'), action: addCurrent },
      existing && { label: 'Remove Bookmark', icon: 'trash', danger: true, action: () => remove(existing.id) },
      { label: 'Show Bookmarks', icon: 'layers', action: () => ctx.library.open('bookmarks') },
    ], e.clientX, e.clientY);
  });
}

ctx.bookmarks = {
  setup, render, addCurrent, importItems, isBookmarked, bookmarkFor, edit, remove, move, add, createFolder,
  toNetscape, fromNetscape, importFile, exportFile,
  root: () => root,
};
