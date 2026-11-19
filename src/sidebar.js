// Sidebar rendering: favorites grid, pinned + today lists (folders, splits),
// spaces switcher, context menus and drag & drop.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const T = () => ctx.tabs;
const rowEls = new Map(); // entryId -> row element
let dragging = null; // node id being dragged
let renderPending = false;
// Rows that weren't there last render get an enter animation (not on first paint or a space switch)
let seenIds = new Set();
let prevIds = null;
let renderedSpaceId = null;
let renderedActiveId = null;
let activatedNow = false; // the active tab changed since the last render
let spaceChanged = false; // the active space changed since the last render

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function render() {
  if (dragging) {
    renderPending = true;
    return;
  }
  rowEls.clear();
  const spaceId = T().activeSpaceId;
  prevIds = renderedSpaceId === spaceId ? seenIds : null;
  spaceChanged = renderedSpaceId !== null && renderedSpaceId !== spaceId;
  renderedSpaceId = spaceId;
  activatedNow = T().activeEntryId !== renderedActiveId;
  renderedActiveId = T().activeEntryId;
  seenIds = new Set();
  renderFavorites();
  renderSection('pinned');
  renderSection('today');
  renderSpaces();
  renderSpaceTitle();
}

// First letter (or emoji) of a space's name, for its badge
function spaceGlyph(space) {
  return [...(space.name || '?').trim()][0]?.toUpperCase() || '?';
}

function renderSpaceTitle() {
  const space = T().activeSpace();
  const title = U.$('space-title');
  const badge = U.el('span', 'space-badge', spaceGlyph(space));
  const more = U.iconButton('more', 'Space options', (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    spaceMenu(space, r.left, r.bottom + 4);
  }, 'space-more');
  title.replaceChildren(badge, U.el('span', 'space-name', space.name), more);
}

function entryIconNode(entry, tab) {
  if (tab && tab.loading && tab.kind === 'web' && !U.isNewTabUrl(tab.url)) return U.el('div', 'spinner');
  if (entry.kind === 'note') return U.icon('note');
  if (entry.kind === 'easel') return U.icon('easel');
  const url = (tab && tab.url) || entry.url;
  if (U.isNewTabUrl(url)) return U.icon('grid');
  return U.iconElement(T().entryFavicon(entry), U.ICONS.globe);
}

function fillEntryRow(row, entry) {
  const tab = T().live.get(entry.id);
  const isActive = entry.id === T().activeEntryId;
  row.replaceChildren();
  row.classList.toggle('active', isActive);
  row.classList.toggle('displayed', T().displayed.includes(entry.id));
  row.classList.toggle('unloaded', !tab);

  const iconWrap = U.el('span', 'row-icon');
  iconWrap.appendChild(entryIconNode(entry, tab));
  const title = U.el('span', 'row-title', T().entryTitle(entry));
  row.classList.toggle('unread', !!entry.unread);
  row.title = `${T().entryTitle(entry)}\n${U.displayUrl((tab && tab.url) || entry.url)}`;
  row.append(iconWrap, title);

  if (tab && (tab.audible || tab.muted)) {
    const audio = U.iconButton(tab.muted ? 'mute' : 'volume', tab.muted ? 'Unmute tab' : 'Mute tab', (e) => {
      e.stopPropagation();
      ctx.media.toggleMute(tab);
    }, 'row-audio');
    row.appendChild(audio);
  }

  const close = U.iconButton('close', 'Close tab', (e) => {
    e.stopPropagation();
    closeWithAnimation(row, entry.id);
  }, 'row-close');
  row.appendChild(close);
}

// Collapse the row out, then close the tab. Pinned tabs only unload, so they stay put.
function closeWithAnimation(row, entryId) {
  if (row.dataset.section !== 'today') return T().closeEntry(entryId);
  if (row.classList.contains('row-leave')) return;
  row.style.height = `${row.offsetHeight}px`;
  row.classList.add('row-leave');
  setTimeout(() => T().closeEntry(entryId), 160);
}

function entryRow(entry, section, parent, index) {
  const row = U.el('div', 'row entry-row');
  row.dataset.id = entry.id;
  row.dataset.section = section;
  row.dataset.parentId = parent ? parent.id : '';
  row.dataset.index = index;
  row.draggable = true;
  fillEntryRow(row, entry);
  seenIds.add(entry.id);
  if (prevIds && !prevIds.has(entry.id)) row.classList.add('row-enter');
  else if (activatedNow && entry.id === T().activeEntryId) row.classList.add('just-activated');

  row.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('button')) T().showEntry(entry.id);
  });
  row.addEventListener('auxclick', (e) => {
    if (e.button === 1) closeWithAnimation(row, entry.id);
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    entryMenu(entry, e.clientX, e.clientY);
  });
  row.addEventListener('mouseenter', () => schedulePreview(entry.id, row));
  row.addEventListener('mouseleave', softHidePreview);
  rowEls.set(entry.id, row);
  return row;
}

/* ------------------------------------------------------------------ */
/* Pinned tabs: square tiles that glow in their site's color           */
/* ------------------------------------------------------------------ */

