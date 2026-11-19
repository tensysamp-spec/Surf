// Password manager: offers to save logins when you sign in, fills them when you
// focus a login field. Passwords are encrypted with the macOS Keychain (main process).

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const T = () => ctx.tabs;

// Injected into pages. It reports sign-ins and login-field focus through a console
// message the browser listens for; credentials are only ever filled by the browser.
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
  window.__bpFill = (username, password) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const set = (el, v) => {
      if (!el || v == null) return;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const pw = [...document.querySelectorAll('input[type=password]')].find(visible) || document.querySelector('input[type=password]');
    const user = pw ? findUser(pw) : document.querySelector('input[type=email], input[autocomplete=username]');
    set(user, username);
    set(pw, password);
  };
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

const filledPages = new WeakMap(); // tab -> url already filled

async function onFocus(tab) {
  const origin = originOf(tab.url);
  if (!origin || filledPages.get(tab) === tab.url) return;
  const logins = await ipcRenderer.invoke('pw-for-origin', origin);
  if (!logins.length) return;
  if (logins.length === 1) {
    fill(tab, logins[0]);
    return;
  }
  // Several accounts: let the user choose
  const host = U.$('pw-prompt');
  host.replaceChildren();
  const text = U.el('div', 'perm-text');
  text.append(U.icon('key'), U.el('span', null, `Sign in to ${U.hostOf(origin)} as`));
  const actions = U.el('div', 'perm-actions');
  for (const login of logins.slice(0, 4)) {
    const btn = U.el('button', 'btn', login.username || '(no username)');
    btn.addEventListener('click', () => {
      host.hidden = true;
      fill(tab, login);
    });
    actions.appendChild(btn);
  }
  host.append(text, actions);
  host.hidden = false;
}

function fill(tab, login) {
  filledPages.set(tab, tab.url);
  tab.webview.executeJavaScript(`window.__bpFill && window.__bpFill(${JSON.stringify(login.username)}, ${JSON.stringify(login.password)})`).catch(() => {});
}

function bindTab(tab) {
  const wv = tab.webview;
  wv.addEventListener('dom-ready', () => {
    if (originOf(tab.url)) wv.executeJavaScript(PAGE_SCRIPT).catch(() => {});
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

ctx.passwords = { bindTab, renderManager };
