// Updates: the "Surf 1.1 is available" card and the Settings → Updates section. Checking
// happens in main/updates.js; this side only shows what it finds. Surf is unsigned, so
// Download just fetches the release's .zip into the downloads shelf.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

// "1.1.0" reads as "1.1"; "1.1.2" stays as is
const shortVersion = (v) => String(v).replace(/^(\d+\.\d+)\.0$/, '$1');

function openInTab(url) {
  window.focus();
  ctx.tabs.openTab(url);
}

// Download through the current tab's session so Surf's downloads + shelf take it. Not by
// opening the .zip in a tab: that tab would stay behind and download again on every restore.
function download(update) {
  window.focus();
  const tab = ctx.tabs.activeTab();
  if (tab && tab.webview && tab.webview.isConnected && typeof tab.webview.downloadURL === 'function') {
    tab.webview.downloadURL(update.downloadUrl);
    U.toast(`Downloading Surf ${shortVersion(update.version)}…`);
  } else {
    openInTab(update.downloadUrl);
  }
}

let card = null;

function hideCard() {
  if (!card) return;
  U.removeAnimated(card, 160);
  card = null;
}

function showCard(update) {
  if (U.PRIVATE || !update) return;
  hideCard();
  card = U.el('div', 'update-card');
  card.setAttribute('role', 'status');
  const head = U.el('div', 'update-head');
  head.append(U.icon('sparkles'), U.el('span', 'update-title', `Surf ${shortVersion(update.version)} is available`));
  head.appendChild(U.iconButton('close', 'Dismiss', hideCard, 'icon-btn small update-close'));
  const actions = U.el('div', 'update-actions');
  const notes = U.el('button', 'btn small', 'What’s new');
  notes.addEventListener('click', () => openInTab(update.notesUrl));
  const get = U.el('button', 'btn small primary', 'Download');
  get.addEventListener('click', () => {
    download(update);
    hideCard();
  });
  const skip = U.el('button', 'update-skip', 'Skip this version');
  skip.addEventListener('click', () => {
    ipcRenderer.send('updates-skip', update.version);
    hideCard();
  });
  actions.append(skip, notes, get);
  card.append(head, actions);
  U.$('content').appendChild(card);
}

// Settings → Updates: version, a manual check, and the automatic-check toggle
async function renderSettings(body, { field, toggle }) {
  const state = await ipcRenderer.invoke('updates-state');
  body.appendChild(field('Current version', U.el('span', 'update-version', `Surf ${state.version}`)));

  const checkBtn = U.el('button', 'btn update-check-btn', 'Check for updates');
  const result = U.el('div', 'update-result');
  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    result.replaceChildren(U.el('span', 'update-note', 'Checking…'));
    const answer = await ipcRenderer.invoke('updates-check').catch(() => ({ status: 'error' }));
    checkBtn.disabled = false;
    result.replaceChildren();
    if (answer.status === 'current') {
      result.appendChild(U.el('span', 'update-note ok', 'You’re up to date'));
    } else if (answer.status === 'available') {
      const { update } = answer;
      const notes = U.el('button', 'btn small', 'What’s new');
      notes.addEventListener('click', () => openInTab(update.notesUrl));
      const get = U.el('button', 'btn small primary', 'Download');
      get.addEventListener('click', () => download(update));
      result.append(U.el('span', 'update-note', `Surf ${shortVersion(update.version)} is available`), notes, get);
    } else {
      result.appendChild(U.el('span', 'update-note', 'Couldn’t check — try again later'));
    }
  });
  // A div, not field()'s <label>: clicking the result text shouldn't press the button again
  const checkRow = U.el('div', 'settings-row');
  const checkText = U.el('div', 'settings-label');
  checkText.append(U.el('span', null, 'Updates'), U.el('small', null, 'Surf isn’t signed, so it doesn’t update itself: Download gets the new version to move into Applications.'), result);
  checkRow.append(checkText, checkBtn);
  body.appendChild(checkRow);
  body.appendChild(field('Check automatically', toggle(state.auto, (v) => ipcRenderer.send('updates-set-auto', v)), 'Looks for a new version when Surf starts and every few hours.'));
}

function setup() {
  ipcRenderer.on('update-available', (_e, update) => showCard(update));
  // An update found before this window loaded (or while it was closed)
  if (!U.PRIVATE) ipcRenderer.invoke('updates-state').then((s) => s.pending && showCard(s.pending)).catch(() => {});
}

ctx.updates = { setup, renderSettings, showCard, hideCard };