function fillPinnedTile(tile, entry) {
  const tab = T().live.get(entry.id);
  const wandered = T().isWandered(entry);
  tile.replaceChildren();
  tile.classList.toggle('active', entry.id === T().activeEntryId);
  tile.classList.toggle('displayed', T().displayed.includes(entry.id));
  tile.classList.toggle('unloaded', !tab);
  tile.classList.toggle('wandered', wandered);
  tile.classList.toggle('unread', !!entry.unread);
  // Glow with the pinned site's own icon, even while browsing elsewhere in the tab
  ctx.siteColor.apply(tile, entry.favicon || T().entryFavicon(entry));

  const icon = U.el('span', 'tile-icon');
  icon.appendChild(entryIconNode(entry, tab));
  tile.appendChild(icon);
  tile.title = wandered
    ? `${T().entryTitle(entry)}\nNow on ${U.displayUrl(tab.url)} — click ↩ to go back`
    : `${T().entryTitle(entry)}\n${U.displayUrl((tab && tab.url) || entry.url)}`;

  if (tab && (tab.audible || tab.muted)) {
    tile.appendChild(U.iconButton(tab.muted ? 'mute' : 'volume', tab.muted ? 'Unmute tab' : 'Mute tab', (e) => {
      e.stopPropagation();
      ctx.media.toggleMute(tab);
    }, 'tile-badge tile-audio'));
  } else if (wandered) {
    tile.appendChild(U.iconButton('undo', `Back to ${U.displayUrl(entry.url)}`, (e) => {
      e.stopPropagation();
      T().resetToHome(entry.id);
    }, 'tile-badge tile-reset'));
  }
}

function pinnedTile(entry, index) {
  const tile = U.el('div', 'pinned-tile');
  tile.dataset.id = entry.id;
  tile.dataset.section = 'pinned';
  tile.dataset.parentId = '';
  tile.dataset.index = index;
  tile.draggable = true;
  tile.setAttribute('role', 'button');
  fillPinnedTile(tile, entry);
  seenIds.add(entry.id);
  if (prevIds && !prevIds.has(entry.id)) tile.classList.add('fav-enter');

  tile.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('button')) T().showEntry(entry.id);
  });
  tile.addEventListener('auxclick', (e) => {
    if (e.button === 1) T().closeEntry(entry.id);
  });
  tile.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    entryMenu(entry, e.clientX, e.clientY);
  });
  tile.addEventListener('mouseenter', () => schedulePreview(entry.id, tile));
  tile.addEventListener('mouseleave', softHidePreview);
  rowEls.set(entry.id, tile);
  return tile;
}

/* ------------------------------------------------------------------ */
/* Tab hover previews                                                  */
/* ------------------------------------------------------------------ */

let previewTimer = null;
let previewHideTimer = null;
function schedulePreview(entryId, row) {
  clearTimeout(previewTimer);
  clearTimeout(previewHideTimer);
  if (dragging || entryId === T().activeEntryId) return softHidePreview();
  // Once a preview is up, moving to the next row swaps it right away (and glides)
  const warm = !U.$('tab-preview').hidden;
  previewTimer = setTimeout(() => showPreview(entryId, row), warm ? 60 : 550);
}

function softHidePreview() {
  clearTimeout(previewTimer);
  clearTimeout(previewHideTimer);
  previewHideTimer = setTimeout(hidePreview, 160);
}

function showPreview(entryId, row) {
  const entry = T().findEntry(entryId);
  if (!entry || !row.isConnected) return;
  const tab = T().live.get(entryId);
  const card = U.$('tab-preview');
  card.classList.toggle('glide', !card.hidden);
  card.replaceChildren();
  if (tab && tab.thumb) {
    const img = U.el('img');
    img.src = tab.thumb;
    card.appendChild(img);
  } else {
    const placeholder = U.el('div', 'tp-placeholder');
    placeholder.appendChild(entry.kind === 'web' ? U.iconElement(T().entryFavicon(entry), U.ICONS.globe) : U.icon(entry.kind));
    placeholder.appendChild(U.el('span', null, tab ? 'Loading…' : 'Asleep — click to load'));
    card.appendChild(placeholder);
  }
  const text = U.el('div', 'tp-text');
  text.append(U.el('div', 'tp-title', T().entryTitle(entry)), U.el('div', 'tp-url', U.compactUrl((tab && tab.url) || entry.url) || entry.kind));
  card.appendChild(text);
  const r = row.getBoundingClientRect();
  card.style.left = `${r.right + 10}px`;
  card.style.top = `${Math.max(8, Math.min(r.top - 20, window.innerHeight - 260))}px`;
  card.hidden = false;
}

function hidePreview() {
  clearTimeout(previewTimer);
  clearTimeout(previewHideTimer);
  const card = U.$('tab-preview');
  if (card) card.hidden = true;
}

let justOpenedFolder = null; // animate the children of a folder the user just expanded

