// Site info: the lock-icon popover (connection, permissions, Shields, zoom, Boost,
// cookies) and the Settings → Site settings list of per-site exceptions.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

let popover = null;
let release = null;
let shown = null; // { tab, url } the open popover describes

// Icons only this popover uses (same 24x24 stroke style as U.ICONS)
const svg = (body) => `<svg viewBox="0 0 24 24">${body}</svg>`;
const OWN_ICONS = {
  lock: svg('<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  unlock: svg('<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'),
  info: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
  mic: svg('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/>'),
  pin: svg('<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>'),
  bell: svg('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
  cookie: svg('<path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5z"/><circle cx="8.5" cy="8.5" r=".5"/><circle cx="16" cy="15.5" r=".5"/><circle cx="12" cy="12" r=".5"/><circle cx="11" cy="17" r=".5"/><circle cx="7" cy="14" r=".5"/>'),
  search: U.ICONS.search,
};
function icon(name) {
  if (!OWN_ICONS[name]) return U.icon(name);
  const span = document.createElement('span');
  span.innerHTML = OWN_ICONS[name];
  return span.firstChild;
}

const PERMISSIONS = [
  ['camera', 'Camera', 'camera'],
  ['microphone', 'Microphone', 'mic'],
  ['location', 'Location', 'pin'],
  ['notifications', 'Notifications', 'bell'],
];
const KIND_LABELS = {
  'media:video': 'Camera', 'media:audio': 'Microphone', 'media:audio+video': 'Camera & microphone',
  geolocation: 'Location', notifications: 'Notifications', midi: 'MIDI', midiSysex: 'MIDI',
  'clipboard-read': 'Clipboard', 'idle-detection': 'Idle detection', 'window-management': 'Window management',
};

const siteHost = (url) => U.hostOf(url).replace(/^www\./, '');

/* ------------------------------------------------------------------ */
/* Popover                                                             */
/* ------------------------------------------------------------------ */

function closePopover() {
  if (!popover) return;
  popover.remove();
  popover = null;
  shown = null;
  if (release) release();
  release = null;
  document.removeEventListener('mousedown', outside, true);
}

function outside(e) {
  if (popover && !popover.contains(e.target) && !e.target.closest('#security-icon')) closePopover();
}

function row(iconName, label, hint, control) {
  const r = U.el('div', 'settings-row siteinfo-row');
  const text = U.el('div', 'settings-label');
  text.appendChild(U.el('span', null, label));
  if (hint) text.appendChild(U.el('small', null, hint));
  r.append(icon(iconName), text);
  if (control) r.appendChild(control);
  return r;
}

function permissionSelect(value, onChange) {
  const s = U.el('select', 'settings-select siteinfo-select');
  for (const [v, label] of [['ask', 'Ask'], ['allow', 'Allow'], ['block', 'Block']]) {
    const o = U.el('option', null, label);
    o.value = v;
    s.appendChild(o);
  }
  s.value = value === true ? 'allow' : value === false ? 'block' : 'ask';
  s.addEventListener('change', () => onChange(s.value === 'allow' ? true : s.value === 'block' ? false : null));
  return s;
}

async function openPopover() {
  if (popover) {
    closePopover();
    return;
  }
  const tab = ctx.tabs.activeTab();
  if (!tab || tab.kind !== 'web' || !tab.url || U.isNewTabUrl(tab.url)) return;
  ctx.privacy.closePopover();
  const url = tab.url;
  const isWeb = /^https?:/i.test(url);
  const secure = url.startsWith('https://');
  const host = isWeb ? new URL(url).hostname : ''; // cookies, certificate
  const site = isWeb ? siteHost(url) : ''; // zoom key and title (keeps a port)
  const shieldsHost = host.replace(/^www\./, ''); // what the blocker matches
  const origin = isWeb ? new URL(url).origin : '';
  const wcId = tab.webContentsId;

  const [perms, shieldsOn, cookies] = isWeb
    ? await Promise.all([
      ipcRenderer.invoke('permissions-site-get', { origin, webContentsId: wcId }),
      ipcRenderer.invoke('shields-site-get', shieldsHost),
      ipcRenderer.invoke('site-cookies', { host, webContentsId: wcId }),
    ])
    : [{}, true, { count: null }];
  if (popover || ctx.tabs.activeTab() !== tab) return; // clicked again or switched tabs while loading

  popover = U.el('div', 'popover siteinfo-popover');
  const header = U.el('div', 'popover-header');
  const title = U.el('div', 'popover-title');
  title.append(icon(!isWeb ? 'info' : secure ? 'lock' : 'unlock'), U.el('span', null, site || U.displayUrl(url)));
  header.appendChild(title);
  popover.appendChild(header);

  // Connection
  const conn = U.el('div', `siteinfo-conn ${!isWeb ? 'info' : secure ? 'secure' : 'insecure'}`);
  conn.appendChild(U.el('strong', null, !isWeb ? 'Local or internal page' : secure ? 'Connection is secure' : 'Connection is not secure'));
  const connHint = U.el('small', null, !isWeb
    ? 'This page isn’t loaded from the web.'
    : secure ? 'Information you send to this site is private.' : 'Don’t enter passwords or card details on this site — they could be seen by others.');
  conn.appendChild(connHint);
  if (secure) {
    const cert = U.el('small', 'siteinfo-cert', 'Checking certificate…');
    conn.appendChild(cert);
    ipcRenderer.invoke('site-certificate', { host, port: Number(new URL(url).port) || 443 }).then((info) => {
      cert.textContent = info && info.issuer ? `Certificate issued by ${info.issuer}${info.validTo ? ` · valid until ${new Date(info.validTo).toLocaleDateString()}` : ''}` : '';
      cert.hidden = !cert.textContent;
    });
  }
  popover.appendChild(conn);

  const reloadBtn = U.el('button', 'btn small primary', 'Reload');
  reloadBtn.hidden = true;
  reloadBtn.addEventListener('click', () => {
    closePopover();
    if (tab.ready) tab.webview.reload();
  });
  // Permission and Shields changes apply on the next load, like Chrome's "Reload to apply"
  const changed = () => { reloadBtn.hidden = false; };

  if (isWeb) {
    popover.appendChild(U.el('div', 'boost-label', 'Permissions'));
    for (const [name, label, iconName] of PERMISSIONS) {
      const sel = permissionSelect(perms[name], async (value) => {
        await ipcRenderer.invoke('permissions-site-set', { origin, name, value, webContentsId: wcId });
        changed();
        refreshSettings();
      });
      popover.appendChild(row(iconName, label, null, sel));
    }

    popover.appendChild(U.el('div', 'boost-label', 'This site'));
    const globalOn = ctx.settings.get('shields');
    const shieldsToggle = U.el('input', 'settings-toggle');
    shieldsToggle.type = 'checkbox';
    shieldsToggle.checked = shieldsOn;
    shieldsToggle.disabled = !globalOn;
    const shieldsRow = row('shield', 'Shields', globalOn ? (shieldsOn ? 'Blocking ads & trackers' : 'Allowed on this site') : 'Off everywhere — turn on in the Shields menu', shieldsToggle);
    shieldsToggle.addEventListener('change', async () => {
      await ipcRenderer.invoke('shields-site-set', { host: shieldsHost, enabled: shieldsToggle.checked });
      shieldsRow.querySelector('small').textContent = shieldsToggle.checked ? 'Blocking ads & trackers' : 'Allowed on this site';
      ctx.nav.updateShields();
      changed();
      refreshSettings();
    });
    popover.appendChild(shieldsRow);
  }

  // Zoom (remembered per site)
  const zoomBox = U.el('div', 'siteinfo-zoom');
  const pct = U.el('span', 'siteinfo-pct');
  const level = () => ctx.page.zoomSites()[site] || 0;
  const step = (dir) => {
    const cur = level();
    const steps = ctx.page.ZOOM_STEPS;
    const next = dir > 0 ? steps.find((s) => s > cur) ?? cur : dir < 0 ? [...steps].reverse().find((s) => s < cur) ?? cur : 0;
    ctx.page.setSiteZoom(site, next);
    renderZoom();
    refreshSettings();
  };
  const minus = U.el('button', 'chip', '−');
  const plus = U.el('button', 'chip', '+');
  const reset = U.el('button', 'chip', 'Reset');
  minus.title = 'Zoom out';
  plus.title = 'Zoom in';
  minus.addEventListener('click', () => step(-1));
  plus.addEventListener('click', () => step(1));
  reset.addEventListener('click', () => step(0));
  const renderZoom = () => {
    pct.textContent = `${ctx.page.zoomPercent(level())}%`;
    reset.disabled = !level();
  };
  renderZoom();
  zoomBox.append(minus, pct, plus, reset);
  if (isWeb) popover.appendChild(row('search', 'Zoom', null, zoomBox));

  if (isWeb) {
    // Boost
    const boost = ctx.boosts.boostFor(url);
    const boostBtn = U.el('button', 'btn small', boost ? 'Edit' : 'Create');
    boostBtn.addEventListener('click', () => {
      closePopover();
      ctx.boosts.openPanel();
    });
    popover.appendChild(row('wand', 'Boost', boost ? (boost.enabled ? 'On for this site' : 'Paused for this site') : 'Restyle this site', boostBtn));

    // Cookies & site data
    const n = cookies && cookies.count;
    const clearBtn = U.el('button', 'btn small', 'Clear…');
    const cookieRow = row('cookie', 'Cookies and site data', n == null ? null : `${n} cookie${n === 1 ? '' : 's'} in use`, clearBtn);
    clearBtn.addEventListener('click', async () => {
      closePopover();
      const ok = await U.dialog({
        title: `Clear cookies and site data for ${site}?`,
        message: 'You’ll be signed out of this site, and its saved data (like preferences or offline files) will be deleted. This page will reload.',
        confirmLabel: 'Clear',
        danger: true,
        input: false,
      });
      if (!ok) return;
      await ipcRenderer.invoke('site-clear-data', { host, webContentsId: wcId });
      if (tab.ready) tab.webview.reload();
      U.toast(`Cleared cookies and site data for ${site}`);
    });
    popover.appendChild(cookieRow);
  }

  const footer = U.el('div', 'popover-footer siteinfo-footer');
  const all = U.el('button', 'btn small', 'All site settings');
  all.addEventListener('click', () => {
    closePopover();
    // An already-open Settings window keeps its old list, so redraw it
    ctx.settings.open('site-settings').then(refreshSettings);
  });
  footer.append(all, reloadBtn);
  popover.appendChild(footer);

  document.body.appendChild(popover);
  const r = U.$('omnibox').getBoundingClientRect();
  popover.style.left = `${ctx.sidebar.popoverLeft(r, popover.offsetWidth)}px`;
  popover.style.top = `${r.bottom + 8}px`;
  popover.style.maxHeight = `${window.innerHeight - r.bottom - 24}px`;
  shown = { tab, url };
  release = U.pushEscape(closePopover);
  document.addEventListener('mousedown', outside, true);
}

/* ------------------------------------------------------------------ */
/* Settings → Site settings                                            */
/* ------------------------------------------------------------------ */

// Close the popover once the active tab or its page changes (it describes one page)
function sync(tab) {
  if (shown && (shown.tab !== tab || !tab || shown.url !== tab.url)) closePopover();
}

// Redraw Settings → Site settings if it's open (after a change made somewhere else)
function refreshSettings() {
  if (settingsBox && settingsBox.isConnected) renderSettings(settingsBox);
}

// Every site with a saved permission, a Shields exception or a custom zoom, one row per
// host (Shields match the bare host name, zoom and permissions keep a port, so a row
// remembers each key it stands for); a private window also lists its in-memory choices
const portOf = (host) => (host.match(/:(\d+)$/) || [])[1];
const bareHost = (host) => host.replace(/:\d+$/, '').replace(/^www\./, '');

async function collectSites() {
  const [perms, shieldsOff] = await Promise.all([
    ipcRenderer.invoke('permissions-list'),
    ipcRenderer.invoke('shields-site-list'),
  ]);
  const sites = new Map();
  const get = (host) => {
    const key = bareHost(host);
    if (!sites.has(key)) sites.set(key, { host: key, origins: new Set(), shieldsHosts: [], zoomHosts: [], items: [] });
    return sites.get(key);
  };
  for (const p of perms) {
    let host;
    try { host = new URL(p.origin).host; } catch { continue; }
    const s = get(host);
    s.origins.add(p.origin);
    const where = [p.origin.startsWith('http://') && 'http', portOf(host) && `port ${portOf(host)}`].filter(Boolean).join(', ');
    s.items.push(`${KIND_LABELS[p.kind] || p.kind}${where ? ` (${where})` : ''}: ${p.allow ? 'Allowed' : 'Blocked'}`);
  }
  for (const host of shieldsOff) {
    const s = get(host);
    s.shieldsHosts.push(host);
    s.items.push('Shields off');
  }
  for (const [host, level] of Object.entries(ctx.page.zoomSites())) {
    if (!level) continue;
    const s = get(host);
    s.zoomHosts.push(host);
    s.items.push(`Zoom ${ctx.page.zoomPercent(level)}%${portOf(host) ? ` (port ${portOf(host)})` : ''}`);
  }
  return [...sites.values()].sort((a, b) => a.host.localeCompare(b.host));
}

async function forgetSite(s) {
  for (const origin of s.origins) await ipcRenderer.invoke('permissions-site-clear', { origin });
  for (const host of s.shieldsHosts) await ipcRenderer.invoke('shields-site-set', { host, enabled: true });
  if (s.shieldsHosts.length) ctx.nav.updateShields();
  for (const host of s.zoomHosts) ctx.page.setSiteZoom(host, 0);
}

let settingsBox = null;
async function renderSettings(container) {
  settingsBox = container;
  container.replaceChildren();
  container.appendChild(U.el('p', 'settings-hint', 'Sites where you’ve allowed or blocked a permission, turned Shields off, or changed the zoom. Click the lock in the address bar to change a site’s settings.'));
  const list = U.el('div', 'ext-list');
  container.appendChild(list);
  const sites = await collectSites();
  if (!sites.length) list.appendChild(U.el('div', 'ext-empty', 'No site exceptions yet.'));
  for (const s of sites) {
    const r = U.el('div', 'ext-row');
    const text = U.el('div', 'ext-text');
    text.append(U.el('span', 'ext-name', s.host), U.el('span', 'ext-version', s.items.join(' · ')));
    r.append(U.icon('globe'), text, U.iconButton('trash', `Reset settings for ${s.host}`, async () => {
      await forgetSite(s);
      U.toast(`Reset settings for ${s.host}`);
      renderSettings(container);
    }, 'h-delete'));
    list.appendChild(r);
  }
}

function setup() {
  const sec = U.$('security-icon');
  sec.removeAttribute('aria-hidden');
  sec.setAttribute('role', 'button');
  sec.setAttribute('aria-label', 'View site information');
  sec.title = 'View site information';
  // Reachable with Tab only when there's a site to describe
  const syncFocusable = () => {
    if (sec.dataset.state === 'search') sec.removeAttribute('tabindex');
    else sec.tabIndex = 0;
  };
  syncFocusable();
  new MutationObserver(syncFocusable).observe(sec, { attributes: true, attributeFilter: ['data-state'] });
  // Don't focus the address bar under it
  sec.addEventListener('mousedown', (e) => e.preventDefault());
  sec.addEventListener('click', (e) => {
    if (sec.dataset.state === 'search') return;
    e.preventDefault();
    e.stopPropagation();
    openPopover();
  });
  sec.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || sec.dataset.state === 'search') return;
    e.preventDefault();
    e.stopPropagation();
    openPopover();
  });
}

ctx.siteInfo = { setup, openPopover, closePopover, sync, renderSettings, refreshSettings };
