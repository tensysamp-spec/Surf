// Library drawer: Bookmarks, History, Archive, Downloads, Notes & Easels, Highlights, Reading list.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const T = () => ctx.tabs;
const HISTORY_KEY = 'browser.history';
const DOWNLOADS_KEY = 'browser.downloads';
const HISTORY_LIMIT = 5000;

let history = U.store.get(HISTORY_KEY, []);
let downloads = U.store.get(DOWNLOADS_KEY, []);
let current = 'history';
let release = null;

const isOpen = () => document.body.classList.contains('drawer-open');

/* ------------------------------------------------------------------ */
/* History store                                                       */
/* ------------------------------------------------------------------ */

let historyTimer = null;
function saveHistory() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => U.store.set(HISTORY_KEY, history), 400);
}

function addHistory(tab) {
  const url = tab.url;
  if (!url || U.isNewTabUrl(url) || !/^https?:/i.test(url)) return;
  const last = history[0];
  if (last && last.url === url) {
    last.time = Date.now();
  } else {
    history.unshift({ url, title: tab.title || U.hostOf(url), favicon: tab.favicon, time: Date.now() });
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  }
  saveHistory();
  if (isOpen() && current === 'history') render();
}

function updateHistory(tab) {
  const entry = history.find((h) => h.url === tab.url);
  if (!entry) return;
  if (tab.title && !U.isNewTabUrl(tab.url)) entry.title = tab.title;
  if (tab.favicon) entry.favicon = tab.favicon;
  saveHistory();
}

// Merge imported history; returns how many new pages were added
function importHistory(items) {
  const known = new Set(history.map((h) => h.url));
  let added = 0;
  for (const item of items || []) {
    if (!item.url || known.has(item.url) || !/^https?:/i.test(item.url)) continue;
    known.add(item.url);
    history.push({ url: item.url, title: item.title || U.hostOf(item.url), favicon: null, time: item.time || Date.now() });
    added++;
  }
  history.sort((a, b) => b.time - a.time);
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  U.store.set(HISTORY_KEY, history);
  return added;
}

async function clearHistory() {
  if (!history.length) {
    U.toast('History is already empty');
    return;
  }
  const ok = await U.dialog({ title: 'Clear all history?', message: 'This removes every page from your browsing history.', confirmLabel: 'Clear', danger: true, input: false });
  if (!ok) return;
  history = [];
  U.store.set(HISTORY_KEY, history);
  if (isOpen()) render();
  U.toast('History cleared');
}

// Clear browsing data: drop history, finished downloads (the list, not the files) and
// archived tabs from `since` on (0 = everything); returns how many of each were removed
function clearSince(since, { history: h, downloads: d, archive: a }) {
  const out = { history: 0, downloads: 0, archive: 0 };
  if (h) {
    const keep = history.filter((x) => x.time < since);
    out.history = history.length - keep.length;
    history = keep;
    U.store.set(HISTORY_KEY, history);
  }
  if (d) {
    const keep = downloads.filter((x) => x.state === 'progressing' || (x.startTime || 0) < since);
    out.downloads = downloads.length - keep.length;
    downloads = keep;
    saveDownloads();
  }
  if (a) {
    const keep = T().archive.filter((x) => (x.archivedAt || 0) < since);
    out.archive = T().archive.length - keep.length;
    if (out.archive) T().archive = keep;
  }
  if (isOpen()) render();
  return out;
}

// What clearSince would remove, for the dialog's counts
function countSince(since) {
  return {
    history: history.filter((x) => x.time >= since).length,
    downloads: downloads.filter((x) => x.state !== 'progressing' && (x.startTime || 0) >= since).length,
    archive: T().archive.filter((x) => (x.archivedAt || 0) >= since).length,
  };
}

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

function saveDownloads() {
  U.store.set(DOWNLOADS_KEY, downloads.slice(0, 200));
}