function folderBlock(folder, section, index) {
  const wrap = U.el('div', 'folder' + (folder.open ? ' open' : '') + (folder.live ? ' live' : ''));
  const row = U.el('div', 'row folder-row');
  row.dataset.id = folder.id;
  row.dataset.section = section;
  row.dataset.parentId = '';
  row.dataset.index = index;
  row.dataset.folder = folder.id;
  row.draggable = true;

  const iconWrap = U.el('span', 'row-icon folder-icon');
  iconWrap.appendChild(U.icon(folder.live ? 'rss' : folder.open ? 'folderOpen' : 'folder'));
  row.append(iconWrap, U.el('span', 'row-title', folder.name));
  const unread = folder.children.filter((c) => c.unread).length;
  if (folder.live && unread) row.appendChild(U.el('span', 'row-count live', String(unread)));
  else if (!folder.open && folder.children.length) row.appendChild(U.el('span', 'row-count', String(folder.children.length)));
  const chevron = U.el('span', 'row-chevron');
  chevron.appendChild(U.icon('chevronRight'));
  row.appendChild(chevron);

  row.addEventListener('click', () => {
    if (folder.open) return collapseFolder(wrap, folder.id);
    justOpenedFolder = folder.id;
    T().toggleFolder(folder.id);
  });
  row.addEventListener('dblclick', () => T().renameFolder(folder.id));
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    U.contextMenu([
      { label: folder.open ? 'Collapse' : 'Expand', icon: 'chevronDown', action: () => T().toggleFolder(folder.id) },
      { label: 'Rename…', icon: 'edit', action: () => T().renameFolder(folder.id) },
      folder.live && { label: 'Refresh now', icon: 'reload', action: () => ctx.liveFolders.refresh(folder.id, true) },
      folder.live && { label: 'Mark all as read', icon: 'eye', action: () => ctx.liveFolders.markRead(folder.id) },
      { label: 'Share folder…', icon: 'share', action: () => shareMenu(folder.name, folder.children, e.clientX, e.clientY) },
      { separator: true },
      { label: 'Delete folder', icon: 'trash', danger: true, action: () => T().deleteFolder(folder.id) },
    ].filter(Boolean), e.clientX, e.clientY);
  });
  wrap.appendChild(row);

  if (folder.open) {
    const opening = justOpenedFolder === folder.id;
    const children = U.el('div', 'folder-children' + (opening ? ' opening' : ''));
    if (opening) justOpenedFolder = null;
    children.dataset.parentId = folder.id;
    folder.children.forEach((child, i) => children.appendChild(entryRow(child, section, folder, i)));
    if (!folder.children.length) children.appendChild(U.el('div', 'folder-empty', 'Drag tabs here'));
    wrap.appendChild(children);
    if (opening) requestAnimationFrame(() => growFolder(children));
  }
  return wrap;
}

// Grow the children from 0 to their natural height
function growFolder(children) {
  if (!children.isConnected) return;
  const h = children.scrollHeight;
  children.style.height = '0px';
  void children.offsetHeight;
  children.classList.add('resizing');
  children.style.height = `${h}px`;
  setTimeout(() => {
    children.classList.remove('resizing');
    children.style.height = '';
  }, 260);
}

// Shrink the children away, then actually close the folder
function collapseFolder(wrap, folderId) {
  const children = wrap.querySelector(':scope > .folder-children');
  // Already closing: the pending timer will close it (toggling now would reopen it after)
  if (wrap.classList.contains('closing')) return;
  if (!children || matchMedia('(prefers-reduced-motion: reduce)').matches) return T().toggleFolder(folderId);
  wrap.classList.add('closing');
  children.style.height = `${children.offsetHeight}px`;
  void children.offsetHeight;
  children.classList.add('resizing');
  children.style.height = '0px';
  setTimeout(() => T().toggleFolder(folderId), 220);
}

function splitBlock(split, section, index) {
  const row = U.el('div', 'row split-row');
  row.dataset.id = split.id;
  row.dataset.section = section;
  row.dataset.parentId = '';
  row.dataset.index = index;
  row.draggable = true;

  const isShown = split.children.some((c) => c.id === T().activeEntryId);
  row.classList.toggle('active', isShown);
  row.appendChild(U.icon('split'));

  split.children.forEach((child) => {
    const seg = U.el('div', 'split-seg' + (child.id === T().activeEntryId ? ' focused' : ''));
    seg.dataset.id = child.id;
    const iconWrap = U.el('span', 'row-icon');
    iconWrap.appendChild(entryIconNode(child, T().live.get(child.id)));
    seg.append(iconWrap, U.el('span', 'row-title', T().entryTitle(child)));
    seg.title = T().entryTitle(child);
    seg.addEventListener('mousedown', (e) => {
      if (e.button === 0) T().showEntry(child.id);
    });
    seg.addEventListener('auxclick', (e) => {
      if (e.button === 1) T().closeEntry(child.id);
    });
    seg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      entryMenu(child, e.clientX, e.clientY);
    });
    rowEls.set(child.id, seg);
    row.appendChild(seg);
  });

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    U.contextMenu([
      { label: 'Separate tabs', icon: 'split', action: () => T().unsplit(split.id) },
      { separator: true },
      { label: 'Close split view', icon: 'close', danger: true, action: () => [...split.children].forEach((c) => T().closeEntry(c.id)) },
    ], e.clientX, e.clientY);
  });
  return row;
}

function renderSection(section) {
  const space = T().activeSpace();
  const listEl = U.$(`${section}-list`);
  listEl.replaceChildren();
  listEl.dataset.section = section;
  const grid = section === 'pinned' ? U.el('div', 'pinned-grid') : null;
  if (grid) listEl.appendChild(grid);
  space[section].forEach((node, i) => {
    if (grid && node.type === 'entry') grid.appendChild(pinnedTile(node, i));
    else if (node.type === 'folder') listEl.appendChild(folderBlock(node, section, i));
    else if (node.type === 'split') listEl.appendChild(splitBlock(node, section, i));
    else listEl.appendChild(entryRow(node, section, null, i));
  });
  if (section === 'pinned') U.$('sidebar').classList.toggle('has-pinned', space.pinned.length > 0);
}

