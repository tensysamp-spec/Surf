// Address and card autofill: offers saved addresses/cards when you focus a checkout
// field, and the "Addresses & cards" list in Settings. Data lives encrypted in the main
// process (main/autofill.js); this window only ever sees the last 4 digits of a card.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');
const { CLASSIFY_SOURCE } = require('./autofill-fields');

// Injected into pages. It only REPORTS that an address or card field got focus (a page can
// fake this): Surf then shows its own offer, and the fill happens in the main process in an
// isolated world (af-fill) after the user picks an entry — never through page code.
const PAGE_SCRIPT = `(() => {
  if (window.__afInstalled) return;
  window.__afInstalled = true;
  ${CLASSIFY_SOURCE}
  // A lone "name" or "email" box isn't a checkout form: addresses need a few address fields
  const addressForm = (el) => {
    const scope = el.form || document;
    let n = 0;
    for (const f of scope.querySelectorAll('input, select, textarea')) if (tokenKind(fieldToken(f)) === 'address' && ++n >= 3) return true;
    return false;
  };
  document.addEventListener('focusin', (e) => {
    const token = fieldToken(e.target);
    const kind = tokenKind(token);
    if (kind === 'card' || (kind === 'address' && addressForm(e.target))) console.debug('__AF__' + JSON.stringify({ kind }));
  }, true);
})()`;

const pageUrl = (url) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
};

const cardLabel = (c) => `${c.brand || 'Card'} •••• ${c.last4}`;
const expiryLabel = (c) => (c.expMonth && c.expYear ? `${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}` : '');
const addressLabel = (a) => [a.name, (a.street || '').split('\n')[0], a.city].filter(Boolean).join(', ') || a.email || 'Address';

/* ------------------------------------------------------------------ */
/* Offer bar                                                           */
/* ------------------------------------------------------------------ */

const dismissed = new WeakMap(); // tab -> Set of "kind url" offers already filled or dismissed
const CLICK_DELAY = 500; // ignore clicks this soon after the offer appears (no click-through)

async function onFocus(tab, kind) {
  const url = pageUrl(tab.url);
  if (!url || (kind === 'card' && url.protocol !== 'https:')) return;
  const key = `${kind} ${tab.url}`;
  const seen = dismissed.get(tab) || new Set();
  dismissed.set(tab, seen);
  if (seen.has(key)) return;
  const host = U.$('pw-prompt');
  // Don't replace a password offer, or this same offer
  if (!host.hidden && (host.dataset.kind === 'save' || host.dataset.kind === 'fill')) return;
  if (!host.hidden && host.dataset.kind === `af-${kind}` && host.dataset.tab === tab.entryId) return;
  const data = await ipcRenderer.invoke('af-list');
  const entries = kind === 'card' ? data.cards : data.addresses;
  if (!entries.length || tab.url !== url.href) return;

  host.replaceChildren();
  host.dataset.kind = `af-${kind}`;
  host.dataset.tab = tab.entryId;
  const shownAt = Date.now();
  const text = U.el('div', 'perm-text');
  text.append(U.icon(kind === 'card' ? 'card' : 'home'), U.el('span', null, kind === 'card' ? 'Fill a saved card?' : 'Fill a saved address?'));
  const close = () => { host.hidden = true; };
  const actions = U.el('div', 'perm-actions');
  const notNow = U.el('button', 'btn', 'Not now');
  notNow.addEventListener('click', () => {
    seen.add(key);
    close();
  });
  actions.appendChild(notNow);
  for (const entry of entries.slice(0, 3)) {
    const label = kind === 'card' ? cardLabel(entry) : addressLabel(entry);
    const btn = U.el('button', entries.length > 1 ? 'btn af-choice' : 'btn primary af-choice', label);
    btn.title = kind === 'card' ? `${entry.name || ''} ${expiryLabel(entry)}`.trim() : label;
    btn.addEventListener('click', async () => {
      if (Date.now() - shownAt < CLICK_DELAY) return;
      close();
      seen.add(key);
      if (tab.url !== url.href || !tab.webContentsId) return;
      const filled = await ipcRenderer.invoke('af-fill', { webContentsId: tab.webContentsId, kind, id: entry.id }).catch(() => 0);
      if (filled) {
        tab.webview.focus();
        if (kind === 'card') U.toast('Card filled — enter the security code yourself');
      } else {
        U.toast(`Couldn’t fill the ${kind === 'card' ? 'card' : 'address'} on this page`);
      }
    });
    actions.appendChild(btn);
  }
  host.append(text, actions);
  host.hidden = false;
}

