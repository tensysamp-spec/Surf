// Smarter folders: a color and an emoji per folder, grouping a site's Today tabs
// into a folder, one-shot sorting of Today (with undo), and collapse/expand all.
// Folder fields added here: color (a CSS color or absent), icon (an emoji or absent),
// site (the site a "Group tabs from this site" folder collects).

const ctx = require('./ctx');
const U = require('./util');

const T = () => ctx.tabs;

// Eight swatches, the first clears the color
const COLORS = [
  { name: 'No color', value: null },
  { name: 'Red', value: '#e5484d' },
  { name: 'Orange', value: '#f76b15' },
  { name: 'Yellow', value: '#e2a336' },
  { name: 'Green', value: '#30a46c' },
  { name: 'Teal', value: '#12a594' },
  { name: 'Blue', value: '#3e63dd' },
  { name: 'Purple', value: '#8e4ec6' },
];
const NONE_SWATCH = 'linear-gradient(135deg, transparent 46%, var(--text-faint) 46%, var(--text-faint) 54%, transparent 54%), var(--glass-1)';

function update(folderId, patch) {
  const loc = T().locate(folderId);
  if (!loc || loc.node.type !== 'folder') return;
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) delete loc.node[key];
    else loc.node[key] = value;
  }
  ctx.sidebar.render();
  T().save();
}

const setColor = (folderId, color) => update(folderId, { color });
const setIcon = (folderId, icon) => update(folderId, { icon });

/* ------------------------------------------------------------------ */
/* Folder menu items                                                   */
/* ------------------------------------------------------------------ */

function iconMenu(folder, x, y) {
  const pick = (emoji) => {
    U.closeContextMenu();
    setIcon(folder.id, emoji);
  };
  U.contextMenu([
    { header: `Icon for ${folder.name}` },
    { element: ctx.sidebar.iconPicker(folder, pick), menuClass: 'has-emoji' },
    { separator: true },
    { label: 'Use folder icon', icon: 'folder', checked: !folder.icon, action: () => setIcon(folder.id, null) },
  ], x, y);
}