function renderFavorites() {
  const list = U.$('favorites-list');
  list.replaceChildren();
  T().favorites.forEach((fav, i) => {
    const tab = T().live.get(fav.id);
    const tile = U.el('button', 'favorite');
    tile.dataset.id = fav.id;
    tile.dataset.index = i;
    tile.draggable = true;
    seenIds.add(fav.id);
    if (prevIds && !prevIds.has(fav.id)) tile.classList.add('fav-enter');
    tile.classList.toggle('active', fav.id === T().activeEntryId);
    tile.classList.toggle('loaded', !!tab);
    tile.title = `${T().entryTitle(fav)}\n${fav.url}`;
    tile.appendChild(U.iconElement(T().entryFavicon(fav), U.ICONS.globe));
    ctx.siteColor.apply(tile, fav.favicon || T().entryFavicon(fav));
    if (tab && (tab.audible || tab.muted)) tile.appendChild(U.el('span', 'fav-audio'));

    tile.addEventListener('click', () => T().showEntry(fav.id));
    tile.addEventListener('auxclick', (e) => {
      if (e.button === 1) T().closeEntry(fav.id);
    });
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      entryMenu(fav, e.clientX, e.clientY);
    });
    rowEls.set(fav.id, tile);
    list.appendChild(tile);
  });
  U.$('favorites').classList.toggle('has-items', T().favorites.length > 0);
}

function renderSpaces() {
  const bar = U.$('spaces-bar');
  bar.replaceChildren();
  T().spaces.forEach((space, i) => {
    const isActive = space.id === T().activeSpaceId;
    const dot = U.el('button', 'space-dot' + (isActive ? ' active' : '') + (isActive && spaceChanged ? ' just-active' : ''));
    dot.style.setProperty('--dot', T().themeFor(space).accent);
    const mod = process.platform === 'darwin' ? '⌃' : 'Alt+';
    dot.title = `${space.name}${i < 9 ? `  (${mod}${i + 1})` : ''}`;
    dot.appendChild(U.el('span', null, spaceGlyph(space)));
    // Open the menu just above the bar so it doesn't cover the space buttons
    const openMenu = () => {
      const r = dot.getBoundingClientRect();
      spaceMenu(space, r.left, r.top - 6);
    };
    dot.addEventListener('click', () => {
      if (space.id === T().activeSpaceId) openMenu();
      else T().switchSpace(space.id);
    });
    dot.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu();
    });
    bar.appendChild(dot);
  });
}

// Cheap in-place refresh when a tab's title / favicon / loading state changes
function updateEntry(entryId) {
  const node = rowEls.get(entryId);
  const entry = T().findEntry(entryId);
  if (!node || !entry) return;
  if (node.classList.contains('pinned-tile')) {
    fillPinnedTile(node, entry);
  } else if (node.classList.contains('entry-row')) {
    fillEntryRow(node, entry);
  } else if (node.classList.contains('split-seg')) {
    const iconWrap = node.querySelector('.row-icon');
    iconWrap.replaceChildren(entryIconNode(entry, T().live.get(entryId)));
    node.querySelector('.row-title').textContent = T().entryTitle(entry);
  } else if (node.classList.contains('favorite')) {
    const tab = T().live.get(entryId);
    node.replaceChildren(U.iconElement(T().entryFavicon(entry), U.ICONS.globe));
    if (tab && (tab.audible || tab.muted)) node.appendChild(U.el('span', 'fav-audio'));
  }
}

/* ------------------------------------------------------------------ */
/* Context menus                                                       */
/* ------------------------------------------------------------------ */

function entryMenu(entry, x, y) {
  const loc = T().locate(entry.id);
  if (!loc) return;
  const tab = T().live.get(entry.id);
  const url = (tab && tab.url) || entry.url;
  const isWeb = entry.kind === 'web';
  const split = T().splitOf(entry.id);
  const otherSpaces = T().spaces.filter((s) => s.id !== T().activeSpaceId);
  const canSplit = entry.id !== T().activeEntryId && !T().displayed.includes(entry.id);

  U.contextMenu([
    loc.section === 'today' && { label: 'Pin tab', icon: 'pin', hint: '⌘D', action: () => T().togglePin(entry.id) },
    loc.section === 'pinned' && { label: 'Unpin tab', icon: 'pin', hint: '⌘D', action: () => T().togglePin(entry.id) },
    loc.section !== 'today' && T().isWandered(entry) && { label: 'Back to pinned page', icon: 'undo', action: () => T().resetToHome(entry.id) },
    loc.section !== 'today' && T().isWandered(entry) && { label: 'Pin this page instead', icon: 'pin', action: () => T().rehome(entry.id) },
    isWeb && { label: loc.section === 'fav' ? 'Remove from favorites' : 'Add to favorites', icon: 'star', action: () => T().toggleFavorite(entry.id) },
    canSplit && { label: 'Open in split view', icon: 'split', action: () => T().splitWith(T().activeEntryId, entry.id) },
    split && { label: 'Separate split view', icon: 'split', action: () => T().unsplit(split.id) },
    loc.section !== 'fav' && !split && { label: 'New folder with tab…', icon: 'folder', action: () => T().createFolder(loc.section, entry.id) },
    { separator: true },
    { label: 'Rename…', icon: 'edit', action: () => T().renameEntry(entry.id) },
    { label: 'Duplicate', icon: 'copy', action: () => T().duplicate(entry.id) },
    isWeb && !U.isNewTabUrl(url) && { label: 'Copy URL', icon: 'link', action: () => { ipcRenderer.send('copy-text', url); U.toast('Copied URL'); } },
    tab && isWeb && { label: tab.muted ? 'Unmute tab' : 'Mute tab', icon: tab.muted ? 'volume' : 'mute', action: () => ctx.media.toggleMute(tab) },
    tab && isWeb && { label: 'Reload', icon: 'reload', action: () => tab.webview.reload() },
    tab && loc.section !== 'today' && { label: 'Unload tab', icon: 'archive', action: () => T().closeEntry(entry.id) },
    otherSpaces.length && loc.section !== 'fav' && { separator: true },
    ...(loc.section !== 'fav' ? otherSpaces.map((s) => ({ label: `Move to ${s.name}`, icon: 'layers', action: () => T().moveToSpace(entry.id, s.id) })) : []),
    loc.section === 'today' && { separator: true },
    loc.section === 'today' && { label: 'Close tab', icon: 'close', hint: '⌘W', danger: true, action: () => T().closeEntry(entry.id) },
  ].filter(Boolean), x, y);
}