function bindTab(tab) {
  const wv = tab.webview;
  wv.addEventListener('dom-ready', () => {
    if (pageUrl(tab.url)) wv.executeJavaScript(PAGE_SCRIPT).catch(() => {});
  });
  // An offer belongs to the page it was made for
  wv.addEventListener('did-navigate', () => {
    const host = U.$('pw-prompt');
    if (host.dataset.kind && host.dataset.kind.startsWith('af-') && host.dataset.tab === tab.entryId) host.hidden = true;
  });
  wv.addEventListener('console-message', (e) => {
    const message = e.message || '';
    if (!message.startsWith('__AF__')) return;
    let data;
    try {
      data = JSON.parse(message.slice(6));
    } catch {
      return;
    }
    if (data.kind === 'card' || data.kind === 'address') onFocus(tab, data.kind);
  });
}

/* ------------------------------------------------------------------ */
/* Settings: add / edit / delete                                       */
/* ------------------------------------------------------------------ */

// A small form dialog: fields [{ key, label, value, placeholder, wide, multiline, type }]
function formDialog(title, fields, { hint, confirmLabel = 'Save' } = {}) {
  return new Promise((resolve) => {
    const backdrop = U.el('div', 'dialog-backdrop');
    const box = U.el('form', 'dialog af-dialog');
    box.appendChild(U.el('h3', null, title));
    const grid = U.el('div', 'af-grid');
    const inputs = {};
    for (const f of fields) {
      const wrap = U.el('label', 'af-field' + (f.wide ? ' wide' : ''));
      wrap.appendChild(U.el('span', null, f.label));
      const input = U.el(f.multiline ? 'textarea' : 'input', 'dialog-input');
      if (!f.multiline) input.type = f.type || 'text';
      else input.rows = 2;
      input.value = f.value || '';
      input.placeholder = f.placeholder || '';
      input.spellcheck = false;
      input.autocomplete = 'off';
      if (f.inputMode) input.inputMode = f.inputMode;
      if (f.maxLength) input.maxLength = f.maxLength;
      inputs[f.key] = input;
      wrap.appendChild(input);
      grid.appendChild(wrap);
    }
    box.appendChild(grid);
    if (hint) box.appendChild(U.el('p', 'af-hint', hint));
    const actions = U.el('div', 'dialog-actions');
    const cancel = U.el('button', 'btn', 'Cancel');
    cancel.type = 'button';
    const ok = U.el('button', 'btn primary', confirmLabel);
    ok.type = 'submit';
    actions.append(cancel, ok);
    box.appendChild(actions);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    const finish = (result) => {
      release();
      U.removeAnimated(backdrop);
      resolve(result);
    };
    const release = U.pushEscape(() => finish(null));
    cancel.addEventListener('click', () => finish(null));
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) finish(null);
    });
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(Object.fromEntries(Object.entries(inputs).map(([k, input]) => [k, input.value.trim()])));
    });
    requestAnimationFrame(() => inputs[fields[0].key].focus());
  });
}

async function editAddress(address = {}) {
  const values = await formDialog(address.id ? 'Edit address' : 'Add address', [
    { key: 'name', label: 'Full name', value: address.name, wide: true },
    { key: 'organization', label: 'Organization', value: address.organization, wide: true },
    { key: 'street', label: 'Street address', value: address.street, wide: true, multiline: true },
    { key: 'city', label: 'City', value: address.city },
    { key: 'region', label: 'State / region', value: address.region },
    { key: 'postal', label: 'Postal code', value: address.postal },
    { key: 'country', label: 'Country', value: address.country },
    { key: 'email', label: 'Email', value: address.email, type: 'email' },
    { key: 'phone', label: 'Phone', value: address.phone, type: 'tel' },
  ]);
  if (!values) return false;
  const result = await ipcRenderer.invoke('af-save-address', { id: address.id, ...values });
  if (result.error) U.toast(result.error);
  return !result.error;
}

