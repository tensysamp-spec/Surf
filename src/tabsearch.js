// Tab search (⇧⌘A): find any tab in any space — favorites, pinned, today, inside
// folders and splits — plus archived tabs and recent history, by title and URL.

const ctx = require('./ctx');
const U = require('./util');

const T = () => ctx.tabs;
const LIMITS = { open: 40, archived: 8, history: 12 };
const EMPTY_LIMITS = { open: 30, archived: 5, history: 5 };

let items = []; // flat list of rows, in display order
let index = 0;
let release = null;
let pool = null; // { open, archived, history } with lowercased haystacks, built on open

const isOpen = () => document.body.classList.contains('tabsearch-open');

/* ------------------------------------------------------------------ */
/* Index                                                               */
/* ------------------------------------------------------------------ */

const lower = (s) => (s || '').toLowerCase();

// Where an entry sits, in words: "Pinned", "Folder name", "Split view"
function placeOf(section, parent) {
  if (parent && parent.type === 'folder') return parent.name;
  if (parent && parent.type === 'split') return 'Split view';
  return section === 'pinned' ? 'Pinned' : null;
}

function buildIndex() {
  const open = [];
  const add = (entry, space, section, parent) => {
    const tab = T().live.get(entry.id);
    const title = T().entryTitle(entry);
    const url = (tab && tab.url) || entry.url || '';
    open.push({ kind: 'tab', entry, space, place: placeOf(section, parent), title, url, t: lower(title), u: lower(url), lastActive: entry.lastActive || 0 });
  };
  const walk = (list, space, section, parent = null) => {
    for (const node of list) {
      if (node.type === 'entry') add(node, space, section, parent);
      else if (node.children) walk(node.children, space, section, node);
    }
  };
  walk(T().favorites, null, 'fav');
  for (const space of T().spaces) {
    walk(space.pinned, space, 'pinned');
    walk(space.today, space, 'today');
  }
  const openUrls = new Set(open.map((o) => o.url));
  const archived = T().archive.map((a) => ({ kind: 'archived', item: a, title: a.title || U.hostOf(a.url), url: a.url, time: a.archivedAt, t: lower(a.title), u: lower(a.url) }));
  // History pages that are open right now show up as open tabs instead
  const history = ctx.library.history()
    .filter((h) => !openUrls.has(h.url))
    .map((h) => ({ kind: 'history', item: h, title: h.title || U.hostOf(h.url), url: h.url, time: h.time, t: lower(h.title), u: lower(h.url) }));
  pool = { open, archived, history };
}

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

// Do the token's letters appear in order in the text? (loose fuzzy match)
function subsequence(text, token) {
  let j = 0;
  for (let i = 0; i < text.length && j < token.length; i++) if (text[i] === token[j]) j++;
  return j === token.length;
}

