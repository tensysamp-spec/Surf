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

ctx.privacy = { openPopover, closePopover, openReport };