async function editCard(card = {}) {
  const values = await formDialog(card.id ? 'Edit card' : 'Add card', [
    { key: 'name', label: 'Name on card', value: card.name, wide: true },
    { key: 'number', label: 'Card number', placeholder: card.id ? `•••• ${card.last4} — leave empty to keep` : '1234 5678 9012 3456', wide: true, inputMode: 'numeric', maxLength: 23 },
    { key: 'expMonth', label: 'Expiry month', value: card.expMonth ? String(card.expMonth).padStart(2, '0') : '', placeholder: 'MM', inputMode: 'numeric', maxLength: 2 },
    { key: 'expYear', label: 'Expiry year', value: card.expYear ? String(card.expYear) : '', placeholder: 'YYYY', inputMode: 'numeric', maxLength: 4 },
  ], { hint: 'The security code (CVC) is never saved — you type it at checkout. Cards fill only on secure (https) pages.' });
  if (!values) return false;
  const result = await ipcRenderer.invoke('af-save-card', { id: card.id, ...values });
  if (result.error) U.toast(result.error);
  return !result.error;
}

async function renderManager(container) {
  const data = await ipcRenderer.invoke('af-list');
  container.replaceChildren();
  const refresh = () => renderManager(container);
  const row = (iconName, title, sub, onEdit, onDelete) => {
    const r = U.el('div', 'ext-row');
    const iconWrap = U.el('span', 'ext-icon');
    iconWrap.appendChild(U.icon(iconName));
    const text = U.el('div', 'ext-text');
    text.append(U.el('span', 'ext-name', title), U.el('span', 'ext-version', sub));
    const actions = U.el('div', 'ext-actions');
    actions.append(U.iconButton('edit', 'Edit', onEdit, 'h-delete'), U.iconButton('trash', 'Delete', onDelete, 'h-delete'));
    r.append(iconWrap, text, actions);
    return r;
  };
  const remove = async (kind, id, label) => {
    const ok = await U.dialog({ title: `Delete ${label}?`, confirmLabel: 'Delete', danger: true, input: false });
    if (!ok) return;
    await ipcRenderer.invoke('af-delete', { kind, id });
    refresh();
  };

  const list = U.el('div', 'ext-list');
  if (!data.addresses.length && !data.cards.length) list.appendChild(U.el('div', 'ext-empty', 'No addresses or cards saved yet.'));
  for (const a of data.addresses) {
    const sub = [(a.street || '').split('\n')[0], a.city, a.postal, a.country].filter(Boolean).join(', ') || a.email || a.phone || '';
    list.appendChild(row('home', a.name || a.organization || 'Address', sub,
      async () => { if (await editAddress(a)) refresh(); },
      () => remove('address', a.id, 'this address')));
  }
  for (const c of data.cards) {
    const sub = [c.name, expiryLabel(c) && `Expires ${expiryLabel(c)}`].filter(Boolean).join(' · ');
    list.appendChild(row('card', cardLabel(c), sub,
      async () => { if (await editCard(c)) refresh(); },
      () => remove('card', c.id, cardLabel(c))));
  }
  const buttons = U.el('div', 'boost-row');
  const addAddress = U.el('button', 'chip', 'Add address…');
  addAddress.addEventListener('click', async () => { if (await editAddress()) refresh(); });
  const addCard = U.el('button', 'chip', 'Add card…');
  addCard.addEventListener('click', async () => { if (await editCard()) refresh(); });
  buttons.append(addAddress, addCard);
  container.append(list, buttons);
}

ctx.autofill = { bindTab, renderManager };