function tokenScore(rec, token) {
  const { t, u } = rec;
  if (t.startsWith(token)) return 100;
  const at = t.indexOf(token);
  if (at > 0) return /[\s\-–—_/:.|(]/.test(t[at - 1]) ? 80 : 60;
  const host = u.replace(/^[a-z]+:\/\/(www\.)?/, '');
  if (host.startsWith(token)) return 70;
  if (u.includes(token)) return 40;
  if (token.length > 1 && subsequence(t, token)) return 12;
  return 0;
}

// Every word of the query has to match somewhere; better matches rank higher
function score(rec, tokens) {
  let total = 0;
  for (const token of tokens) {
    const s = tokenScore(rec, token);
    if (!s) return 0;
    total += s;
  }
  return total;
}

function rank(list, tokens, limit, bonus) {
  if (!tokens.length) return list.slice(0, limit);
  const hits = [];
  for (const rec of list) {
    const s = score(rec, tokens);
    if (s) hits.push({ rec, s: s + (bonus ? bonus(rec) : 0) });
  }
  // Ties go to the most recently used
  hits.sort((a, b) => b.s - a.s || (b.rec.lastActive || b.rec.time || 0) - (a.rec.lastActive || a.rec.time || 0));
  return hits.slice(0, limit).map((h) => h.rec);
}

function search(query) {
  const tokens = lower(query).split(/\s+/).filter(Boolean);
  const limits = tokens.length ? LIMITS : EMPTY_LIMITS;
  const current = T().activeSpaceId;
  // Tabs in the current space get a head start
  const here = (rec) => (rec.space && rec.space.id === current ? 15 : 0);
  let open;
  if (tokens.length) {
    open = rank(pool.open, tokens, limits.open, here);
  } else {
    open = [...pool.open]
      .sort((a, b) => ((b.space && b.space.id === current) - (a.space && a.space.id === current)) || b.lastActive - a.lastActive)
      .slice(0, limits.open);
  }
  return [
    { label: 'Open tabs', rows: open },
    { label: 'Archived', rows: rank(pool.archived, tokens, limits.archived) },
    { label: 'History', rows: rank(pool.history, tokens, limits.history) },
  ].filter((g) => g.rows.length);
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

function spaceChip(rec) {
  if (!rec.space) {
    const chip = U.el('span', 'ts-chip ts-fav');
    chip.append(U.icon('star'), U.el('span', null, 'Favorites'));
    return chip;
  }
  const theme = T().themeFor(rec.space);
  const chip = U.el('span', 'ts-chip');
  chip.style.setProperty('--chip', document.body.classList.contains('dark') ? theme.dark.accent : theme.accent);
  chip.append(U.el('span', 'ts-chip-glyph' + (rec.space.icon ? ' glyph-emoji' : ''), ctx.sidebar.spaceGlyph(rec.space)), U.el('span', null, rec.space.name));
  return chip;
}

function rowIcon(rec) {
  const kind = rec.entry ? rec.entry.kind : rec.item.kind;
  if (kind === 'note' || kind === 'easel') return U.icon(kind);
  if (U.isNewTabUrl(rec.url)) return U.icon('grid');
  const favicon = rec.entry ? T().entryFavicon(rec.entry) : rec.item.favicon;
  return U.iconElement(favicon, U.ICONS.globe);
}

function row(rec, i) {
  const el = U.el('div', 'command-item ts-item');
  el.dataset.index = i;
  const iconWrap = U.el('span', 'c-icon');
  iconWrap.appendChild(rowIcon(rec));
  el.append(iconWrap, U.el('span', 'c-title', rec.title || U.compactUrl(rec.url)));
  let sub = U.compactUrl(rec.url) || '';
  if (rec.kind !== 'tab' && rec.time) sub += `${sub ? ' · ' : ''}${U.timeAgo(rec.time)}`;
  if (rec.place) sub = `${rec.place}${sub ? ' · ' : ''}${sub}`;
  el.appendChild(U.el('span', 'c-sub', sub));
  if (rec.kind === 'tab') el.appendChild(spaceChip(rec));
  const hint = rec.kind === 'tab' ? (rec.entry.id === T().activeEntryId ? 'Current' : '↵ Switch') : '↵ Reopen';
  el.appendChild(U.el('span', 'c-hint', hint));
  return el;
}

function refresh() {
  const results = U.$('tabsearch-results');
  const groups = search(U.$('tabsearch-input').value);
  items = [];
  const frag = document.createDocumentFragment();
  for (const group of groups) {
    frag.appendChild(U.el('div', 'ts-group', group.label));
    for (const rec of group.rows) {
      frag.appendChild(row(rec, items.length));
      items.push(rec);
    }
  }
  if (!items.length) frag.appendChild(U.el('div', 'ts-empty', 'No tabs, archived tabs or history match'));
  results.replaceChildren(frag);
  results.scrollTop = 0;
  select(0);
}

// Only flips classes, so arrowing through hundreds of rows stays instant
function select(i) {
  const results = U.$('tabsearch-results');
  const prev = results.querySelector('.ts-item.selected');
  if (prev) prev.classList.remove('selected');
  index = i;
  const el = results.querySelector(`.ts-item[data-index="${i}"]`);
  if (!el) return;
  el.classList.add('selected');
  // Back at the top, show the group header too
  if (i === 0) results.scrollTop = 0;
  else el.scrollIntoView({ block: 'nearest' });
}

function run(rec) {
  if (!rec) return;
  close();
  if (rec.kind === 'tab') {
    // A tab inside a collapsed folder: open the folder so it shows in the sidebar
    const loc = T().locate(rec.entry.id);
    if (loc && loc.parent && loc.parent.type === 'folder') loc.parent.open = true;
    T().showEntry(rec.entry.id);
  } else if (rec.kind === 'archived') {
    T().restoreArchived(rec.item);
  } else {
    T().openTab(rec.url);
  }
}

function open() {
  ctx.command.close();
  ctx.library.close();
  ctx.sidebar.hidePreview();
  buildIndex();
  const input = U.$('tabsearch-input');
  input.value = '';
  refresh();
  document.body.classList.add('tabsearch-open');
  if (!release) release = U.pushEscape(close);
  input.focus();
}

function close() {
  if (!isOpen()) return;
  document.body.classList.remove('tabsearch-open');
  U.$('tabsearch-input').blur();
  pool = null;
  if (release) release();
  release = null;
}

function toggle() {
  if (isOpen()) close();
  else open();
}

function setup() {
  const input = U.$('tabsearch-input');
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) select((index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(items[index]);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  const results = U.$('tabsearch-results');
  results.addEventListener('mousemove', (e) => {
    const el = e.target.closest('.ts-item');
    if (el && Number(el.dataset.index) !== index) select(Number(el.dataset.index));
  });
  results.addEventListener('click', (e) => {
    const el = e.target.closest('.ts-item');
    if (el) run(items[Number(el.dataset.index)]);
  });
  U.$('tabsearch-overlay').addEventListener('mousedown', (e) => {
    if (e.target === U.$('tabsearch-overlay')) close();
  });
}

ctx.tabSearch = { setup, open, close, toggle, isOpen };
