// Password manager: offers to save logins when you sign in, fills them when you
// focus a login field. Passwords are encrypted with the macOS Keychain (main process).

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const T = () => ctx.tabs;

// Injected into pages. It reports sign-ins and login-field focus through a console
// message the browser listens for. It runs in the page's own world, so the page can fake
// these messages: a focus message only offers a fill in Surf's UI, and the fill itself is
// done by the main process in an isolated world (pw-fill), never through page code.
const PAGE_SCRIPT = `(() => {
  if (window.__bpInstalled) return;
  window.__bpInstalled = true;
  const send = (type, data) => console.debug('__BP__' + JSON.stringify({ type, ...data }));
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const findUser = (pw) => {
    const scope = pw.form || document;
    const inputs = [...scope.querySelectorAll('input')].filter((i) => ['text', 'email', 'tel', ''].includes(i.type) && visible(i));
    const before = inputs.filter((i) => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
    return before[before.length - 1] || inputs[0] || null;
  };
  let lastSent = '';
  const capture = () => {
    const pw = [...document.querySelectorAll('input[type=password]')].find((p) => p.value);
    if (!pw) return;
    const user = findUser(pw);
    const key = (user ? user.value : '') + '\\u0000' + pw.value;
    if (key === lastSent) return;
    lastSent = key;
    send('submit', { username: user ? user.value : '', password: pw.value });
  };
  document.addEventListener('submit', capture, true);
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('button, input[type=submit], [role=button]')) setTimeout(capture, 0); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target && e.target.type === 'password') capture(); }, true);
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (!t || t.tagName !== 'INPUT') return;
    // A password field, or a text/email field on a page or form that has one
    const scope = t.form || document;
    const isLogin = t.type === 'password' || (['text', 'email', 'tel', ''].includes(t.type) && (/username|email/.test(t.autocomplete || '') || scope.querySelector('input[type=password]')));
    if (isLogin) send('focus', {});
  }, true);
})()`;

