// Shields popover (per-site toggle, global toggle) and the privacy report.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

let popover = null;
let release = null;

function closePopover() {
  if (!popover) return;
  popover.remove();
  popover = null;
  if (release) release();
  release = null;
  document.removeEventListener('mousedown', outside, true);
}

function outside(e) {
  if (popover && !popover.contains(e.target) && !e.target.closest('#shields-btn')) closePopover();
}

async function openPopover() {
  if (popover) {
    closePopover();
    return;
  }
  const tab = ctx.tabs.activeTab();
  const isWeb = tab && tab.kind === 'web' && /^https?:/i.test(tab.url || '');
  const host = isWeb ? U.hostOf(tab.url).replace(/^www\./, '') : null;
  const siteOn = host ? await ipcRenderer.invoke('shields-site-get', host) : true;
  const globalOn = ctx.settings.get('shields');
  const privacy = await ipcRenderer.invoke('privacy-settings-get');
  const bannerStatus = isWeb && tab.webContentsId ? await ipcRenderer.invoke('privacy-banner-status', tab.webContentsId) : null;

  popover = U.el('div', 'popover shields-popover');
  const header = U.el('div', 'popover-header');
  const title = U.el('div', 'popover-title');
  title.append(U.icon('shield'), U.el('span', null, host || 'Shields'));
  header.appendChild(title);
  popover.appendChild(header);

  const count = U.el('div', 'shields-count');
  count.appendChild(U.el('strong', null, String(isWeb ? tab.blocked || 0 : 0)));
  count.appendChild(U.el('span', null, ' ads & trackers blocked on this page'));
  popover.appendChild(count);

  if (host) {
    const row = U.el('label', 'settings-row');
    const label = U.el('div', 'settings-label');
    label.append(U.el('span', null, `Shields for ${host}`), U.el('small', null, siteOn ? 'Blocking ads & trackers' : 'Allowed on this site'));
    const toggle = U.el('input', 'settings-toggle');
    toggle.type = 'checkbox';
    toggle.checked = siteOn;
    toggle.disabled = !globalOn;
    toggle.addEventListener('change', async () => {
      await ipcRenderer.invoke('shields-site-set', { host, enabled: toggle.checked });
      closePopover();
      if (tab.ready) tab.webview.reload();
      U.toast(toggle.checked ? `Shields up on ${host}` : `Shields down on ${host} — reloading`);
    });
    row.append(label, toggle);
    popover.appendChild(row);
  }

  if (host && privacy.cookieBanners !== 'off') popover.appendChild(bannerRow(tab, host, privacy, bannerStatus));

  const globalRow = U.el('label', 'settings-row');
  const globalLabel = U.el('div', 'settings-label');
  globalLabel.append(U.el('span', null, 'Shields everywhere'));
  const globalToggle = U.el('input', 'settings-toggle');
  globalToggle.type = 'checkbox';
  globalToggle.checked = globalOn;
  globalToggle.addEventListener('change', () => {
    closePopover();
    ctx.nav.toggleShields();
  });
  globalRow.append(globalLabel, globalToggle);
  popover.appendChild(globalRow);

  const footer = U.el('div', 'popover-footer');
  const reportBtn = U.el('button', 'btn', 'Privacy report');
  reportBtn.addEventListener('click', () => {
    closePopover();
    openReport();
  });
  footer.appendChild(reportBtn);
  popover.appendChild(footer);

  document.body.appendChild(popover);
  const r = U.$('omnibox').getBoundingClientRect();
  popover.style.left = `${ctx.sidebar.popoverLeft(r, popover.offsetWidth)}px`;
  popover.style.top = `${r.bottom + 8}px`;
  release = U.pushEscape(closePopover);
  document.addEventListener('mousedown', outside, true);
}

function barList(title, entries, total) {
  const section = U.el('div', 'report-section');
  section.appendChild(U.el('h4', null, title));
  if (!entries.length) {
    section.appendChild(U.el('p', 'settings-hint', 'Nothing yet.'));
    return section;
  }
  const max = entries[0][1];
  for (const [name, count] of entries) {
    const row = U.el('div', 'report-row');
    const label = U.el('div', 'report-label');
    label.append(U.el('span', null, name), U.el('span', 'report-count', count.toLocaleString()));
    const bar = U.el('div', 'progress');
    const fill = U.el('div', 'progress-fill');
    fill.style.width = `${Math.max(3, (count / max) * 100)}%`;
    bar.appendChild(fill);
    row.append(label, bar);
    section.appendChild(row);
  }
  return section;
}