/* ------------------------------------------------------------------ */
/* Space color picker (lives inside the space menu)                    */
/* ------------------------------------------------------------------ */

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

// A preset expressed as a picker position, so the handle starts where the preset sits
function presetColor(index) {
  const theme = T().THEMES[(index || 0) % T().THEMES.length];
  const { h, s } = hexToHsl(theme.accent);
  return { h, s: Math.min(1, s), i: 0.6 };
}

const handleColor = (c) => `hsl(${c.h}, ${Math.round(15 + 70 * c.s)}%, ${Math.round(70 - 12 * c.s)}%)`;

function themePicker(space) {
  const wrap = U.el('div', 'theme-picker');
  let color = space.color ? { i: 0.6, ...space.color } : presetColor(space.theme);

  // Appearance: light / auto / dark
  const top = U.el('div', 'tp-top');
  top.appendChild(U.el('span', 'tp-label', 'Space color'));
  const modes = U.el('div', 'tp-modes');
  const modeBtns = [['light', 'sun', 'Light'], ['system', 'contrast', 'Match system'], ['dark', 'moon', 'Dark']].map(([value, iconName, title]) => {
    const b = U.iconButton(iconName, title, () => {
      ctx.settings.set('appearance', value);
      ipcRenderer.send('set-pref', 'appearance', value);
      modeBtns.forEach((m) => m.classList.toggle('active', m === b));
    }, 'tp-mode');
    b.classList.toggle('active', (ctx.settings.get('appearance') || 'system') === value);
    return b;
  });
  modes.append(...modeBtns);
  top.appendChild(modes);

  // The color field: angle from the center is hue, distance from it is vibrance
  const pad = U.el('div', 'tp-pad');
  const handle = U.el('div', 'tp-handle');
  pad.appendChild(handle);

  const place = () => {
    const w = pad.clientWidth, h = pad.clientHeight;
    if (!w) return;
    const t = (color.h * Math.PI) / 180;
    const dx = Math.sin(t), dy = -Math.cos(t);
    const reach = 1 / Math.hypot(dx / (w / 2), dy / (h / 2)); // distance to the pad's edge along this ray
    handle.style.left = `${w / 2 + dx * reach * color.s}px`;
    handle.style.top = `${h / 2 + dy * reach * color.s}px`;
    handle.style.background = handleColor(color);
    range.style.setProperty('--tp-color', handleColor({ ...color, s: Math.max(color.s, 0.15) }));
  };

  const fromPointer = (e) => {
    const r = pad.getBoundingClientRect();
    const dx = e.clientX - r.left - r.width / 2;
    const dy = e.clientY - r.top - r.height / 2;
    color.h = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    color.s = Math.min(1, Math.hypot(dx / (r.width / 2), dy / (r.height / 2)));
    place();
    setPresetActive(-1);
    T().setSpaceColor(space.id, color, { preview: true });
  };
  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    pad.classList.add('dragging');
    fromPointer(e);
  });
  pad.addEventListener('pointermove', (e) => {
    if (pad.hasPointerCapture(e.pointerId)) fromPointer(e);
  });
  const release = (e) => {
    if (!pad.classList.contains('dragging')) return;
    pad.classList.remove('dragging');
    if (pad.hasPointerCapture(e.pointerId)) pad.releasePointerCapture(e.pointerId);
    T().setSpaceColor(space.id, color);
  };
  pad.addEventListener('pointerup', release);
  pad.addEventListener('pointercancel', release);

  // Intensity: how strongly the color tints the window
  const range = U.el('input', 'tp-range');
  range.type = 'range';
  range.min = 0;
  range.max = 100;
  range.value = Math.round(color.i * 100);
  range.title = 'Intensity';
  range.addEventListener('input', () => {
    color.i = range.value / 100;
    setPresetActive(-1);
    T().setSpaceColor(space.id, color, { preview: true });
  });
  range.addEventListener('change', () => T().setSpaceColor(space.id, color));

  // Presets
  const presets = U.el('div', 'tp-presets');
  const presetBtns = T().THEMES.map((theme, i) => {
    const b = U.el('button', 'tp-swatch');
    b.type = 'button';
    b.title = theme.name;
    b.style.background = `linear-gradient(135deg, ${theme.a}, ${theme.accent})`;
    b.addEventListener('click', () => {
      color = presetColor(i);
      range.value = Math.round(color.i * 100);
      T().setSpaceTheme(space.id, i);
      setPresetActive(i);
      place();
    });
    return b;
  });
  const setPresetActive = (i) => presetBtns.forEach((b, j) => b.classList.toggle('active', i === j));
  setPresetActive(space.color ? -1 : space.theme || 0);
  presets.append(...presetBtns);

  wrap.append(top, pad, range, presets);
  requestAnimationFrame(place);
  return wrap;
}

