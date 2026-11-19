// Tab switcher: hold ⌃ and press Tab to step through tabs in most-recently-used
// order, shown as thumbnail cards; releasing ⌃ switches. A quick ⌃Tab tap flips
// straight to the previous tab without flashing the overlay.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const T = () => ctx.tabs;
const SHOW_DELAY_MS = 140;

let order = []; // entries, most recent first
let index = 0;
let active = false;
let shown = false;
let showTimer = null;
let releaseEscape = null;

function mruEntries() {
  const space = T().activeSpace();
  const all = [...T().favorites, ...T().entriesIn(space.pinned), ...T().entriesIn(space.today)];
  const seen = new Set();
  return all
    .filter((e) => !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => (b.id === T().activeEntryId) - (a.id === T().activeEntryId) || (b.lastActive || 0) - (a.lastActive || 0));
}

function card(entry, i) {
  const tab = T().live.get(entry.id);
  const node = U.el('button', 'sw-card');
  node.type = 'button';
  node.dataset.index = i;
  node.style.setProperty('--i', i);
  const thumb = U.el('div', 'sw-thumb');
  if (tab && tab.thumb) {
    const img = U.el('img');
    img.src = tab.thumb;
    img.draggable = false;
    thumb.appendChild(img);
  } else {
    thumb.classList.add('empty');
    const icon = entry.kind === 'web' ? U.iconElement(T().entryFavicon(entry), U.ICONS.globe) : U.icon(entry.kind);
    thumb.appendChild(icon);
  }
  const label = U.el('div', 'sw-label');
  const iconWrap = U.el('span', 'sw-icon');
  iconWrap.appendChild(entry.kind === 'web' ? U.iconElement(T().entryFavicon(entry), U.ICONS.globe) : U.icon(entry.kind));
  label.append(iconWrap, U.el('span', 'sw-title', T().entryTitle(entry)));
  node.append(thumb, label);
  node.addEventListener('mouseenter', () => select(i));
  node.addEventListener('click', () => {
    select(i);
    commit();
  });
  return node;
}

function render() {
  const overlay = U.$('switcher');
  const strip = overlay.querySelector('.sw-strip');
  strip.replaceChildren(...order.map(card));
  select(index);
}

function select(i) {
  index = i;
  const cards = U.$('switcher').querySelectorAll('.sw-card');
  cards.forEach((c, j) => c.classList.toggle('selected', j === i));
  const sel = cards[i];
  if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

function show() {
  if (!active || shown) return;
  shown = true;
  render();
  document.body.classList.add('switcher-open');
}

function step(dir) {
  if (!active) {
    order = mruEntries();
    if (order.length < 2) return;
    active = true;
    index = 0;
    T().captureThumb(T().activeTab());
    showTimer = setTimeout(show, SHOW_DELAY_MS);
    releaseEscape = U.pushEscape(cancel);
  }
  index = (index + dir + order.length) % order.length;
  if (shown) select(index);
}

function end() {
  clearTimeout(showTimer);
  active = false;
  shown = false;
  document.body.classList.remove('switcher-open');
  if (releaseEscape) releaseEscape();
  releaseEscape = null;
}

function commit() {
  if (!active) return;
  const target = order[index];
  end();
  if (target && target.id !== T().activeEntryId) T().showEntry(target.id);
}

function cancel() {
  end();
}

function setup() {
  const overlay = U.el('div');
  overlay.id = 'switcher';
  overlay.appendChild(U.el('div', 'sw-strip'));
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) cancel();
  });
  document.getElementById('app').appendChild(overlay);

  ipcRenderer.on('control-up', commit);
  // Fallback when the host page has focus and sees the keyup itself
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Control') commit();
  });
  window.addEventListener('blur', () => active && commit());
}

ctx.switcher = { setup, step, cancel, isOpen: () => active };