async function openReport() {
  const stats = await ipcRenderer.invoke('privacy-report');
  const backdrop = U.el('div', 'modal-backdrop');
  const box = U.el('div', 'modal');
  backdrop.appendChild(box);
  const close = () => {
    backdrop.remove();
    releaseReport();
  };
  const releaseReport = U.pushEscape(close);

  const header = U.el('div', 'modal-header');
  header.append(U.el('h2', null, 'Privacy report'), U.iconButton('close', 'Close', close));
  box.appendChild(header);
  const body = U.el('div', 'modal-body');
  box.appendChild(body);

  const days = Math.max(1, Math.round((Date.now() - stats.since) / 86400000));
  const hero = U.el('div', 'report-hero');
  hero.appendChild(U.el('div', 'report-big', stats.total.toLocaleString()));
  hero.appendChild(U.el('div', 'settings-hint', `ads & trackers blocked in the last ${days} day${days === 1 ? '' : 's'} — about ${Math.round(stats.total * 0.04).toLocaleString()} MB of data and ${Math.round((stats.total * 0.06) / 60).toLocaleString()} minutes of loading saved (rough estimate)`));
  body.appendChild(hero);
  if (stats.banners) body.appendChild(U.el('p', 'settings-hint report-banners', `${stats.banners.toLocaleString()} cookie banner${stats.banners === 1 ? '' : 's'} handled for you`));

  const top = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 8);
  body.appendChild(barList('Most blocked trackers', top(stats.trackers), stats.total));
  body.appendChild(barList('Sites with the most trackers', top(stats.sites), stats.total));

  const reset = U.el('button', 'btn', 'Reset report');
  reset.addEventListener('click', async () => {
    await ipcRenderer.invoke('privacy-reset');
    close();
    U.toast('Privacy report reset');
  });
  const footer = U.el('div', 'popover-footer');
  footer.appendChild(reset);
  body.appendChild(footer);

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.body.appendChild(backdrop);
}

/* ------------------------------------------------------------------ */
/* Cookie banners (the work happens in main/privacy-preload.js)        */
/* ------------------------------------------------------------------ */

const BANNER_STATUS = { rejected: 'Cookie banner rejected on this page', hidden: 'Cookie banner hidden on this page' };

function bannerRow(tab, host, privacy, status) {
  const siteOn = !privacy.bannerOffHosts.includes(host.replace(/:\d+$/, ''));
  const row = U.el('label', 'settings-row');
  const label = U.el('div', 'settings-label');
  const hint = !siteOn ? 'Left alone on this site' : BANNER_STATUS[status] || (privacy.cookieBanners === 'reject' ? 'Rejected when possible, otherwise hidden' : 'Hidden');
  label.append(U.el('span', null, 'Handle cookie banners'), U.el('small', null, hint));
  const toggle = U.el('input', 'settings-toggle');
  toggle.type = 'checkbox';
  toggle.checked = siteOn;
  toggle.addEventListener('change', async () => {
    await ipcRenderer.invoke('privacy-banner-site-set', { host, enabled: toggle.checked });
    closePopover();
    if (tab.ready) tab.webview.reload();
    U.toast(toggle.checked ? `Cookie banners handled on ${host}` : `Cookie banners left alone on ${host} — reloading`);
  });
  row.append(label, toggle);
  return row;
}

/* ------------------------------------------------------------------ */
/* HTTPS-only mode: the page shown when a site has no secure version   */
/* ------------------------------------------------------------------ */

const upgrades = new Map(); // webContentsId -> { from, to } for the last upgraded load

ipcRenderer.on('https-upgraded', (_e, { webContentsId, from, to }) => upgrades.set(webContentsId, { from, to }));

// Called by the page's error handling: true when the failed load was an http page we
// upgraded, in which case this page replaces the usual error page
function httpsFailed(tab, e) {
  // A new tab whose first load fails has no webContentsId yet (it's set on dom-ready)
  let id = tab.webContentsId;
  try { id = id || tab.webview.getWebContentsId(); } catch { /* not attached */ }
  const upgrade = upgrades.get(id);
  if (!upgrade) return false;
  const failed = e.validatedURL || '';
  const sameHost = U.hostOf(failed) === U.hostOf(upgrade.from);
  if (failed !== upgrade.to && !sameHost) return false;
  upgrades.delete(id);
  showHttpsPage(tab, upgrade.from);
  return true;
}

// The https page redirected back to http (main stopped it; no load error follows)
ipcRenderer.on('https-only-failed', (_e, { webContentsId }) => {
  const upgrade = upgrades.get(webContentsId);
  const tab = [...ctx.tabs.live.values()].find((t) => {
    try { return (t.webContentsId || t.webview.getWebContentsId()) === webContentsId; } catch { return false; }
  });
  if (!upgrade || !tab) return;
  upgrades.delete(webContentsId);
  showHttpsPage(tab, upgrade.from);
});

