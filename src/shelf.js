// Shelf: a tray above the sidebar's bottom bar that collects finished downloads,
// screenshots, and anything dropped on it (tabs, links, images, text). Items can be
// dragged back out — files into Finder, links into the sidebar or another app.

const { ipcRenderer, webUtils } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const KEY = 'browser.shelf';
const LIMIT = 40;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic)$/i;
const TEXT_MAX = 10000;
// Only web and mail links go on the shelf (clicking one opens it in a tab)
const LINK_RE = /^(https?:\/\/|mailto:)/i;

// { id, kind: 'file' | 'link' | 'text', title, path?, url?, text?, favicon?, time }
let items = U.store.get(KEY, []);
let unseen = 0;

const shelfEl = () => U.$('shelf');
const isOpen = () => document.body.classList.contains('shelf-open');
const save = () => U.store.set(KEY, items.slice(0, LIMIT));

/* ------------------------------------------------------------------ */
/* Adding                                                              */
/* ------------------------------------------------------------------ */

function add(item, { reveal = false } = {}) {
  // The same file or link only sits on the shelf once; re-adding moves it to the front
  items = items.filter((x) => !(item.path && x.path === item.path) && !(item.url && x.url === item.url && x.kind === item.kind));
  items.unshift({ id: U.uid(), time: Date.now(), ...item });
  if (items.length > LIMIT) items.length = LIMIT;
  save();
  if (!isOpen()) unseen += 1;
  render(items[0].id);
  if (reveal) bounce();
}

function addFile(file, title) {
  if (!file) return;
  add({ kind: 'file', path: file, title: title || file.split('/').pop() }, { reveal: true });
}

function addFromDrop(dt) {
  const files = [...(dt.files || [])].map((f) => webUtils.getPathForFile(f)).filter(Boolean);
  if (files.length) {
    files.forEach((f) => add({ kind: 'file', path: f, title: f.split('/').pop() }));
    return true;
  }
  const uri = ((dt.getData('text/uri-list') || '').split('\n').find((l) => l && !l.startsWith('#')) || '').trim();
  if (LINK_RE.test(uri)) {
    const nodeId = dt.getData('text/x-browser-node');
    const entry = nodeId && ctx.tabs.findEntry(nodeId);
    const title = entry ? ctx.tabs.entryTitle(entry) : U.hostOf(uri) || uri;
    add({ kind: 'link', url: uri, title, favicon: entry ? ctx.tabs.entryFavicon(entry) : null });
    return true;
  }
  const text = (dt.getData('text/plain') || '').trim().slice(0, TEXT_MAX);
  if (!text) return false;
  const url = U.looksLikeUrl(text) && !/\s/.test(text) ? U.resolveInput(text) : null;
  if (url && LINK_RE.test(url)) add({ kind: 'link', url, title: U.hostOf(url) || text });
  else add({ kind: 'text', text, title: text.slice(0, 80) });
  return true;
}

function remove(id) {
  const card = U.$('shelf-items').querySelector(`[data-id="${id}"]`);
  const drop = () => {
    items = items.filter((x) => x.id !== id);
    save();
    render();
  };
  if (!card) return drop();
  card.classList.add('leaving');
  setTimeout(drop, 160);
}

function clear() {
  items = [];
  save();
  render();
}

/* ------------------------------------------------------------------ */
/* Acting on items                                                     */
/* ------------------------------------------------------------------ */

function openItem(item) {
  if (item.kind === 'file') ipcRenderer.send('download-action', { action: 'open', savePath: item.path });
  else if (item.kind === 'link') ctx.tabs.openTab(item.url);
  else copy(item);
}

function copy(item) {
  ipcRenderer.send('copy-text', item.kind === 'file' ? item.path : item.url || item.text);
  U.toast(item.kind === 'text' ? 'Copied text' : item.kind === 'link' ? 'Copied URL' : 'Copied file path');
}

function itemMenu(item, x, y) {
  U.contextMenu([
    { header: item.title },
    { label: item.kind === 'text' ? 'Copy text' : 'Open', icon: item.kind === 'text' ? 'copy' : 'arrow', action: () => openItem(item) },
    item.kind === 'file' && { label: 'Show in folder', icon: 'folder', action: () => ipcRenderer.send('download-action', { action: 'show', savePath: item.path }) },
    item.kind === 'link' && { label: 'Peek', icon: 'eye', action: () => ctx.peek.open(item.url) },
    item.kind !== 'text' && { label: item.kind === 'file' ? 'Copy path' : 'Copy URL', icon: 'link', action: () => copy(item) },
    { separator: true },
    { label: 'Remove from shelf', icon: 'close', danger: true, action: () => remove(item.id) },
  ].filter(Boolean), x, y);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function thumbFor(item) {
  const wrap = U.el('div', 'shelf-thumb ' + item.kind);
  if (item.kind === 'file' && IMAGE_RE.test(item.path)) {
    const img = U.el('img');
    img.src = `file://${encodeURI(item.path)}`;
    img.draggable = false;
    img.addEventListener('error', () => img.replaceWith(U.icon('file')));
    wrap.appendChild(img);
  } else if (item.kind === 'file') {
    wrap.appendChild(U.icon('file'));
    const ext = (item.path.match(/\.([a-z0-9]{1,5})$/i) || [])[1];
    if (ext) wrap.appendChild(U.el('span', 'shelf-ext', ext.toUpperCase()));
  } else if (item.kind === 'link') {
    wrap.appendChild(U.iconElement(item.favicon, U.ICONS.globe));
  } else {
    wrap.appendChild(U.el('span', 'shelf-quote', item.text.slice(0, 60)));
  }
  return wrap;
}

function card(item, fresh) {
  const node = U.el('div', 'shelf-item' + (fresh ? ' entering' : ''));
  node.dataset.id = item.id;
  node.draggable = true;
  node.title = item.kind === 'file' ? item.path : item.url || item.text;
  node.append(thumbFor(item), U.el('span', 'shelf-label', item.title));

  const x = U.iconButton('close', 'Remove', (e) => {
    e.stopPropagation();
    remove(item.id);
  }, 'shelf-remove');
  node.appendChild(x);

  node.addEventListener('click', () => openItem(item));
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    itemMenu(item, e.clientX, e.clientY);
  });
  node.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    if (item.kind === 'file') {
      e.preventDefault();
      ipcRenderer.send('shelf-drag-file', item.path);
      return;
    }
    e.dataTransfer.effectAllowed = 'copy';
    if (item.kind === 'link') e.dataTransfer.setData('text/uri-list', item.url);
    e.dataTransfer.setData('text/plain', item.url || item.text);
  });
  return node;
}

