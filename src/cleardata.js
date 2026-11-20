// Clear browsing data (⇧⌘⌫, the command bar, Surf menu, Settings → Privacy): history,
// archived tabs, the downloads list, cookies & site data, the cache and site permissions,
// over a time range. Passwords, addresses and cards are never touched here.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const KEY = 'browser.clearData';
const HOUR = 3600 * 1000;
const RANGES = [
  ['hour', 'Last hour', HOUR],
  ['day', 'Last 24 hours', 24 * HOUR],
  ['week', 'Last 7 days', 7 * 24 * HOUR],
  ['all', 'All time', null],
];
const DEFAULT_CHOICE = { range: 'hour', history: true, archive: false, downloads: false, siteData: false, cache: true, permissions: false };

let busy = false;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const sinceFor = (range) => {
  const ms = RANGES.find(([id]) => id === range)[2];
  return ms ? Date.now() - ms : 0;
};

// One checkbox row: title plus a hint line that can change with the range
function optionRow(title) {
  const row = U.el('label', 'cd-row');
  const box = U.el('input');
  box.type = 'checkbox';
  const text = U.el('div', 'cd-text');
  const hint = U.el('small');
  text.append(U.el('span', null, title), hint);
  row.append(box, text);
  return { row, box, hint };
}

async function open() {
  if (busy) return;
  const saved = { ...DEFAULT_CHOICE, ...U.store.get(KEY, {}) };
  if (!RANGES.some(([id]) => id === saved.range)) saved.range = DEFAULT_CHOICE.range;
  // Private windows never save permission choices, so there's nothing to reset
  const permCount = U.PRIVATE ? 0 : await ipcRenderer.invoke('permissions-count');

  const content = U.el('div', 'cd-body');
  const rangeBar = U.el('div', 'segmented cd-range');
  rangeBar.setAttribute('role', 'radiogroup');
  rangeBar.setAttribute('aria-label', 'Time range');
  let range = saved.range;
  for (const [id, label] of RANGES) {
    const b = U.el('button', null, label);
    b.type = 'button';
    b.dataset.range = id;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => {
      range = id;
      update();
    });
    rangeBar.appendChild(b);
  }

  const opts = {
    history: optionRow('Browsing history'),
    archive: optionRow('Archived tabs'),
    downloads: optionRow('Downloads list'),
    siteData: optionRow('Cookies and site data'),
    cache: optionRow('Cached images and files'),
    permissions: optionRow('Site permissions'),
  };
  const list = U.el('div', 'cd-list');
  for (const [key, o] of Object.entries(opts)) {
    if (key === 'permissions' && U.PRIVATE) continue;
    o.box.checked = !!saved[key];
    o.box.addEventListener('change', update);
    list.appendChild(o.row);
  }
  content.append(rangeBar, list);
  content.appendChild(U.el('p', 'cd-note', U.PRIVATE
    ? 'Only this private window’s data is cleared. Passwords and addresses aren’t cleared here.'
    : 'Passwords and addresses aren’t cleared here. Cookies and the cache are cleared in every space and web panel.'));

  // Cookies, storage and permissions have no dates, so they can only go all at once
  function update() {
    const partial = range !== 'all';
    rangeBar.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.range === range);
      b.setAttribute('aria-checked', String(b.dataset.range === range));
    });
    const n = ctx.library.countSince(sinceFor(range));
    opts.history.hint.textContent = n.history ? plural(n.history, 'page') : 'Nothing in this range';
    opts.archive.hint.textContent = n.archive ? plural(n.archive, 'tab') : 'Nothing in this range';
    opts.downloads.hint.textContent = `${n.downloads ? plural(n.downloads, 'download') : 'Nothing in this range'} · the files stay on disk`;
    opts.siteData.hint.textContent = partial ? 'Only with All time — cookies can’t be cleared by date' : 'Signs you out of most sites';
    opts.cache.hint.textContent = partial ? 'Always cleared entirely — pages just load a bit slower once' : 'Pages may load a bit slower next time';
    opts.permissions.hint.textContent = partial ? 'Only with All time' : (permCount ? `${plural(permCount, 'saved choice')} — sites will ask again` : 'No saved choices');
    for (const key of ['siteData', 'permissions']) {
      opts[key].box.disabled = partial;
      opts[key].row.classList.toggle('disabled', partial);
    }
    const ok = content.closest('form') && content.closest('form').querySelector('button[type=submit]');
    if (ok) ok.disabled = !Object.keys(opts).some((key) => isOn(key));
  }
  const isOn = (key) => !(key === 'permissions' && U.PRIVATE) && opts[key].box.checked && !opts[key].box.disabled;
  update();
  requestAnimationFrame(update); // the Clear button exists once the dialog is on screen

  const ok = await U.dialog({ title: 'Clear browsing data', content, confirmLabel: 'Clear data', danger: true, input: false, className: 'cd-dialog' });
  const choice = { range };
  for (const key of Object.keys(opts)) choice[key] = opts[key].box.checked;
  U.store.set(KEY, choice);
  if (!ok) return;
  const picked = Object.fromEntries(Object.keys(opts).map((key) => [key, isOn(key)]));
  if (!Object.values(picked).some(Boolean)) return;
  await clear(sinceFor(range), picked);
}

async function clear(since, picked) {
  busy = true;
  try {
    const done = [];
    const n = ctx.library.clearSince(since, picked);
    if (n.history) done.push(plural(n.history, 'history page'));
    if (n.archive) done.push(plural(n.archive, 'archived tab'));
    if (n.downloads) done.push(plural(n.downloads, 'download'));
    if (picked.siteData || picked.cache) {
      await ipcRenderer.invoke('clear-browsing-data', { siteData: picked.siteData, cache: picked.cache });
      if (picked.siteData) done.push('cookies & site data');
      if (picked.cache) done.push('cache');
    }
    if (picked.permissions) {
      await ipcRenderer.invoke('permissions-reset');
      done.push('site permissions');
    }
    if (!done.length) return U.toast('Nothing to clear in this time range');
    const list = done.length > 1 ? `${done.slice(0, -1).join(', ')} and ${done[done.length - 1]}` : done[0];
    U.toast(`Cleared ${list}`, { duration: 5000 });
  } catch (err) {
    U.toast(`Couldn’t clear everything: ${err.message}`, { duration: 6000 });
  } finally {
    busy = false;
  }
}

ctx.clearData = { open };
