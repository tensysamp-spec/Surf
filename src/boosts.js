// Boosts: per-site restyling — dark mode, color shift, font, custom CSS, and "zap" to hide elements.

const ctx = require('./ctx');
const U = require('./util');

const KEY = 'browser.boosts';
let boosts = U.store.get(KEY, {}); // host -> boost
let panel = null;
let release = null;

const FONTS = {
  '': 'Site default',
  system: 'System',
  serif: 'Serif',
  mono: 'Mono',
  rounded: 'Rounded',
};
const FONT_STACKS = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif',
  serif: '"New York", "Iowan Old Style", Georgia, Cambria, "Times New Roman", serif',
  mono: '"SF Mono", ui-monospace, Menlo, Consolas, "Liberation Mono", monospace',
  rounded: '"SF Pro Rounded", ui-rounded, "Nunito", "Varela Round", sans-serif',
};

const save = () => U.store.set(KEY, boosts);
const hostKey = (url) => U.hostOf(url).replace(/^www\./, '');

function boostFor(url) {
  return boosts[hostKey(url)] || null;
}

function isActiveFor(url) {
  const b = boostFor(url);
  return !!b && b.enabled && hasEffects(b);
}

function hasEffects(b) {
  return b.dark || b.hue || b.font || (b.css && b.css.trim()) || (b.zapped && b.zapped.length);
}

function buildCss(b) {
  const parts = [];
  const filters = [];
  if (b.dark) filters.push('invert(1) hue-rotate(180deg)');
  if (b.hue) filters.push(`hue-rotate(${b.hue}deg)`);
  if (filters.length) {
    parts.push(`html { filter: ${filters.join(' ')} !important; background: #fff !important; }`);
    if (b.dark) {
      // Undo the inversion for media so photos and videos look normal
      parts.push('img, video, picture, canvas, iframe, embed, object, [style*="background-image"] { filter: invert(1) hue-rotate(180deg) !important; }');
    }
  }
  if (b.font && FONT_STACKS[b.font]) {
    parts.push(`body, body *:not(pre):not(code):not(kbd):not(samp):not([class*="icon"]):not([class*="Icon"]):not(i):not(.material-icons) { font-family: ${FONT_STACKS[b.font]} !important; }`);
  }
  for (const selector of b.zapped || []) parts.push(`${selector} { display: none !important; }`);
  if (b.css) parts.push(b.css);
  return parts.join('\n');
}

async function apply(tab) {
  if (!tab || tab.kind !== 'web') return;
  const wv = tab.webview;
  if (tab.boostKey) {
    try { await wv.removeInsertedCSS(tab.boostKey); } catch { /* page navigated */ }
    tab.boostKey = null;
  }
  const b = boostFor(tab.url);
  if (!b || !b.enabled || !hasEffects(b)) return;
  try {
    tab.boostKey = await wv.insertCSS(buildCss(b));
  } catch { /* page not ready */ }
}

function applyToHost(host) {
  for (const tab of ctx.tabs.live.values()) {
    if (tab.kind === 'web' && hostKey(tab.url) === host) apply(tab);
  }
  ctx.nav.update();
}

/* ------------------------------------------------------------------ */
/* Zap: click elements on the page to hide them                        */
/* ------------------------------------------------------------------ */

// Runs inside the page; resolves with a CSS selector for the clicked element (or null on Escape)
const ZAP_SCRIPT = `new Promise((resolve) => {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #e5484d;background:rgba(229,72,77,.15);border-radius:4px;transition:all .06s';
  const tip = document.createElement('div');
  tip.textContent = 'Click an element to hide it · Esc to cancel';
  tip.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1d1b24;color:#fff;font:13px -apple-system,sans-serif;padding:8px 14px;border-radius:999px;pointer-events:none;box-shadow:0 6px 24px rgba(0,0,0,.25)';
  document.documentElement.append(box, tip);
  let target = null;
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'));
  const selectorFor = (el) => {
    if (el.id && document.querySelectorAll('#' + esc(el.id)).length === 1) return '#' + esc(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id && document.querySelectorAll('#' + esc(node.id)).length === 1) { parts.unshift('#' + esc(node.id)); break; }
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    if (node === document.body) parts.unshift('body');
    return parts.join(' > ');
  };
  const move = (e) => {
    target = e.target;
    if (target === box || target === tip) return;
    const r = target.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  };
  const finish = (value) => {
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('click', click, true);
    document.removeEventListener('keydown', key, true);
    box.remove();
    tip.remove();
    resolve(value);
  };
  const click = (e) => {
    e.preventDefault();
    e.stopPropagation();
    finish(target ? selectorFor(target) : null);
  };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(null); } };
  document.addEventListener('mousemove', move, true);
  document.addEventListener('click', click, true);
  document.addEventListener('keydown', key, true);
})`;