function spaceMenu(space, x, y) {
  U.contextMenu([
    { header: space.name },
    { label: 'Rename space…', icon: 'edit', action: () => T().renameSpace(space.id) },
    { element: themePicker(space), menuClass: 'has-picker' },
    { label: 'New space…', icon: 'plus', action: () => T().addSpace() },
    { separator: true },
    { header: 'Search engine' },
    { label: 'Default', checked: !space.searchEngine, action: () => T().setSpaceSearchEngine(space.id, null) },
    ...Object.entries(U.SEARCH_ENGINES).map(([key, engine]) => ({ label: engine.name, checked: space.searchEngine === key, action: () => T().setSpaceSearchEngine(space.id, key) })),
    { separator: true },
    !U.PRIVATE && { label: space.isolated ? 'Share logins with other spaces' : 'Separate logins for this space', icon: 'user', checked: !!space.isolated, action: () => T().toggleSpaceIsolation(space.id) },
    { label: 'Share space…', icon: 'share', action: () => shareMenu(space.name, [...space.pinned, ...space.today], x, y) },
    { separator: true },
    { label: 'Delete space…', icon: 'trash', danger: true, disabled: T().spaces.length < 2, action: () => T().deleteSpace(space.id) },
  ].filter(Boolean), x, y);
}

/* ------------------------------------------------------------------ */
/* Sharing: copy links or save a page with them                        */
/* ------------------------------------------------------------------ */

function shareMenu(name, nodes, x, y) {
  const links = T().entriesIn(nodes).filter((e) => e.kind === 'web' && /^https?:/i.test(e.url)).map((e) => ({ title: T().entryTitle(e), url: e.url }));
  if (!links.length) {
    U.toast('Nothing to share — no web pages here');
    return;
  }
  U.contextMenu([
    { header: `Share “${name}” · ${links.length} link${links.length === 1 ? '' : 's'}` },
    { label: 'Copy as list', icon: 'copy', action: () => {
      ipcRenderer.send('copy-text', `${name}\n\n${links.map((l) => `• ${l.title}\n  ${l.url}`).join('\n')}`);
      U.toast('Links copied — paste them anywhere');
    } },
    { label: 'Copy as Markdown', icon: 'code', action: () => {
      ipcRenderer.send('copy-text', `## ${name}\n\n${links.map((l) => `- [${l.title.replace(/[[\]]/g, '')}](${l.url})`).join('\n')}`);
      U.toast('Markdown copied');
    } },
    { label: 'Save as web page…', icon: 'download', action: () => saveSharePage(name, links) },
  ], x, y);
}

