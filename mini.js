const { ipcRenderer } = require('electron');
const { resolveInput, compactUrl, iconElement, ICONS, NEWTAB_URL, isNewTabUrl } = require('./src/util');

const urlInput = document.getElementById('mini-url');
const iconEl = document.getElementById('mini-icon');
const promoteBtn = document.getElementById('mini-promote');

const startUrl = new URLSearchParams(window.location.search).get('url');

const webview = document.createElement('webview');
webview.setAttribute('allowpopups', '');
webview.setAttribute('src', startUrl || NEWTAB_URL);
webview.className = 'active';
document.getElementById('mini-content').appendChild(webview);

document.body.classList.add(`platform-${process.platform}`);
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const applyDark = () => document.body.classList.toggle('dark', darkQuery.matches);
darkQuery.addEventListener('change', applyDark);
applyDark();

let currentUrl = startUrl || NEWTAB_URL;
let favicon = null;
let loading = true;

function render() {
  iconEl.replaceChildren(loading ? Object.assign(document.createElement('div'), { className: 'spinner' }) : iconElement(favicon, ICONS.globe));
  if (document.activeElement !== urlInput) urlInput.value = compactUrl(currentUrl);
  promoteBtn.disabled = isNewTabUrl(currentUrl);
}

webview.addEventListener('did-start-loading', () => { loading = true; render(); });
webview.addEventListener('did-stop-loading', () => { loading = false; render(); });
webview.addEventListener('did-navigate', (e) => { currentUrl = e.url; favicon = null; render(); });
webview.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) { currentUrl = e.url; render(); } });
webview.addEventListener('page-favicon-updated', (e) => { favicon = e.favicons[0] || null; render(); });
webview.addEventListener('page-title-updated', (e) => { document.title = e.title; });

document.getElementById('mini-omnibox').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = resolveInput(urlInput.value);
  if (!url) return;
  webview.loadURL(url).catch(() => {});
  urlInput.blur();
});
urlInput.addEventListener('focus', () => {
  urlInput.value = isNewTabUrl(currentUrl) ? '' : currentUrl;
  urlInput.select();
});
urlInput.addEventListener('blur', render);

promoteBtn.addEventListener('click', () => ipcRenderer.send('mini-promote', currentUrl));

ipcRenderer.on('shortcut', (_e, action) => {
  if (action === 'close-tab' || action === 'escape') window.close();
  else if (action === 'focus-url') urlInput.focus();
  else if (action === 'reload') webview.reload();
});

render();
if (!startUrl) urlInput.focus();
