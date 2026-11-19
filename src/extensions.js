// Chrome extensions (basic): install from the Chrome Web Store (its own "Add to Chrome"
// button works) or a folder, open their popups/options, remove them. Content scripts run in every tab.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const STORE_URL = 'https://chromewebstore.google.com/';
let popover = null;
let release = null;
let cache = [];

async function list() {
  cache = await ipcRenderer.invoke('ext-list');
  U.$('extensions-btn').hidden = cache.length === 0;
  return cache;
}

function openPage(ext, page, anchor) {
  const rect = anchor ? anchor.getBoundingClientRect() : null;
  const x = rect ? window.screenX + rect.right + 8 : null;
  const y = rect ? window.screenY + Math.max(40, rect.top - 200) : null;
  ipcRenderer.send('ext-open-page', { id: ext.id, page, x, y });
}

async function remove(ext) {
  const ok = await U.dialog({ title: `Remove “${ext.name}”?`, confirmLabel: 'Remove', danger: true, input: false });
  if (!ok) return false;
  await ipcRenderer.invoke('ext-remove', ext.id);
  await list();
  U.toast(`Removed ${ext.name}`);
  return true;
}

// Shared list renderer (popover + settings)
function renderList(container, { onChange } = {}) {
  container.replaceChildren();
  if (!cache.length) {
    container.appendChild(U.el('div', 'ext-empty', 'No extensions yet.'));
    return;
  }
  for (const ext of cache) {
    const row = U.el('div', 'ext-row');
    const iconWrap = U.el('span', 'ext-icon');
    iconWrap.appendChild(U.iconElement(ext.icon, U.ICONS.layers));
    const text = U.el('div', 'ext-text');
    text.append(U.el('span', 'ext-name', ext.name), U.el('span', 'ext-version', `v${ext.version}`));
    row.append(iconWrap, text);
    const actions = U.el('div', 'ext-actions');
    if (ext.popup) {
      const btn = U.el('button', 'chip', 'Open');
      btn.addEventListener('click', () => {
        closePopover();
        openPage(ext, ext.popup, row);
      });
      actions.appendChild(btn);
    }
    if (ext.options) actions.appendChild(U.iconButton('settings', 'Options', () => { closePopover(); openPage(ext, ext.options, row); }, 'h-delete'));
    actions.appendChild(U.iconButton('trash', 'Remove', async () => {
      if (await remove(ext)) {
        renderList(container, { onChange });
        if (onChange) onChange();
      }
    }, 'h-delete'));
    row.appendChild(actions);
    container.appendChild(row);
  }
}

function openStore() {
  closePopover();
  ctx.tabs.openTab(STORE_URL);
}

// Install controls (settings)
function installControls(container, onInstalled) {
  const browse = U.el('div', 'settings-key');
  const storeBtn = U.el('button', 'btn primary', 'Open Chrome Web Store');
  storeBtn.addEventListener('click', () => {
    ctx.settings.close();
    openStore();
  });
  browse.appendChild(storeBtn);
  container.appendChild(browse);

  const row = U.el('div', 'settings-key');
  const input = U.el('input', 'dialog-input');
  input.placeholder = 'Chrome Web Store link or extension ID';
  input.spellcheck = false;
  const install = U.el('button', 'btn', 'Install');
  install.addEventListener('click', async () => {
    if (!input.value.trim()) return;
    install.disabled = true;
    install.textContent = 'Installing…';
    const result = await ipcRenderer.invoke('ext-install-store', input.value.trim());
    install.disabled = false;
    install.textContent = 'Install';
    if (result.error) {
      U.toast(result.error, { duration: 6000 });
      return;
    }
    input.value = '';
    await list();
    U.toast(`Installed ${result.ext.name}`);
    onInstalled();
  });
  const unpacked = U.el('button', 'btn', 'Load folder…');
  unpacked.title = 'Load an unpacked extension from a folder';
  unpacked.addEventListener('click', async () => {
    const result = await ipcRenderer.invoke('ext-load-unpacked');
    if (!result) return;
    if (result.error) {
      U.toast(result.error, { duration: 6000 });
      return;
    }
    await list();
    U.toast(`Loaded ${result.ext.name}`);
    onInstalled();
  });
  row.append(input, install, unpacked);
  container.appendChild(row);
}

function closePopover() {
  if (!popover) return;
  popover.remove();
  popover = null;
  if (release) release();
  release = null;
  document.removeEventListener('mousedown', outside, true);
}

function outside(e) {
  if (popover && !popover.contains(e.target) && !e.target.closest('#extensions-btn')) closePopover();
}

async function openPopover() {
  if (popover) {
    closePopover();
    return;
  }
  await list();
  popover = U.el('div', 'popover ext-popover');
  const header = U.el('div', 'popover-header');
  const title = U.el('div', 'popover-title');
  title.append(U.icon('layers'), U.el('span', null, 'Extensions'));
  header.appendChild(title);
  popover.appendChild(header);
  const listEl = U.el('div', 'ext-list');
  renderList(listEl);
  popover.appendChild(listEl);
  const footer = U.el('div', 'popover-footer');
  const store = U.el('button', 'btn primary', 'Chrome Web Store');
  store.addEventListener('click', openStore);
  footer.appendChild(store);
  const add = U.el('button', 'btn', 'Manage…');
  add.addEventListener('click', () => {
    closePopover();
    ctx.settings.open('extensions');
  });
  footer.appendChild(add);
  popover.appendChild(footer);
  document.body.appendChild(popover);

  const anchor = U.$('extensions-btn').hidden ? U.$('settings-btn') : U.$('extensions-btn');
  const r = anchor.getBoundingClientRect();
  popover.style.left = `${r.left}px`;
  popover.style.top = `${Math.max(12, r.top - popover.offsetHeight - 8)}px`;
  release = U.pushEscape(closePopover);
  document.addEventListener('mousedown', outside, true);
}

function setup() {
  U.$('extensions-btn').addEventListener('click', openPopover);
  // Installs/removals from the Chrome Web Store page, and loads at startup
  ipcRenderer.on('extensions-changed', async (_e, { installed } = {}) => {
    await list();
    if (installed) U.toast(`Added ${installed}`, { action: openPopover, actionLabel: 'Show' });
  });
  // Extensions load in the background at startup; check a moment later
  setTimeout(list, 1500);
}

ctx.extensions = { setup, list, renderList, installControls, openPopover, closePopover, openStore };