function saveSharePage(name, links) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(name)}</title>
<style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:640px;margin:48px auto;padding:0 20px;color:#1d1b24;background:#f7f6fb}h1{font-size:26px}a{display:flex;gap:12px;align-items:center;padding:12px 14px;margin:6px 0;border-radius:12px;background:#fff;color:inherit;text-decoration:none;box-shadow:0 1px 3px rgba(0,0,0,.08)}a:hover{box-shadow:0 2px 10px rgba(0,0,0,.12)}img{width:18px;height:18px}small{display:block;color:#888}</style></head>
<body><h1>${esc(name)}</h1><p>${links.length} links</p>${links.map((l) => `<a href="${esc(l.url)}"><img src="https://icons.duckduckgo.com/ip3/${esc(U.hostOf(l.url))}.ico" alt=""><span>${esc(l.title)}<small>${esc(U.compactUrl(l.url))}</small></span></a>`).join('')}</body></html>`;
  const file = path.join(os.homedir(), 'Downloads', `${name.replace(/[/\\:*?"<>|]/g, '-')} — links.html`);
  try {
    fs.writeFileSync(file, html);
    U.toast('Saved to Downloads — send the file to share', { actionLabel: 'Show', action: () => ipcRenderer.send('download-action', { action: 'show', savePath: file }) });
  } catch (err) {
    U.toast(`Couldn’t save: ${err.message}`);
  }
}

function newTabMenu(x, y) {
  U.contextMenu([
    { label: 'New tab', icon: 'plus', hint: '⌘T', action: () => ctx.command.open() },
    { label: 'New split view', icon: 'split', hint: '⇧⌘D', action: () => T().splitActiveWithNewTab() },
    { label: 'New note', icon: 'note', action: () => ctx.internal.newNote() },
    { label: 'New easel', icon: 'easel', action: () => ctx.internal.newEasel() },
    { label: 'New little window', icon: 'window', hint: '⌥⌘N', action: () => ipcRenderer.send('open-little-window') },
    { separator: true },
    { label: 'New folder', icon: 'folder', action: () => T().createFolder('today') },
    { label: 'New pinned folder', icon: 'folder', action: () => T().createFolder('pinned') },
    { label: 'New live folder…', icon: 'rss', action: () => ctx.liveFolders.create() },
    { separator: true },
    !U.PRIVATE && { label: 'New private window', icon: 'mask', hint: '⇧⌘N', action: () => ipcRenderer.send('open-private-window') },
  ].filter(Boolean), x, y);
}

/* ------------------------------------------------------------------ */
/* Drag & drop                                                         */
/* ------------------------------------------------------------------ */

const indicator = () => U.$('drop-indicator');

function clearDropMarks() {
  indicator().hidden = true;
  document.querySelectorAll('.drop-into, .drop-before, .drop-after').forEach((n) => n.classList.remove('drop-into', 'drop-before', 'drop-after'));
}

function showLine(rect, after) {
  const line = indicator();
  const sidebarRect = U.$('sidebar').getBoundingClientRect();
  line.hidden = false;
  line.style.top = `${(after ? rect.bottom : rect.top) - sidebarRect.top - 1}px`;
  line.style.left = `${rect.left - sidebarRect.left + 6}px`;
  line.style.width = `${rect.width - 12}px`;
}

// Work out where a drop over a section list would land
function listTarget(listEl, e) {
  const section = listEl.dataset.section;
  const spaceId = T().activeSpaceId;
  const draggedLoc = T().locate(dragging);
  const draggedIsEntry = draggedLoc && draggedLoc.node.type === 'entry';
  const tile = e.target.closest('.pinned-tile');
  if (tile && listEl.contains(tile)) {
    if (!draggedIsEntry) return null;
    const r = tile.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    tile.classList.add(after ? 'drop-after' : 'drop-before');
    indicator().hidden = true;
    return { section, spaceId, parentId: null, index: Number(tile.dataset.index) + (after ? 1 : 0) };
  }
  const row = e.target.closest('.row');

  if (!row || !listEl.contains(row)) {
    const rows = listEl.querySelectorAll(':scope > .row, :scope > .folder > .folder-row');
    const last = rows[rows.length - 1];
    if (last) showLine(last.closest('.folder') ? last.closest('.folder').getBoundingClientRect() : last.getBoundingClientRect(), true);
    return { section, spaceId, parentId: null, index: null };
  }

  const rect = row.getBoundingClientRect();
  const ratio = (e.clientY - rect.top) / rect.height;

  if (row.dataset.folder && draggedIsEntry && ratio > 0.25 && ratio < 0.75) {
    row.classList.add('drop-into');
    indicator().hidden = true;
    return { section, spaceId, parentId: row.dataset.folder, index: null };
  }

  const after = ratio >= 0.5;
  const parentId = row.dataset.parentId || null;
  if (parentId && !draggedIsEntry) return null; // folders/splits can't nest
  const index = Number(row.dataset.index) + (after ? 1 : 0);
  const block = row.dataset.folder && after ? row.closest('.folder') : row;
  showLine(block.getBoundingClientRect(), after);
  return { section, spaceId, parentId, index };
}

function favoritesTarget(e) {
  const tile = e.target.closest('.favorite');
  if (!tile) {
    return { section: 'fav', parentId: null, index: null };
  }
  const rect = tile.getBoundingClientRect();
  const after = e.clientX > rect.left + rect.width / 2;
  tile.classList.add(after ? 'drop-after' : 'drop-before');
  return { section: 'fav', parentId: null, index: Number(tile.dataset.index) + (after ? 1 : 0) };
}

function setupDragAndDrop() {
  const sidebar = U.$('sidebar');

  sidebar.addEventListener('dragstart', (e) => {
    const source = e.target.closest('[draggable="true"]');
    if (!source || !source.dataset.id) return;
    dragging = source.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-browser-node', dragging);
    const entry = T().findEntry(dragging);
    if (entry && entry.kind === 'web') e.dataTransfer.setData('text/uri-list', entry.url);
    requestAnimationFrame(() => {
      document.body.classList.add('dragging');
      source.classList.add('drag-source');
    });
  });

  sidebar.addEventListener('dragend', () => {
    dragging = null;
    document.body.classList.remove('dragging');
    document.querySelectorAll('.drag-source').forEach((n) => n.classList.remove('drag-source'));
    clearDropMarks();
    if (renderPending) {
      renderPending = false;
      render();
    }
  });

  const zones = [
    { el: U.$('favorites'), target: (e) => favoritesTarget(e) },
    { el: U.$('pinned-zone'), target: (e) => listTarget(U.$('pinned-list'), e) },
    { el: U.$('today-zone'), target: (e) => listTarget(U.$('today-list'), e) },
  ];

  for (const zone of zones) {
    zone.el.addEventListener('dragover', (e) => {
      if (!dragging) return;
      clearDropMarks();
      const target = zone.target(e);
      if (!target) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    zone.el.addEventListener('dragleave', (e) => {
      if (!zone.el.contains(e.relatedTarget)) clearDropMarks();
    });
    zone.el.addEventListener('drop', (e) => {
      if (!dragging) return;
      e.preventDefault();
      clearDropMarks();
      const target = zone.target(e);
      clearDropMarks();
      const id = dragging;
      dragging = null;
      renderPending = false;
      if (target) T().moveNode(id, target);
      else render();
    });
  }
}

/* ------------------------------------------------------------------ */
/* Collapse / peek                                                     */
/* ------------------------------------------------------------------ */

function setCollapsed(collapsed) {
  if (document.body.classList.contains('compact') && !collapsed) setCompact(false);
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  document.body.classList.remove('sidebar-peek');
  U.store.set('browser.sidebarCollapsed', collapsed);
}

function toggleCollapsed() {
  setCollapsed(!document.body.classList.contains('sidebar-collapsed'));
}

function reveal() {
  if (document.body.classList.contains('sidebar-collapsed')) {
    document.body.classList.add('sidebar-peek');
    if (document.body.classList.contains('compact')) ipcRenderer.send('set-traffic-lights', true);
  }
}

function unpeek() {
  document.body.classList.remove('sidebar-peek');
  if (document.body.classList.contains('compact')) ipcRenderer.send('set-traffic-lights', false);
}

// Compact mode: page fills the whole window; sidebar and window buttons appear on hover
function setCompact(on) {
  document.body.classList.toggle('compact', on);
  if (on) document.body.classList.add('sidebar-collapsed');
  else document.body.classList.toggle('sidebar-collapsed', U.store.get('browser.sidebarCollapsed', false));
  document.body.classList.remove('sidebar-peek');
  ipcRenderer.send('set-traffic-lights', !on);
  U.store.set('browser.compact', on);
}

function toggleCompact() {
  const on = !document.body.classList.contains('compact');
  setCompact(on);
  U.toast(on ? 'Compact mode — hover the left edge for the sidebar (⌥⌘C to exit)' : 'Compact mode off');
}

/* ------------------------------------------------------------------ */
/* Two-finger swipe on the sidebar: switch spaces                      */
/* ------------------------------------------------------------------ */

function setupSpaceSwipe() {
  const sidebar = U.$('sidebar');
  const scroll = U.$('sidebar-scroll');
  const THRESHOLD = 150;
  let acc = 0;
  let idleTimer = null;
  let spent = false; // this gesture already switched; ignore its momentum

  const neighbor = (dir) => {
    const list = T().spaces;
    const i = list.findIndex((s) => s.id === T().activeSpaceId);
    return list[i + dir] || null;
  };
  const settle = () => {
    scroll.style.transition = 'transform 280ms var(--ease), opacity 220ms var(--ease)';
    scroll.style.transform = '';
    scroll.style.opacity = '';
    setTimeout(() => { scroll.style.transition = ''; }, 300);
  };
  const end = () => {
    acc = 0;
    spent = false;
    settle();
  };

  sidebar.addEventListener('wheel', (e) => {
    // Rows that scroll sideways themselves keep their swipes
    if (dragging || e.target.closest('#shelf-items, #panel-row')) return;
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.3;
    if (!horizontal && !acc) return;
    e.preventDefault();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(end, 140);
    if (spent) return;

    acc += e.deltaX;
    const dir = Math.sign(acc);
    const target = neighbor(dir);
    // Follow the fingers; rubber-band when there's no space that way
    const pull = target ? acc : acc * 0.2;
    const shift = Math.max(-80, Math.min(80, -pull * 0.45));
    scroll.style.transition = 'none';
    scroll.style.transform = `translateX(${shift}px)`;
    scroll.style.opacity = String(1 - Math.min(Math.abs(shift) / 80, 1) * 0.45);

    if (target && Math.abs(acc) > THRESHOLD) {
      spent = true;
      scroll.style.transform = '';
      scroll.style.opacity = '';
      T().switchSpace(target.id);
    }
  }, { passive: false });
}

function setup() {
  setupDragAndDrop();
  setupSpaceSwipe();

  U.$('sidebar-toggle-btn').addEventListener('click', toggleCollapsed);
  U.$('sidebar-edge').addEventListener('mouseenter', reveal);
  U.$('sidebar').addEventListener('mouseleave', () => {
    hidePreview();
    if (U.$('sidebar').contains(document.activeElement)) return;
    unpeek();
  });
  // Double-click empty sidebar space for a new tab
  U.$('sidebar-scroll').addEventListener('dblclick', (e) => {
    if (!e.target.closest('.row, .favorite, button, .new-tab-row, #space-title')) ctx.command.open();
  });

  const newTabBtn = U.$('new-tab-btn');
  newTabBtn.addEventListener('click', () => ctx.command.open());
  newTabBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    newTabMenu(e.clientX, e.clientY);
  });
  U.$('new-tab-more').addEventListener('click', (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    newTabMenu(r.left, r.bottom + 4);
  });
  U.$('clear-today-btn').addEventListener('click', () => T().clearToday());
  U.$('add-space-btn').addEventListener('click', () => T().addSpace());
  U.$('space-title').addEventListener('dblclick', () => T().renameSpace(T().activeSpaceId));
  U.$('space-title').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    spaceMenu(T().activeSpace(), e.clientX, e.clientY);
  });

  setCollapsed(U.store.get('browser.sidebarCollapsed', false));
  if (U.store.get('browser.compact', false)) setCompact(true);
  setupResizer();
}

// Drag the sidebar's right edge to resize it (remembered)
function setupResizer() {
  const root = document.documentElement.style;
  const saved = U.store.get('browser.sidebarWidth', null);
  if (saved) root.setProperty('--sidebar-w', `${saved}px`);
  const handle = U.$('sidebar-resizer');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = U.$('sidebar').offsetWidth;
    document.body.classList.add('resizing');
    const move = (ev) => {
      const w = Math.max(200, Math.min(420, startW + ev.clientX - startX));
      root.setProperty('--sidebar-w', `${w}px`);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
      U.store.set('browser.sidebarWidth', U.$('sidebar').offsetWidth);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  handle.addEventListener('dblclick', () => {
    root.removeProperty('--sidebar-w');
    U.store.set('browser.sidebarWidth', null);
  });
}

ctx.sidebar = { setup, render, updateEntry, toggleCollapsed, toggleCompact, reveal, unpeek, entryMenu, shareMenu, hidePreview, themePicker };
