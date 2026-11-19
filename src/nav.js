// Address bar, navigation buttons, shields badge.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const T = () => ctx.tabs;
let blockedTotal = 0;

function els() {
  return {
    back: U.$('back-btn'),
    forward: U.$('forward-btn'),
    reload: U.$('reload-btn'),
    omnibox: U.$('omnibox'),
    security: U.$('security-icon'),
    url: U.$('url-input'),
    star: U.$('bookmark-btn'),
    boost: U.$('boost-btn'),
    shields: U.$('shields-btn'),
    count: U.$('blocked-count'),
  };
}

function update(syncUrl = false) {
  const e = els();
  const tab = T().activeTab();
  const isWeb = !!tab && tab.kind === 'web';

  let canBack = false;
  let canForward = false;
  if (isWeb && tab.ready) {
    try {
      canBack = tab.webview.canGoBack();
      canForward = tab.webview.canGoForward();
    } catch { /* not attached yet */ }
  }
  e.back.disabled = !canBack;
  e.forward.disabled = !canForward;
  e.reload.disabled = !isWeb;

  const loading = isWeb && tab.loading && !U.isNewTabUrl(tab.url);
  e.reload.classList.toggle('loading', loading);
  e.reload.title = loading ? 'Stop loading' : 'Reload (⌘R)';

  const url = tab ? tab.url : '';
  if (!isWeb) {
    if (document.activeElement !== e.url) e.url.value = tab ? T().entryTitle(T().findEntry(tab.entryId) || { title: '' }) : '';
  } else if (document.activeElement !== e.url) {
    e.url.value = U.compactUrl(url);
  } else if (syncUrl && !e.url.dataset.dirty) {
    // Only refresh a focused address bar if the user hasn't started typing
    e.url.value = U.displayUrl(url);
  }
  e.url.title = isWeb ? U.displayUrl(url) : '';

  let state = 'info';
  if (!isWeb || !url || U.isNewTabUrl(url)) state = 'search';
  else if (url.startsWith('https://')) state = 'secure';
  else if (url.startsWith('http://')) state = 'insecure';
  e.security.dataset.state = state;
  e.omnibox.title = { secure: 'Connection is secure', insecure: 'Connection is not secure', search: '', info: '' }[state];

  const entry = tab ? T().findEntry(tab.entryId) : null;
  const canFavorite = isWeb && !U.isNewTabUrl(url);
  e.star.disabled = !canFavorite;
  const isFav = !!entry && T().isFavorite(entry.id);
  e.star.classList.toggle('active', isFav);
  e.star.title = isFav ? 'Remove from favorites' : 'Add to favorites';

  const reader = U.$('reader-btn');
  reader.disabled = !(isWeb && (tab.readerable || tab.readerEl));
  reader.classList.toggle('active', !!(isWeb && tab.readerEl));
  e.boost.disabled = !canFavorite;
  e.boost.classList.toggle('active', canFavorite && ctx.boosts.isActiveFor(url));

  updateShields();
  ctx.page.onActiveChange();
}

function updateShields() {
  const e = els();
  const tab = T().activeTab();
  const on = ctx.settings.get('shields');
  const count = tab && tab.kind === 'web' ? tab.blocked || 0 : 0;
  e.shields.hidden = !!tab && tab.kind !== 'web';
  e.count.textContent = on ? (count > 999 ? '999+' : String(count)) : 'Off';
  e.shields.classList.toggle('has-blocked', on && count > 0);
  e.shields.classList.toggle('off', !on);
  e.shields.title = on
    ? `Shields up — ${count} ads & trackers blocked on this page, ${blockedTotal} this session.\nClick to turn off.`
    : 'Shields down — ads and trackers are allowed.\nClick to turn on.';
}

function setBlockedTotal(total) {
  blockedTotal = total;
}

function toggleShields() {
  const on = !ctx.settings.get('shields');
  ctx.settings.set('shields', on);
  ipcRenderer.send('set-shields', on);
  updateShields();
  const tab = T().activeTab();
  if (tab && tab.kind === 'web' && tab.ready && !U.isNewTabUrl(tab.url)) tab.webview.reload();
  U.toast(on ? 'Shields up — blocking ads & trackers' : 'Shields down');
}

function focusUrl() {
  ctx.sidebar.reveal();
  const input = els().url;
  input.focus();
  input.select();
}

function withWebview(fn) {
  const tab = T().activeTab();
  if (!tab || tab.kind !== 'web' || !tab.ready) return;
  try {
    fn(tab.webview, tab);
  } catch (err) {
    console.error(err);
  }
}

const back = () => withWebview((wv) => wv.canGoBack() && wv.goBack());
const forward = () => withWebview((wv) => wv.canGoForward() && wv.goForward());
const reload = () => withWebview((wv) => wv.reload());

function copyUrl() {
  const tab = T().activeTab();
  if (!tab || tab.kind !== 'web' || U.isNewTabUrl(tab.url)) return;
  ipcRenderer.send('copy-text', tab.url);
  U.toast('Copied URL');
}

function setup() {
  const e = els();

  e.omnibox.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const value = e.url.value;
    e.url.blur();
    T().navigateActive(value);
  });

  // Expand to the full URL while editing, collapse back to the host after
  e.url.addEventListener('input', () => { e.url.dataset.dirty = '1'; });
  e.url.addEventListener('focus', () => {
    delete e.url.dataset.dirty;
    const tab = T().activeTab();
    e.url.value = tab && tab.kind === 'web' ? U.displayUrl(tab.url) : '';
    e.url.select();
  });
  e.url.addEventListener('blur', () => {
    delete e.url.dataset.dirty;
    update();
    if (!U.$('sidebar').matches(':hover')) document.body.classList.remove('sidebar-peek');
  });

  // Keep the focus-time "select all" from being undone by the first click
  let selectOnMouseUp = false;
  e.url.addEventListener('mousedown', () => {
    selectOnMouseUp = document.activeElement !== e.url;
  });
  e.url.addEventListener('mouseup', (ev) => {
    if (selectOnMouseUp && e.url.selectionStart === e.url.selectionEnd) {
      ev.preventDefault();
      e.url.select();
    }
    selectOnMouseUp = false;
  });
  e.url.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') e.url.blur();
  });

  e.back.addEventListener('click', back);
  e.forward.addEventListener('click', forward);
  e.reload.addEventListener('click', () => withWebview((wv, tab) => (tab.loading ? wv.stop() : wv.reload())));

  // Buttons inside the address bar shouldn't steal focus from it
  U.$('reader-btn').addEventListener('click', () => ctx.reader.toggle());
  for (const btn of [e.star, e.boost, e.shields, U.$('zoom-btn'), U.$('reader-btn')]) btn.addEventListener('mousedown', (ev) => ev.preventDefault());
  e.star.addEventListener('click', () => {
    const tab = T().activeTab();
    if (!tab) return;
    const wasFav = T().isFavorite(tab.entryId);
    T().toggleFavorite(tab.entryId);
    U.toast(wasFav ? 'Removed from favorites' : 'Added to favorites');
  });
  e.boost.addEventListener('click', () => ctx.boosts.togglePanel());
  e.shields.addEventListener('click', () => ctx.privacy.openPopover());

  ipcRenderer.send('set-shields', ctx.settings.get('shields'));
}

ctx.nav = { setup, update, updateShields, setBlockedTotal, focusUrl, back, forward, reload, copyUrl, toggleShields, withWebview };