// Items spliced into a folder's context menu
function menuItems(folder, x, y) {
  return [
    { separator: true },
    { header: 'Color' },
    {
      swatches: COLORS.map((c) => ({
        title: c.name,
        color: c.value || NONE_SWATCH,
        active: c.value ? folder.color === c.value : !folder.color,
        action: () => setColor(folder.id, c.value),
      })),
    },
    { label: 'Icon…', icon: 'smile', action: () => iconMenu(folder, x, y) },
    folder.icon && { label: 'Use folder icon', icon: 'folder', action: () => setIcon(folder.id, null) },
  ].filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Group tabs from this site                                           */
/* ------------------------------------------------------------------ */

// Second-level labels under a country code that aren't a site of their own (bbc.co.uk, abc.net.au)
const SECOND_LEVEL = /^(co|com|net|org|gov|edu|ac|ne|or|go|gv|nic)$/;

// The registrable host, ignoring www. (docs.github.com and github.com are one site)
function siteOf(url) {
  let host;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    host = u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  if (!host || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')) return host || null;
  const parts = host.split('.');
  const n = parts.length >= 3 && parts[parts.length - 1].length === 2 && SECOND_LEVEL.test(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-n).join('.');
}

const urlOf = (entry) => (T().live.get(entry.id) || {}).url || entry.url;
const entrySite = (entry) => (entry.kind === 'web' ? siteOf(urlOf(entry)) : null);

function siteOfEntry(entryId) {
  const entry = T().findEntry(entryId);
  return entry ? entrySite(entry) : null;
}

// Collects every Today tab of the entry's site into one folder (reusing an earlier one).
// Splits stay intact and live folders keep their items.
function groupBySite(entryId) {
  const loc = T().locate(entryId);
  if (!loc || loc.section !== 'today') return;
  const site = entrySite(loc.node);
  if (!site) return;
  const space = loc.space;
  const isMatch = (n) => n.type === 'entry' && entrySite(n) === site;
  let folder = space.today.find((n) => n.type === 'folder' && !n.live && n.site === site);

  if (!folder) {
    folder = { type: 'folder', id: U.uid(), name: site, open: true, children: [], site };
    const holds = (n) => isMatch(n) || (n.type === 'folder' && !n.live && n.children.some(isMatch));
    space.today.splice(Math.max(0, space.today.findIndex(holds)), 0, folder);
  }
  // The site's icon color; the first lookup of an icon is async, so keep looking (a failed lookup retries after a minute)
  const favicon = T().entryFavicon(loc.node);
  const tint = () => {
    const color = !folder.color && ctx.siteColor.get(favicon);
    if (color) folder.color = color;
    return !!color;
  };
  if (!tint()) {
    let tries = 0;
    const retry = setInterval(() => {
      if (tint()) {
        ctx.sidebar.render();
        T().save();
      }
      if (folder.color || ++tries >= 45) clearInterval(retry);
    }, 2000);
  }

  const moved = [];
  const keep = [];
  for (const node of space.today) {
    if (isMatch(node)) {
      moved.push(node);
      continue;
    }
    if (node.type === 'folder' && !node.live && node !== folder) {
      node.children = node.children.filter((child) => {
        if (!isMatch(child)) return true;
        moved.push(child);
        return false;
      });
    }
    keep.push(node);
  }
  space.today = keep;
  folder.children.push(...moved);
  folder.open = true;

  ctx.sidebar.render();
  T().save();
  if (moved.length) U.toast(`Grouped ${moved.length} ${moved.length === 1 ? 'tab' : 'tabs'} from ${site}`);
}

/* ------------------------------------------------------------------ */
/* Sort Today (one-shot, undoable)                                     */
/* ------------------------------------------------------------------ */

const firstEntry = (node) => (node.type === 'entry' ? node : node.children[0] || null);
const lastUsed = (node) => (node.type === 'entry' ? node.lastActive || 0 : Math.max(0, ...node.children.map((c) => c.lastActive || 0)));
const titleOf = (node) => {
  if (node.type === 'folder') return node.name;
  const entry = firstEntry(node);
  return entry ? T().entryTitle(entry) : '';
};
const compareText = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

const SORTS = {
  site: {
    label: 'site',
    compare: (a, b) => {
      const sa = (firstEntry(a) && entrySite(firstEntry(a))) || '￿';
      const sb = (firstEntry(b) && entrySite(firstEntry(b))) || '￿';
      return compareText(sa, sb) || compareText(titleOf(a), titleOf(b));
    },
  },
  title: { label: 'title', compare: (a, b) => compareText(titleOf(a), titleOf(b)) },
  lastUsed: { label: 'last used', compare: (a, b) => lastUsed(b) - lastUsed(a) },
};

// Folders keep their place at the top (in their own order); tabs and splits below get sorted
function sortToday(by) {
  const sort = SORTS[by];
  const space = T().activeSpace();
  if (!sort || !space) return;
  const before = [...space.today];
  const folders = before.filter((n) => n.type === 'folder');
  const rest = before.filter((n) => n.type !== 'folder').sort(sort.compare);
  const after = [...folders, ...rest];
  if (after.every((n, i) => n === before[i])) {
    U.toast(`Today is already sorted by ${sort.label}`);
    return;
  }
  space.today = after;
  ctx.sidebar.render();
  T().save();
  U.toast(`Sorted Today by ${sort.label}`, { action: () => undoSort(space.id, before), actionLabel: 'Undo', duration: 6000 });
}

// Put the previous order back; tabs opened since stay on top, closed ones are simply gone
function undoSort(spaceId, before) {
  const space = T().getSpace(spaceId);
  if (!space) return;
  const order = new Map(before.map((n, i) => [n, i]));
  const rank = (n) => (order.has(n) ? order.get(n) : -1);
  space.today = [...space.today].sort((a, b) => rank(a) - rank(b));
  ctx.sidebar.render();
  T().save();
}

/* ------------------------------------------------------------------ */
/* Collapse / expand all                                               */
/* ------------------------------------------------------------------ */

function setAllOpen(open) {
  const space = T().activeSpace();
  let changed = false;
  for (const node of [...space.pinned, ...space.today]) {
    if (node.type === 'folder' && node.open !== open) {
      node.open = open;
      changed = true;
    }
  }
  if (!changed) return;
  ctx.sidebar.render();
  T().save();
}

// The Today section's menu (right-click the divider, or "Sort Today…" in the New Tab ⌄ menu)
function todayMenu(x, y) {
  const today = T().activeSpace().today;
  const hasFolders = [...T().activeSpace().pinned, ...today].some((n) => n.type === 'folder');
  U.contextMenu([
    { header: 'Sort Today' },
    { label: 'By site', icon: 'globe', disabled: today.length < 2, action: () => sortToday('site') },
    { label: 'By title', icon: 'type', disabled: today.length < 2, action: () => sortToday('title') },
    { label: 'By last used', icon: 'clock', disabled: today.length < 2, action: () => sortToday('lastUsed') },
    { separator: true },
    { label: 'Collapse all folders', icon: 'chevronRight', disabled: !hasFolders, action: () => setAllOpen(false) },
    { label: 'Expand all folders', icon: 'chevronDown', disabled: !hasFolders, action: () => setAllOpen(true) },
    { separator: true },
    { label: 'Archive today’s tabs', icon: 'archive', disabled: !today.length, action: () => T().clearToday() },
  ], x, y);
}

ctx.folders = { COLORS, setColor, setIcon, menuItems, siteOf, siteOfEntry, groupBySite, sortToday, setAllOpen, todayMenu };
