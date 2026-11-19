// Addresses and payment cards for autofill. Stored encrypted with the macOS Keychain
// (safeStorage) in their own file, next to the password vault. Card numbers never go
// back to the window: it only sees the last 4 digits. CVCs are never stored or filled.

const { app, ipcMain, webContents, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { CLASSIFY_SOURCE } = require('../src/autofill-fields');

const ADDRESS_FIELDS = ['name', 'organization', 'street', 'city', 'region', 'postal', 'country', 'email', 'phone'];
const AF_WORLD = 4243;

module.exports = function setupAutofill(M) {
  const storeFile = () => path.join(app.getPath('userData'), 'autofill.bin');
  let store = null; // { addresses: [{ id, ...ADDRESS_FIELDS }], cards: [{ id, name, number, expMonth, expYear, brand }] }

  function load() {
    if (store) return store;
    try {
      store = JSON.parse(safeStorage.decryptString(fs.readFileSync(storeFile())));
    } catch {
      store = { addresses: [], cards: [] };
    }
    return store;
  }

  function save() {
    if (!safeStorage.isEncryptionAvailable()) return false;
    fs.writeFileSync(storeFile(), safeStorage.encryptString(JSON.stringify(store)), { mode: 0o600 });
    return true;
  }

  const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
  const fromBrowser = (event) => M.isBrowserWindow(M.windowOf(event.sender));

  function brandOf(number) {
    if (/^4/.test(number)) return 'Visa';
    if (/^(5[1-5]|2[2-7])/.test(number)) return 'Mastercard';
    if (/^3[47]/.test(number)) return 'Amex';
    if (/^(6011|65|64[4-9])/.test(number)) return 'Discover';
    if (/^35/.test(number)) return 'JCB';
    return 'Card';
  }

  function luhn(number) {
    let sum = 0;
    for (let i = 0; i < number.length; i++) {
      let d = Number(number[number.length - 1 - i]);
      if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
    }
    return sum % 10 === 0;
  }

  const maskCard = ({ id, name, number, expMonth, expYear, brand }) => ({ id, name, last4: number.slice(-4), expMonth, expYear, brand });

  ipcMain.handle('af-list', (event) => {
    if (!fromBrowser(event)) return { addresses: [], cards: [] };
    const s = load();
    return { addresses: s.addresses.map((a) => ({ ...a })), cards: s.cards.map(maskCard) };
  });

  ipcMain.handle('af-save-address', (event, input) => {
    if (!fromBrowser(event) || !input) return { error: 'Not allowed' };
    const s = load();
    const fields = Object.fromEntries(ADDRESS_FIELDS.map((k) => [k, clean(input[k], k === 'street' ? 400 : 200)]));
    if (!ADDRESS_FIELDS.some((k) => fields[k])) return { error: 'The address is empty' };
    const existing = input.id && s.addresses.find((a) => a.id === input.id);
    if (existing) Object.assign(existing, fields);
    else s.addresses.push({ id: newId(), ...fields });
    return save() ? { ok: true } : { error: 'Secure storage isn’t available' };
  });

  // A card being edited may leave the number blank to keep the saved one
  ipcMain.handle('af-save-card', (event, input) => {
    if (!fromBrowser(event) || !input) return { error: 'Not allowed' };
    const s = load();
    const existing = input.id && s.cards.find((c) => c.id === input.id);
    const typed = String(input.number || '').replace(/[\s-]/g, '');
    if (typed && !(/^\d{12,19}$/.test(typed) && luhn(typed))) return { error: 'That doesn’t look like a valid card number' };
    if (!typed && !existing) return { error: 'Enter the card number' };
    const month = Number(input.expMonth);
    let year = Number(input.expYear);
    if (year && year < 100) year += 2000;
    if (input.expMonth && !(month >= 1 && month <= 12)) return { error: 'The expiry month should be 1–12' };
    if (input.expYear && !(year >= 2000 && year < 2100)) return { error: 'The expiry year doesn’t look right' };
    const fields = { name: clean(input.name), expMonth: month || null, expYear: year || null };
    if (typed) Object.assign(fields, { number: typed, brand: brandOf(typed) });
    if (existing) Object.assign(existing, fields);
    else s.cards.push({ id: newId(), ...fields });
    return save() ? { ok: true } : { error: 'Secure storage isn’t available' };
  });

  ipcMain.handle('af-delete', (event, { kind, id }) => {
    if (!fromBrowser(event)) return false;
    const s = load();
    if (kind === 'card') s.cards = s.cards.filter((c) => c.id !== id);
    else s.addresses = s.addresses.filter((a) => a.id !== id);
    return save();
  });

  /* ---------------------------------------------------------------- */
  /* Filling                                                          */
  /* ---------------------------------------------------------------- */

  // Runs in an isolated world in the top frame, after the user picked an entry in Surf's
  // own UI. Fills only fields of the kind asked for (address or card), within the form
  // that has focus (or the whole page), and never a security code.
  const FILL_SCRIPT = (kind, values, requireHttps) => `(() => {
    if (window !== window.top) return 0;
    if (${requireHttps} && location.protocol !== 'https:') return 0;
    ${CLASSIFY_SOURCE}
    const values = ${JSON.stringify(values)};
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const proto = { INPUT: HTMLInputElement, SELECT: HTMLSelectElement, TEXTAREA: HTMLTextAreaElement };
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const pickOption = (select, wanted) => {
      const options = [...select.options];
      for (const w of wanted.filter(Boolean).map(norm)) {
        const hit = options.find((o) => norm(o.value) === w || norm(o.textContent) === w)
          || (w.length > 3 && options.find((o) => norm(o.textContent).startsWith(w)));
        if (hit) return hit.value;
      }
      return null;
    };
    const expiry = (el) => {
      const hint = ((el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
      const long = /yyyy|jjjj|aaaa/.test(hint) || (el.maxLength >= 7 && !/yy/.test(hint));
      const mm = String(values.expMonth || '').padStart(2, '0');
      const yy = String(values.expYear || '');
      return mm && yy ? mm + (/ \\/ /.test(hint) ? ' / ' : '/') + (long ? yy : yy.slice(-2)) : null;
    };
    const valueFor = (token, el) => {
      const isSelect = el.tagName === 'SELECT';
      switch (token) {
        case 'cc-exp': return values.expMonth && values.expYear ? expiry(el) : null;
        case 'cc-exp-month': return isSelect ? pickOption(el, [String(values.expMonth).padStart(2, '0'), String(values.expMonth)]) : values.expMonth ? String(values.expMonth).padStart(2, '0') : null;
        case 'cc-exp-year': {
          const y = String(values.expYear || '');
          if (!y) return null;
          return isSelect ? pickOption(el, [y, y.slice(-2)]) : (el.maxLength > 0 && el.maxLength <= 2 ? y.slice(-2) : y);
        }
        case 'street-address': return el.tagName === 'TEXTAREA' ? values.street : (values.street || '').split('\\n').join(', ');
        case 'address-line1': return (values.street || '').split('\\n')[0];
        case 'address-line2': return (values.street || '').split('\\n').slice(1).join(', ');
        case 'country': case 'country-name': return isSelect ? pickOption(el, [values.country]) : values.country;
        case 'address-level1': return isSelect ? pickOption(el, [values.region]) : values.region;
        default: {
          const v = values[token];
          return isSelect && v ? pickOption(el, [v]) : v;
        }
      }
    };
    const active = document.activeElement;
    const scope = (active && active.form) || document;
    let filled = 0;
    for (const el of scope.querySelectorAll('input, select, textarea')) {
      const token = fieldToken(el);
      if (!token || token === 'cc-csc' || tokenKind(token) !== ${JSON.stringify(kind)} || !visible(el)) continue;
      const v = valueFor(token, el);
      if (v == null || v === '') continue;
      // This world's own (untouched) setter, so frameworks like React notice the change
      Object.getOwnPropertyDescriptor(proto[el.tagName].prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      filled++;
    }
    return filled;
  })()`;

  // Values keyed by autocomplete token
  function addressValues(a) {
    const words = (a.name || '').split(/\s+/).filter(Boolean);
    return {
      name: a.name,
      'given-name': words.length > 1 ? words.slice(0, -1).join(' ') : words[0] || '',
      'family-name': words.length > 1 ? words[words.length - 1] : '',
      organization: a.organization,
      street: a.street,
      'address-level2': a.city,
      region: a.region,
      'postal-code': a.postal,
      country: a.country,
      email: a.email,
      tel: a.phone,
      'tel-national': a.phone,
    };
  }

  function cardValues(c) {
    const words = (c.name || '').split(/\s+/).filter(Boolean);
    return {
      'cc-name': c.name,
      'cc-given-name': words.slice(0, -1).join(' ') || words[0] || '',
      'cc-family-name': words.length > 1 ? words[words.length - 1] : '',
      'cc-number': c.number,
      expMonth: c.expMonth,
      expYear: c.expYear,
    };
  }

  ipcMain.handle('af-fill', async (event, { webContentsId, kind, id }) => {
    if (!fromBrowser(event)) return 0;
    // Only a tab (<webview>) inside the window that asked
    const contents = webContents.fromId(webContentsId);
    if (!contents || contents.isDestroyed() || contents.getType() !== 'webview' || !contents.hostWebContents || contents.hostWebContents.id !== event.sender.id) return 0;
    let url = null;
    try {
      url = new URL(contents.getURL());
    } catch { /* no page */ }
    if (!url || !/^https?:$/.test(url.protocol)) return 0;
    const s = load();
    let values;
    if (kind === 'card') {
      if (url.protocol !== 'https:') return 0;
      const card = s.cards.find((c) => c.id === id);
      if (!card) return 0;
      values = cardValues(card);
    } else {
      const address = s.addresses.find((a) => a.id === id);
      if (!address) return 0;
      values = addressValues(address);
    }
    try {
      const filled = await contents.executeJavaScriptInIsolatedWorld(AF_WORLD, [{ code: FILL_SCRIPT(kind === 'card' ? 'card' : 'address', values, kind === 'card') }]);
      return Number(filled) || 0;
    } catch {
      return 0;
    }
  });
};