function clearPage(tab) {
  if (tab.errorEl) tab.errorEl.remove();
  tab.errorEl = null;
}

function showHttpsPage(tab, httpUrl) {
  const host = U.hostOf(httpUrl);
  const page = U.el('div', 'error-page tab-overlay https-only-page');
  const box = U.el('div', 'error-box');
  box.appendChild(U.icon('shield'));
  box.appendChild(U.el('h2', null, 'This site doesn’t support a secure connection'));
  box.appendChild(U.el('p', 'error-host', host));
  box.appendChild(U.el('p', null, 'HTTPS-only mode tried a secure (https) version of this page and couldn’t load one. Over http, others on your network could see or change what you send and receive.'));
  const actions = U.el('div', 'error-actions');
  const back = U.el('button', 'btn primary', 'Go back');
  back.addEventListener('click', () => {
    clearPage(tab);
    if (tab.webview.canGoBack()) tab.webview.goBack();
    else ctx.tabs.loadInTab(tab, U.NEWTAB_URL);
  });
  const proceed = U.el('button', 'btn', 'Continue to http');
  proceed.addEventListener('click', async () => {
    await ipcRenderer.invoke('https-exception-add', host);
    clearPage(tab);
    ctx.tabs.loadInTab(tab, httpUrl);
  });
  actions.append(back, proceed);
  box.appendChild(actions);
  box.appendChild(U.el('p', 'settings-hint', U.PRIVATE
    ? 'Continuing allows http for this site until you close this private window.'
    : 'Continuing allows http for this site from now on; remove it in Settings → Privacy.'));
  page.appendChild(box);
  clearPage(tab);
  tab.errorEl = page;
  U.$('webviews-container').appendChild(page);
  ctx.page.syncOverlays();
}

/* ------------------------------------------------------------------ */
/* Settings → Privacy                                                  */
/* ------------------------------------------------------------------ */

async function renderSettings(body, { field, select, toggle }) {
  let settings = await ipcRenderer.invoke('privacy-settings-get');
  const set = async (key, value) => {
    settings = await ipcRenderer.invoke('privacy-settings-set', { key, value });
  };

  body.appendChild(field('Handle cookie banners', select(
    [['reject', 'Reject when possible'], ['hide', 'Hide only'], ['off', 'Off']],
    settings.cookieBanners,
    (v) => set('cookieBanners', v),
  ), 'Hides consent pop-ups from OneTrust, Cookiebot, Quantcast, Didomi, Usercentrics, TrustArc, Sourcepoint and Google, and clicks their “Reject all” or “Necessary only” button when there is one — never “Accept”. Turn it off for one site from the shield in the address bar.'));

  body.appendChild(field('HTTPS-only mode', toggle(settings.httpsOnly, (v) => set('httpsOnly', v)), 'Opens every site over a secure connection. If a site has no https version, you’re asked before it loads over http.'));
  const exceptions = U.el('div', 'ext-list https-exceptions');
  const renderExceptions = () => {
    exceptions.replaceChildren();
    exceptions.hidden = !settings.httpsExceptions.length;
    for (const host of settings.httpsExceptions) {
      const row = U.el('div', 'ext-row');
      const text = U.el('div', 'ext-text');
      text.append(U.el('span', 'ext-name', host), U.el('span', 'ext-version', 'Allowed over http'));
      row.append(U.icon('globe'), text, U.iconButton('trash', 'Remove exception', async () => {
        await set('httpsExceptions', settings.httpsExceptions.filter((h) => h !== host));
        renderExceptions();
      }, 'h-delete'));
      exceptions.appendChild(row);
    }
  };
  renderExceptions();
  body.appendChild(exceptions);

  body.appendChild(field('Fingerprinting protection', select(
    [['private', 'In private windows'], ['always', 'In all windows'], ['off', 'Off']],
    settings.fingerprinting,
    (v) => set('fingerprinting', v),
  ), 'Makes this browser look more like others: pages see 4 or 8 processor cores and 8 GB of memory, sites get no detailed browser, OS or hardware versions (high-entropy client hints), and a third-party frame that reads back what it drew on a canvas gets a blank image (captcha and payment frames excepted). Applies from the next page load.'));

  body.appendChild(field('Global Privacy Control', toggle(settings.gpc, (v) => set('gpc', v)), 'Tells sites not to sell or share your data: sends “Sec-GPC: 1” and sets navigator.globalPrivacyControl. Laws in some places, such as California, require sites to honor it.'));
}

ctx.privacy = { openPopover, closePopover, openReport, httpsFailed, renderSettings };