function render(freshId = null) {
  const list = U.$('shelf-items');
  list.replaceChildren();
  if (!items.length) {
    const empty = U.el('div', 'shelf-empty');
    empty.append(U.icon('download'), U.el('span', null, 'Drop files, links or text here. Downloads and screenshots land here too.'));
    list.appendChild(empty);
  }
  items.forEach((item) => list.appendChild(card(item, item.id === freshId)));
  U.$('shelf-count').textContent = items.length ? String(items.length) : '';
  U.$('shelf-clear').hidden = !items.length;
  const badge = U.$('shelf-badge');
  badge.hidden = !unseen || isOpen();
  badge.textContent = unseen > 9 ? '9+' : String(unseen);
}

// Downloads in progress, above the items: name, bar, speed and time left
function renderDownloads() {
  const box = U.$('shelf-downloads');
  if (!box) return;
  const active = ctx.library.downloads().filter((d) => d.state === 'progressing' || (d.state === 'interrupted' && d.canResume));
  box.hidden = !active.length;
  const L = ctx.library;
  // Same downloads with the same buttons: just move the numbers (see library.js)
  if (box.children.length === active.length && active.every((d) => L.patchDownloadRow(box, d))) return;
  box.replaceChildren(...active.map((d) => {
    const row = U.el('div', 'shelf-dl');
    Object.assign(row.dataset, { dl: d.id, shape: L.downloadShape(d), short: '1' });
    const text = U.el('div', 'shelf-dl-text');
    text.append(U.el('span', 'shelf-dl-name', d.filename), U.el('span', 'shelf-dl-status dl-status', L.downloadStatus(d, { short: true })));
    const bar = U.el('div', 'progress');
    const fill = U.el('div', 'progress-fill');
    fill.style.width = d.total ? `${(d.received / d.total) * 100}%` : '30%';
    bar.appendChild(fill);
    text.appendChild(bar);
    row.append(text, ...L.downloadControls(d, 'h-delete'));
    row.title = d.url;
    row.addEventListener('click', (e) => { if (!e.target.closest('button')) L.open('downloads'); });
    return row;
  }));
}

/* ------------------------------------------------------------------ */
/* Open / close                                                        */
/* ------------------------------------------------------------------ */

function setOpen(open) {
  document.body.classList.toggle('shelf-open', open);
  U.$('shelf-btn').classList.toggle('active', open);
  if (open) unseen = 0;
  render();
}

const toggle = () => setOpen(!isOpen());

// Nudge the shelf button so a new arrival is noticed without opening anything
function bounce() {
  const btn = U.$('shelf-btn');
  btn.classList.remove('bounce');
  void btn.offsetWidth;
  btn.classList.add('bounce');
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

function setup() {
  const progress = U.el('div', null);
  progress.id = 'shelf-downloads';
  U.$('shelf-items').before(progress);
  renderDownloads();
  U.$('shelf-btn').addEventListener('click', toggle);
  U.$('shelf-close').addEventListener('click', () => setOpen(false));
  U.$('shelf-clear').addEventListener('click', clear);

  // Dropping onto the shelf, or onto its button (which opens it while you hover)
  let hoverTimer = null;
  const accepts = (e) => !e.target.closest('.shelf-item') || e.dataTransfer.types.includes('text/x-browser-node');
  for (const el of [shelfEl(), U.$('shelf-btn')]) {
    el.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      shelfEl().classList.add('drop-target');
      if (el.id === 'shelf-btn' && !isOpen() && !hoverTimer) hoverTimer = setTimeout(() => setOpen(true), 450);
    });
    el.addEventListener('dragleave', (e) => {
      if (el.contains(e.relatedTarget)) return;
      shelfEl().classList.remove('drop-target');
      clearTimeout(hoverTimer);
      hoverTimer = null;
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      shelfEl().classList.remove('drop-target');
      clearTimeout(hoverTimer);
      hoverTimer = null;
      if (addFromDrop(e.dataTransfer) && !isOpen()) setOpen(true);
    });
  }

  // Files that were moved or deleted since last time fall off the shelf
  // (by id: items may be added or removed while we wait)
  const checked = items.slice();
  Promise.all(checked.map((x) => (x.kind === 'file' ? ipcRenderer.invoke('shelf-file-exists', x.path) : true))).then((exists) => {
    const gone = new Set(checked.filter((_, i) => !exists[i]).map((x) => x.id));
    const before = items.length;
    items = items.filter((x) => !gone.has(x.id));
    if (items.length !== before) save();
    render();
  });
  render();
}

ctx.shelf = { setup, add, addFile, toggle, setOpen, renderDownloads };