ipcRenderer.on('download-update', (_e, d) => {
  const existing = downloads.find((x) => x.id === d.id);
  if (existing) Object.assign(existing, d);
  else {
    // Remember where it came from (used to name generic downloads)
    const tab = T().activeTab();
    if (tab && tab.kind === 'web') Object.assign(d, { pageTitle: tab.title, pageUrl: tab.url });
    downloads.unshift(d);
    U.toast(`Downloading ${d.filename}`, { action: () => open('downloads'), actionLabel: 'Show' });
  }
  if (d.state === 'completed') {
    const entry = existing || d;
    ctx.ai.renameDownload(entry).then((renamed) => {
      ctx.shelf.addFile(renamed ? renamed.path : entry.savePath, renamed ? renamed.filename : entry.filename);
      // "Open when done" waits for the final name, so the app opens the renamed file
      if (entry.openWhenDone) ipcRenderer.send('download-action', { action: 'open', savePath: renamed ? renamed.path : entry.savePath });
      if (renamed) {
        const oldPath = entry.savePath;
        const oldName = entry.filename;
        Object.assign(entry, { savePath: renamed.path, filename: renamed.filename });
        saveDownloads();
        if (isOpen() && current === 'downloads') render();
        U.toast(`Downloaded as “${renamed.filename}”`, {
          actionLabel: 'Undo name',
          action: async () => {
            const back = await ipcRenderer.invoke('rename-file', { from: renamed.path, name: oldName });
            if (!back.error) Object.assign(entry, { savePath: back.path, filename: back.filename });
            else Object.assign(entry, { savePath: oldPath });
            saveDownloads();
          },
          duration: 6000,
        });
      } else {
        U.toast(`Downloaded ${entry.filename}`, { action: () => ipcRenderer.send('download-action', { id: entry.id, action: 'open', savePath: entry.savePath }), actionLabel: 'Open' });
      }
    });
  }
  if (d.state !== 'progressing') saveDownloads();
  updateIndicator();
  ctx.shelf.renderDownloads();
  // Progress ticks update the row in place: rebuilding it every second would swallow
  // clicks that land between a button's mousedown and mouseup
  if (isOpen() && current === 'downloads' && !(existing && patchDownloadRow(U.$('library-list'), existing))) render();
});

// What decides a row's buttons; while it's unchanged only the text and bar move
const downloadShape = (d) => [d.state, d.paused, d.canResume, d.openWhenDone, d.filename].join('|');

function patchDownloadRow(root, d) {
  const row = [...root.querySelectorAll('[data-dl]')].find((x) => x.dataset.dl === d.id);
  if (!row || row.dataset.shape !== downloadShape(d)) return false;
  row.querySelector('.dl-status').textContent = downloadStatus(d, { short: row.dataset.short === '1' });
  const fill = row.querySelector('.progress-fill');
  if (fill) fill.style.width = d.total ? `${(d.received / d.total) * 100}%` : '30%';
  return true;
}

const downloadAction = (d, action, extra = {}) => ipcRenderer.send('download-action', { id: d.id, action, savePath: d.savePath, url: d.url, partition: d.partition, ...extra });

function timeLeft(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  return `${(seconds / 3600).toFixed(1)} h left`;
}

// "12.3 MB of 80 MB · 2.1 MB/s · 30 s left" (used by the Library row); the narrow
// shelf shows "15% · 2.1 MB/s · 30 s left"
function downloadStatus(d, { short = false } = {}) {
  if (d.state === 'progressing') {
    const size = short && d.total ? `${Math.floor((d.received / d.total) * 100)}%` : `${U.formatBytes(d.received)}${d.total ? ` of ${U.formatBytes(d.total)}` : ''}`;
    if (d.paused) return `${size} — paused`;
    if (!d.speed) return size;
    const eta = d.total > d.received ? ` · ${timeLeft((d.total - d.received) / d.speed)}` : '';
    return `${size} · ${U.formatBytes(d.speed)}/s${eta}`;
  }
  if (d.state === 'completed') return `${U.formatBytes(d.total || d.received)} · ${U.hostOf(d.url)}`;
  if (d.state === 'interrupted') return d.canResume ? `Interrupted at ${U.formatBytes(d.received)}` : 'Interrupted';
  return d.state === 'cancelled' ? 'Cancelled' : 'Failed';
}

// Buttons for a download that's still going (or stalled but resumable)
function downloadControls(d, className) {
  const btns = [];
  if (d.state === 'progressing' || d.canResume) {
    const resume = d.paused || d.state === 'interrupted';
    btns.push(U.iconButton(resume ? 'play' : 'pause', resume ? 'Resume' : 'Pause', (e) => { e.stopPropagation(); downloadAction(d, resume ? 'resume' : 'pause'); }, className));
    btns.push(U.iconButton('close', 'Cancel', (e) => { e.stopPropagation(); downloadAction(d, 'cancel'); }, className));
  }
  return btns;
}

