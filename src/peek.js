// Peek: Shift+click (or "Open Link in Peek") shows a page in a floating card.

const ctx = require('./ctx');
const U = require('./util');

let webview = null;
let currentUrl = null;
let release = null;

const isOpen = () => document.body.classList.contains('peek-open');

function renderHeader(title, favicon) {
  const iconWrap = U.$('peek-icon');
  iconWrap.replaceChildren(U.iconElement(favicon, U.ICONS.globe));
  U.$('peek-title').textContent = title || U.compactUrl(currentUrl);
  U.$('peek-host').textContent = U.compactUrl(currentUrl);
}

function open(url) {
  close();
  currentUrl = url;
  webview = document.createElement('webview');
  webview.setAttribute('allowpopups', '');
  webview.setAttribute('src', url);
  webview.className = 'peek-webview';
  U.$('peek-body').appendChild(webview);

  let favicon = null;
  let title = '';
  webview.addEventListener('did-navigate', (e) => { currentUrl = e.url; renderHeader(title, favicon); });
  webview.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) { currentUrl = e.url; renderHeader(title, favicon); } });
  webview.addEventListener('page-title-updated', (e) => { title = e.title; renderHeader(title, favicon); });
  webview.addEventListener('page-favicon-updated', (e) => { favicon = e.favicons[0] || null; renderHeader(title, favicon); });
  webview.addEventListener('did-start-loading', () => U.$('peek-card').classList.add('loading'));
  webview.addEventListener('did-stop-loading', () => U.$('peek-card').classList.remove('loading'));

  renderHeader('', null);
  document.body.classList.add('peek-open');
  release = U.pushEscape(close);
}

function close() {
  if (!webview && !isOpen()) return;
  document.body.classList.remove('peek-open');
  if (webview) webview.remove();
  webview = null;
  if (release) release();
  release = null;
}

function expand() {
  const url = currentUrl;
  close();
  if (url) ctx.tabs.openTab(url);
}

function toSplit() {
  const url = currentUrl;
  close();
  if (url) ctx.tabs.splitWithUrl(url);
}

function setup() {
  U.$('peek-close').addEventListener('click', close);
  U.$('peek-open').addEventListener('click', expand);
  U.$('peek-split').addEventListener('click', toSplit);
  U.$('peek-overlay').addEventListener('mousedown', (e) => {
    if (e.target === U.$('peek-overlay')) close();
  });
}

ctx.peek = { setup, open, close, isOpen };