async function zap() {
  const tab = ctx.tabs.activeTab();
  if (!tab || tab.kind !== 'web') return;
  closePanel();
  tab.webview.focus();
  let selector = null;
  try {
    selector = await tab.webview.executeJavaScript(ZAP_SCRIPT, true);
  } catch { /* navigated away */ }
  if (!selector) return;
  const host = hostKey(tab.url);
  const b = boosts[host] || newBoost();
  b.enabled = true;
  b.zapped = [...(b.zapped || []), selector];
  boosts[host] = b;
  save();
  applyToHost(host);
  U.toast('Element hidden', { action: () => { b.zapped.pop(); save(); applyToHost(host); }, actionLabel: 'Undo' });
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

function newBoost() {
  return { enabled: true, dark: false, hue: 0, font: '', css: '', zapped: [] };
}

function closePanel() {
  if (!panel) return;
  panel.remove();
  panel = null;
  if (release) release();
  release = null;
  document.removeEventListener('mousedown', outside, true);
}

function outside(e) {
  if (panel && !panel.contains(e.target) && !e.target.closest('#boost-btn')) closePanel();
}

function openPanel() {
  const tab = ctx.tabs.activeTab();
  if (!tab || tab.kind !== 'web' || U.isNewTabUrl(tab.url)) return;
  closePanel();
  const host = hostKey(tab.url);
  const b = { ...newBoost(), ...(boosts[host] || {}) };
  const commit = () => {
    boosts[host] = b;
    save();
    applyToHost(host);
  };

  panel = U.el('div', 'popover boost-panel');
  const header = U.el('div', 'popover-header');
  const title = U.el('div', 'popover-title');
  title.append(U.icon('wand'), U.el('span', null, `Boost ${host}`));
  const enabled = U.el('input', 'settings-toggle');
  enabled.type = 'checkbox';
  enabled.checked = b.enabled;
  enabled.title = 'Enable boost for this site';
  enabled.addEventListener('change', () => { b.enabled = enabled.checked; commit(); });
  header.append(title, enabled);
  panel.appendChild(header);

  // Color: dark mode + hue
  const colorRow = U.el('div', 'boost-row');
  const darkBtn = U.el('button', 'chip' + (b.dark ? ' active' : ''), 'Dark mode');
  darkBtn.addEventListener('click', () => { b.dark = !b.dark; darkBtn.classList.toggle('active', b.dark); commit(); });
  colorRow.appendChild(darkBtn);
  panel.appendChild(U.el('div', 'boost-label', 'Color'));
  panel.appendChild(colorRow);
  const hue = U.el('input', 'hue-slider');
  hue.type = 'range';
  hue.min = 0;
  hue.max = 360;
  hue.value = b.hue || 0;
  hue.title = 'Shift the site’s colors';
  hue.addEventListener('input', () => { b.hue = Number(hue.value); commit(); });
  panel.appendChild(hue);

  // Font
  panel.appendChild(U.el('div', 'boost-label', 'Font'));
  const fontRow = U.el('div', 'boost-row');
  for (const [key, label] of Object.entries(FONTS)) {
    const chip = U.el('button', 'chip' + (b.font === key ? ' active' : ''), label);
    if (FONT_STACKS[key]) chip.style.fontFamily = FONT_STACKS[key];
    chip.addEventListener('click', () => {
      b.font = key;
      fontRow.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
      commit();
    });
    fontRow.appendChild(chip);
  }
  panel.appendChild(fontRow);

  // Zap
  panel.appendChild(U.el('div', 'boost-label', 'Zap'));
  const zapRow = U.el('div', 'boost-row');
  const zapBtn = U.el('button', 'chip');
  zapBtn.append(U.icon('crop'), document.createTextNode(' Hide an element…'));
  zapBtn.addEventListener('click', zap);
  zapRow.appendChild(zapBtn);
  if (b.zapped.length) {
    const restore = U.el('button', 'chip', `Restore ${b.zapped.length}`);
    restore.addEventListener('click', () => { b.zapped = []; commit(); restore.remove(); });
    zapRow.appendChild(restore);
  }
  panel.appendChild(zapRow);

  // Custom CSS
  panel.appendChild(U.el('div', 'boost-label', 'Custom CSS'));
  const css = U.el('textarea', 'boost-css');
  css.spellcheck = false;
  css.placeholder = 'body { max-width: 900px; margin: auto; }';
  css.value = b.css || '';
  let cssTimer = null;
  css.addEventListener('input', () => {
    clearTimeout(cssTimer);
    cssTimer = setTimeout(() => { b.css = css.value; commit(); }, 300);
  });
  panel.appendChild(css);

  const footer = U.el('div', 'popover-footer');
  const reset = U.el('button', 'btn', 'Reset boost');
  reset.addEventListener('click', () => {
    delete boosts[host];
    save();
    applyToHost(host);
    closePanel();
    U.toast(`Boost for ${host} removed`);
  });
  footer.appendChild(reset);
  panel.appendChild(footer);

  document.body.appendChild(panel);
  const anchor = U.$('omnibox').getBoundingClientRect();
  const sidebarHidden = document.body.classList.contains('sidebar-collapsed') && !document.body.classList.contains('sidebar-peek');
  panel.style.top = `${sidebarHidden ? 48 : anchor.bottom + 8}px`;
  panel.style.left = `${sidebarHidden ? (ctx.sidebar.isRight() ? window.innerWidth - panel.offsetWidth - 16 : 16) : ctx.sidebar.popoverLeft(anchor, panel.offsetWidth)}px`;
  release = U.pushEscape(closePanel);
  document.addEventListener('mousedown', outside, true);
}

function togglePanel() {
  if (panel) closePanel();
  else openPanel();
}

ctx.boosts = { apply, boostFor, isActiveFor, openPanel, closePanel, togglePanel, zap };