function updateIndicator() {
  const active = downloads.filter((d) => d.state === 'progressing');
  const btn = U.$('library-btn');
  btn.classList.toggle('downloading', active.length > 0);
  const total = active.reduce((s, d) => s + (d.total || 0), 0);
  const received = active.reduce((s, d) => s + (d.received || 0), 0);
  btn.style.setProperty('--progress', total ? `${Math.round((received / total) * 360)}deg` : '60deg');
  btn.title = active.length ? `Downloading ${active.length} file${active.length > 1 ? 's' : ''}…` : 'Library — history, archive, downloads';
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function listItem({ iconNode, title, sub, meta, onClick, actions = [] }) {
  const item = U.el('div', 'lib-item');
  const iconWrap = U.el('span', 'h-icon');
  iconWrap.appendChild(iconNode);
  const text = U.el('div', 'h-text');
  text.append(U.el('span', 'h-title', title), U.el('span', 'h-url', sub));
  item.append(iconWrap, text);
  if (meta) item.appendChild(U.el('span', 'h-time', meta));
  const btns = U.el('span', 'lib-actions');
  for (const a of actions) {
    btns.appendChild(U.iconButton(a.icon, a.title, (e) => {
      e.stopPropagation();
      a.run();
    }, 'h-delete'));
  }
  item.appendChild(btns);
  if (onClick) item.addEventListener('click', onClick);
  return item;
}

function groupLabel(text) {
  return U.el('div', 'history-group-label', text);
}

function empty(text) {
  return U.el('div', 'history-empty', text);
}

function renderHistory(list, query) {
  const entries = query ? history.filter((h) => h.title.toLowerCase().includes(query) || h.url.toLowerCase().includes(query)) : history;
  if (!entries.length) return list.appendChild(empty(query ? 'No matching pages.' : 'Pages you visit will show up here.'));
  let label = null;
  for (const h of entries.slice(0, 400)) {
    const day = U.dayLabel(h.time);
    if (day !== label) {
      label = day;
      list.appendChild(groupLabel(day));
    }
    list.appendChild(listItem({
      iconNode: U.iconElement(h.favicon, U.ICONS.globe),
      title: h.title,
      sub: U.hostOf(h.url),
      meta: new Date(h.time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
      onClick: (e) => {
        if (e.metaKey || e.ctrlKey) T().openTab(h.url, { activate: false });
        else {
          T().openTab(h.url);
          close();
        }
      },
      actions: [{ icon: 'close', title: 'Remove from history', run: () => { history = history.filter((x) => x !== h); saveHistory(); render(); } }],
    }));
  }
}

function renderArchive(list, query) {
  const all = T().archive;
  const entries = query ? all.filter((a) => (a.title || '').toLowerCase().includes(query) || (a.url || '').toLowerCase().includes(query)) : all;
  if (!entries.length) {
    return list.appendChild(empty(query ? 'No matching tabs.' : 'Closed and auto-archived tabs show up here, so you can bring them back.'));
  }
  let label = null;
  for (const a of entries) {
    const day = U.dayLabel(a.archivedAt);
    if (day !== label) {
      label = day;
      list.appendChild(groupLabel(day));
    }
    const space = T().getSpace(a.spaceId);
    list.appendChild(listItem({
      iconNode: a.kind === 'web' ? U.iconElement(a.favicon, U.ICONS.globe) : U.icon(a.kind),
      title: a.title || a.url,
      sub: `${a.kind === 'web' ? U.hostOf(a.url) : a.kind}${space ? ` · ${space.name}` : ''}`,
      meta: U.timeAgo(a.archivedAt),
      onClick: () => {
        T().restoreArchived(a);
        render();
      },
      actions: [{ icon: 'close', title: 'Remove from archive', run: () => { T().archive = T().archive.filter((x) => x !== a); render(); } }],
    }));
  }
}

function renderDownloads(list, query) {
  const entries = query ? downloads.filter((d) => d.filename.toLowerCase().includes(query)) : downloads;
  if (!entries.length) return list.appendChild(empty(query ? 'No matching downloads.' : 'Files you download show up here.'));
  for (const d of entries) {
    const item = U.el('div', 'lib-item download-item');
    item.dataset.dl = d.id;
    item.dataset.shape = downloadShape(d);
    const iconWrap = U.el('span', 'h-icon');
    iconWrap.appendChild(U.icon('download'));
    const text = U.el('div', 'h-text');
    text.appendChild(U.el('span', 'h-title', d.filename));
    text.appendChild(U.el('span', 'h-url dl-status', downloadStatus(d)));
    if (d.state === 'progressing') {
      const bar = U.el('div', 'progress');
      const fill = U.el('div', 'progress-fill');
      fill.style.width = d.total ? `${(d.received / d.total) * 100}%` : '30%';
      bar.appendChild(fill);
      text.appendChild(bar);
    }
    item.append(iconWrap, text);

    const btns = U.el('span', 'lib-actions visible');
    const act = (action) => downloadAction(d, action);
    if (d.state === 'progressing') {
      const when = U.iconButton('external', d.openWhenDone ? 'Opens when done' : 'Open when done', () => {
        d.openWhenDone = !d.openWhenDone;
        downloadAction(d, 'open-when-done', { value: d.openWhenDone });
        render();
      }, 'h-delete dl-open-when-done' + (d.openWhenDone ? ' on' : ''));
      btns.appendChild(when);
    }
    btns.append(...downloadControls(d, 'h-delete'));
    if (d.state === 'completed') {
      btns.appendChild(U.iconButton('folder', 'Show in folder', () => act('show'), 'h-delete'));
    } else if (!d.canResume && (d.state === 'interrupted' || d.state === 'cancelled') && d.url) {
      // An interrupted download's unfinished file gets replaced, unless another entry now owns that path
      const reuse = d.state === 'interrupted' && !downloads.some((x) => x !== d && x.savePath === d.savePath);
      btns.appendChild(U.iconButton('reload', 'Retry', () => downloadAction(d, 'retry', { reuse }), 'h-delete'));
    }
    item.appendChild(btns);
    if (d.state === 'completed') {
      item.addEventListener('click', (e) => { if (!e.target.closest('button')) act('open'); });
      // Drag the file out to Finder or another app, like the shelf
      item.draggable = true;
      item.addEventListener('dragstart', (e) => {
        e.preventDefault();
        ipcRenderer.send('shelf-drag-file', d.savePath);
      });
    }
    list.appendChild(item);
  }
}

function renderHighlights(list, query) {
  const all = ctx.highlights.all().filter((h) => !query || h.text.toLowerCase().includes(query) || h.title.toLowerCase().includes(query));
  if (!all.length) return list.appendChild(empty(query ? 'No matching highlights.' : 'Select text on any page, right-click and choose Highlight.'));
  let page = null;
  for (const h of all) {
    if (h.url !== page) {
      page = h.url;
      const label = groupLabel(h.title || U.compactUrl(h.url));
      label.classList.add('hl-page');
      list.appendChild(label);
    }
    const item = U.el('div', 'lib-item hl-item');
    const quote = U.el('div', 'hl-text', `“${h.text}”`);
    const meta = U.el('div', 'h-url', `${U.compactUrl(h.url)} · ${U.timeAgo(h.created)}`);
    const text = U.el('div', 'h-text');
    text.append(quote, meta);
    item.appendChild(text);
    const btns = U.el('span', 'lib-actions');
    btns.appendChild(U.iconButton('copy', 'Copy', (e) => { e.stopPropagation(); ipcRenderer.send('copy-text', h.text); U.toast('Copied'); }, 'h-delete'));
    btns.appendChild(U.iconButton('trash', 'Remove highlight', (e) => { e.stopPropagation(); ctx.highlights.remove(h.id); render(); }, 'h-delete'));
    item.appendChild(btns);
    item.addEventListener('click', () => {
      T().openTab(h.url);
      close();
    });
    list.appendChild(item);
  }
}

function renderNotes(list, query) {
  const docs = ctx.internal.allDocs().filter((d) => !query || d.title.toLowerCase().includes(query));
  if (!docs.length) return list.appendChild(empty(query ? 'Nothing matches.' : 'Notes and easels you create show up here.'));
  for (const d of docs) {
    list.appendChild(listItem({
      iconNode: U.icon(d.kind),
      title: d.title || 'Untitled',
      sub: d.kind === 'note' ? 'Note' : 'Easel',
      meta: U.timeAgo(d.updated),
      onClick: () => {
        ctx.internal.openDoc(d.kind, d.id);
        close();
      },
      actions: [{ icon: 'trash', title: 'Delete', run: async () => { if (await ctx.internal.deleteDoc(d.kind, d.id)) render(); } }],
    }));
  }
}

const CLEAR_LABELS = { history: 'Clear', archive: 'Clear', downloads: 'Clear list', notes: null, highlights: null, bookmarks: null, reading: 'Clear read' };
const SEARCH_LABELS = { notes: 'notes & easels', reading: 'reading list' };
const searchPlaceholder = (tab) => `Search ${SEARCH_LABELS[tab] || tab}`;

function render() {
  const list = U.$('library-list');
  const query = U.$('library-search').value.trim().toLowerCase();
  list.replaceChildren();
  document.querySelectorAll('#library-tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === current);
    // The tab row scrolls when the tabs don't fit; keep the current one in view
    if (b.dataset.tab === current) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  const clearBtn = U.$('library-clear-btn');
  clearBtn.hidden = !CLEAR_LABELS[current];
  clearBtn.querySelector('span').textContent = ` ${CLEAR_LABELS[current] || ''}`;
  if (current === 'bookmarks') ctx.bookmarks.render(list, query);
  else if (current === 'history') renderHistory(list, query);
  else if (current === 'archive') renderArchive(list, query);
  else if (current === 'downloads') renderDownloads(list, query);
  else if (current === 'highlights') renderHighlights(list, query);
  else if (current === 'reading') ctx.readingList.render(list, query);
  else renderNotes(list, query);
}

async function clearCurrent() {
  if (current === 'history') return clearHistory();
  if (current === 'archive') {
    const ok = await U.dialog({ title: 'Clear the archive?', message: 'Archived tabs can’t be restored after this.', confirmLabel: 'Clear', danger: true, input: false });
    if (!ok) return;
    T().archive = [];
  } else if (current === 'downloads') {
    downloads = downloads.filter((d) => d.state === 'progressing');
    saveDownloads();
  } else if (current === 'reading') {
    return ctx.readingList.clearRead();
  }
  render();
}

function open(tab = current) {
  ctx.command.close();
  ctx.ai.closeAssistant();
  current = tab;
  U.$('library-search').value = '';
  U.$('library-search').placeholder = searchPlaceholder(tab);
  render();
  document.body.classList.add('drawer-open');
  if (!release) release = U.pushEscape(close);
  U.$('library-search').focus();
}

function close() {
  document.body.classList.remove('drawer-open');
  if (release) release();
  release = null;
}

// Re-render if the drawer is showing this tab (for modules that own a tab's data)
function refresh(tab) {
  if (isOpen() && current === tab) render();
}

function toggle(tab) {
  if (isOpen() && (!tab || tab === current)) close();
  else open(tab);
}

function setup() {
  U.$('library-btn').addEventListener('click', () => toggle());
  U.$('close-library-btn').addEventListener('click', close);
  U.$('drawer-backdrop').addEventListener('click', () => {
    close();
    ctx.ai.closeAssistant();
  });
  U.$('library-search').addEventListener('input', render);
  U.$('library-clear-btn').addEventListener('click', clearCurrent);
  document.querySelectorAll('#library-tabs button').forEach((b) => b.addEventListener('click', () => {
    current = b.dataset.tab;
    U.$('library-search').placeholder = searchPlaceholder(current);
    render();
  }));
  // Downloads that were mid-flight when the app quit can't resume
  downloads.forEach((d) => {
    if (d.state === 'progressing' || d.state === 'interrupted') Object.assign(d, { state: 'interrupted', canResume: false, paused: false, speed: 0 });
  });
  updateIndicator();
  ctx.readingList.updateBadge();
}

// Re-render the open tab after its data changed elsewhere (e.g. bookmarks)
function refresh() {
  if (isOpen()) render();
}

ctx.library = {
  setup, open, close, toggle, isOpen, refresh, addHistory, updateHistory, clearHistory, importHistory,
  clearSince, countSince,
  history: () => history,
  downloads: () => downloads, downloadStatus, downloadControls, downloadShape, patchDownloadRow,
  current: () => current,
};