const originOf = (url) => {
  try {
    const u = new URL(url);
    return /^https:$|^http:$/.test(u.protocol) && (u.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(u.hostname)) ? u.origin : null;
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ */
/* Save prompt                                                         */
/* ------------------------------------------------------------------ */

const offered = new Set();

async function onSubmit(tab, { username, password }) {
  const origin = originOf(tab.url);
  if (!origin || !password || U.PRIVATE) return;
  const key = `${origin}\u0000${username}\u0000${password}`;
  if (offered.has(key)) return;
  offered.add(key);
  const state = await ipcRenderer.invoke('pw-should-offer', { origin, username, password });
  if (state === 'never' || state === 'saved') return;
  showSavePrompt(origin, username, password, state === 'update');
}

function showSavePrompt(origin, username, password, isUpdate) {
  const host = U.$('pw-prompt');
  host.replaceChildren();
  host.dataset.kind = 'save';
  const text = U.el('div', 'perm-text');
  text.appendChild(U.icon('key'));
  const msg = U.el('span');
  msg.appendChild(document.createTextNode(isUpdate ? 'Update the saved password for ' : 'Save password for '));
  msg.appendChild(U.el('strong', null, username || U.hostOf(origin)));
  if (username) msg.appendChild(document.createTextNode(` on ${U.hostOf(origin)}`));
  msg.appendChild(document.createTextNode('?'));
  text.appendChild(msg);

  const close = () => { host.hidden = true; };
  const actions = U.el('div', 'perm-actions');
  const never = U.el('button', 'btn', 'Never for this site');
  never.addEventListener('click', async () => { await ipcRenderer.invoke('pw-never', origin); close(); });
  const notNow = U.el('button', 'btn', 'Not now');
  notNow.addEventListener('click', close);
  const saveBtn = U.el('button', 'btn primary', isUpdate ? 'Update' : 'Save');
  saveBtn.addEventListener('click', async () => {
    const ok = await ipcRenderer.invoke('pw-save', { origin, username, password });
    close();
    U.toast(ok ? 'Password saved — encrypted with your Keychain' : 'Couldn’t save: secure storage isn’t available');
  });
  actions.append(never, notNow, saveBtn);
  host.append(text, actions);
  host.hidden = false;
  setTimeout(close, 30000);
}

/* ------------------------------------------------------------------ */
/* Autofill                                                            */
/* ------------------------------------------------------------------ */

const filledPages = new WeakMap(); // tab -> url already filled (or the offer dismissed)
const CLICK_DELAY = 500; // ignore clicks this soon after the offer appears (no click-through)

// A login field got focus: offer the saved accounts in Surf's own UI. Nothing is filled
// until the user clicks one, since the page can send this message whenever it likes.
async function onFocus(tab) {
  const origin = originOf(tab.url);
  if (!origin || filledPages.get(tab) === tab.url) return;
  const logins = await ipcRenderer.invoke('pw-for-origin', origin);
  if (!logins.length || originOf(tab.url) !== origin) return;
  const host = U.$('pw-prompt');
  if (!host.hidden && host.dataset.kind === 'save') return; // don't replace a save offer
  if (!host.hidden && host.dataset.kind === 'fill' && host.dataset.tab === tab.entryId) return;
  host.replaceChildren();
  host.dataset.kind = 'fill';
  host.dataset.tab = tab.entryId;
  const shownAt = Date.now();
  const text = U.el('div', 'perm-text');
  text.append(U.icon('key'), U.el('span', null, `Fill saved password for ${U.hostOf(origin)}${logins.length > 1 ? ' as' : '?'}`));
  const close = () => { host.hidden = true; };
  const actions = U.el('div', 'perm-actions');
  const notNow = U.el('button', 'btn', 'Not now');
  notNow.addEventListener('click', () => {
    filledPages.set(tab, tab.url);
    close();
  });
  actions.appendChild(notNow);
  for (const login of logins.slice(0, 4)) {
    const btn = U.el('button', logins.length > 1 ? 'btn' : 'btn primary', logins.length > 1 ? login.username || '(no username)' : `Fill${login.username ? ` as ${login.username}` : ''}`);
    btn.addEventListener('click', () => {
      if (Date.now() - shownAt < CLICK_DELAY) return;
      close();
      fill(tab, login, origin);
    });
    actions.appendChild(btn);
  }
  host.append(text, actions);
  host.hidden = false;
}

// The main process checks the tab is still on the login's origin and fills it in an isolated world
async function fill(tab, login, origin) {
  if (originOf(tab.url) !== origin || !tab.webContentsId) return;
  filledPages.set(tab, tab.url);
  const ok = await ipcRenderer.invoke('pw-fill', { webContentsId: tab.webContentsId, id: login.id }).catch(() => false);
  if (ok) tab.webview.focus();
  else U.toast('Couldn’t fill the password on this page');
}

function bindTab(tab) {
  const wv = tab.webview;
  wv.addEventListener('dom-ready', () => {
    if (originOf(tab.url)) wv.executeJavaScript(PAGE_SCRIPT).catch(() => {});
  });
  // A fill offer belongs to the page it was made for
  wv.addEventListener('did-navigate', () => {
    const host = U.$('pw-prompt');
    if (host.dataset.kind === 'fill' && host.dataset.tab === tab.entryId) host.hidden = true;
  });
  wv.addEventListener('console-message', (e) => {
    const message = e.message || '';
    if (!message.startsWith('__BP__')) return;
    let data;
    try {
      data = JSON.parse(message.slice(6));
    } catch {
      return;
    }
    if (data.type === 'submit') onSubmit(tab, data);
    else if (data.type === 'focus') onFocus(tab);
  });
}

/* ------------------------------------------------------------------ */
/* Settings: saved passwords                                           */
/* ------------------------------------------------------------------ */

async function renderManager(container) {
  container.replaceChildren();
  const list = await ipcRenderer.invoke('pw-list');
  if (!list.length) {
    container.appendChild(U.el('div', 'ext-empty', 'No saved passwords yet. Sign in to a site and choose Save.'));
    return;
  }
  for (const login of list.sort((a, b) => a.origin.localeCompare(b.origin))) {
    const row = U.el('div', 'ext-row');
    const iconWrap = U.el('span', 'ext-icon');
    iconWrap.appendChild(U.iconElement(`https://icons.duckduckgo.com/ip3/${U.hostOf(login.origin)}.ico`, U.ICONS.key));
    const text = U.el('div', 'ext-text');
    text.append(U.el('span', 'ext-name', U.hostOf(login.origin)), U.el('span', 'ext-version', login.username || '(no username)'));
    const actions = U.el('div', 'ext-actions');
    const copy = U.el('button', 'chip', 'Copy password');
    copy.addEventListener('click', async () => {
      const result = await ipcRenderer.invoke('pw-reveal', login.id);
      if (result.password) {
        ipcRenderer.send('copy-text', result.password);
        U.toast('Password copied');
      } else if (result.error !== 'cancelled') {
        U.toast(result.error);
      }
    });
    actions.appendChild(copy);
    actions.appendChild(U.iconButton('trash', 'Delete', async () => {
      const ok = await U.dialog({ title: `Delete the password for ${login.username || U.hostOf(login.origin)}?`, confirmLabel: 'Delete', danger: true, input: false });
      if (!ok) return;
      await ipcRenderer.invoke('pw-delete', login.id);
      renderManager(container);
    }, 'h-delete'));
    row.append(iconWrap, text, actions);
    container.appendChild(row);
  }
}

// Import from / export to CSV. The file dialogs, parsing and writing all happen in the main
// process: passwords never pass through this window. (Hidden in private windows.)
function transferControls(listContainer) {
  const row = U.el('div', 'boost-row');
  const importBtn = U.el('button', 'chip', 'Import from CSV…');
  importBtn.addEventListener('click', async () => {
    importBtn.disabled = true;
    const result = await ipcRenderer.invoke('pw-import').catch((err) => ({ error: err.message }));
    importBtn.disabled = false;
    if (result.cancelled) return;
    if (result.error) {
      U.toast(`Import failed: ${result.error}`, { duration: 6000 });
      return;
    }
    const imported = result.added + result.updated;
    const parts = [`Imported ${imported} password${imported === 1 ? '' : 's'}`];
    if (result.updated) parts.push(`${result.updated} updated`);
    if (result.skipped) parts.push(`${result.skipped} skipped`);
    U.toast(parts.join(', '), { duration: 6000 });
    renderManager(listContainer);
  });
  const exportBtn = U.el('button', 'chip', 'Export…');
  exportBtn.addEventListener('click', async () => {
    const result = await ipcRenderer.invoke('pw-export').catch((err) => ({ error: err.message }));
    if (result.cancelled) return;
    if (result.error) U.toast(result.error, { duration: 6000 });
    else U.toast(`Exported ${result.count} password${result.count === 1 ? '' : 's'} — the file isn’t encrypted, delete it when you’re done`, { duration: 7000 });
  });
  row.append(importBtn, exportBtn);
  return row;
}

ctx.passwords = { bindTab, renderManager, transferControls };
