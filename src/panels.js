// Web panels: small always-available web apps (chat, music, notes…) docked
// beside the page. They stay loaded while hidden, like Vivaldi/Opera panels.

const ctx = require('./ctx');
const U = require('./util');

const KEY = 'browser.panels';
// Phone-style layout fits a narrow panel much better
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const SUGGESTED = [
  { title: 'WhatsApp', url: 'https://web.whatsapp.com' },
  { title: 'ChatGPT', url: 'https://chatgpt.com' },
  { title: 'Claude', url: 'https://claude.ai' },
  { title: 'Spotify', url: 'https://open.spotify.com' },
  { title: 'Google Calendar', url: 'https://calendar.google.com' },
  { title: 'Messenger', url: 'https://www.messenger.com' },
];

let panels = U.store.get(KEY, []);
let openId = null;
const views = new Map(); // panel id -> webview

const save = () => U.store.set(KEY, panels);

function renderButtons() {
  const bar = U.$('panel-buttons');
  bar.replaceChildren();
  for (const p of panels) {
    const btn = U.el('button', 'panel-btn' + (p.id === openId ? ' active' : ''));
    btn.title = p.title;
    btn.appendChild(U.iconElement(p.favicon || `https://icons.duckduckgo.com/ip3/${U.hostOf(p.url)}.ico`, U.ICONS.panel));
    btn.addEventListener('click', () => toggle(p.id));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      U.contextMenu([
        { header: p.title },
        { label: 'Reload', icon: 'reload', action: () => views.get(p.id) && views.get(p.id).reload() },
        { label: 'Open as tab', icon: 'external', action: () => ctx.tabs.openTab(currentUrl(p)) },
        { separator: true },
        { label: 'Remove panel', icon: 'trash', danger: true, action: () => remove(p.id) },
      ], e.clientX, e.clientY);
    });
    bar.appendChild(btn);
  }
}

const currentUrl = (p) => {
  const wv = views.get(p.id);
  try {
    return (wv && wv.getURL()) || p.url;
  } catch {
    return p.url;
  }
};

function viewFor(p) {
  if (views.has(p.id)) return views.get(p.id);
  const wv = document.createElement('webview');
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('useragent', MOBILE_UA);
  if (U.PRIVATE_PARTITION) wv.setAttribute('partition', U.PRIVATE_PARTITION);
  wv.setAttribute('src', p.url);
  wv.className = 'panel-webview';
  wv.addEventListener('page-favicon-updated', (e) => {
    if (e.favicons[0] && p.favicon !== e.favicons[0]) {
      p.favicon = e.favicons[0];
      save();
      renderButtons();
    }
  });
  U.$('web-panel-body').appendChild(wv);
  views.set(p.id, wv);
  return wv;
}

function show(id) {
  const p = panels.find((x) => x.id === id);
  if (!p) return;
  openId = id;
  const wv = viewFor(p);
  for (const [pid, view] of views) view.classList.toggle('active', pid === id);
  U.$('web-panel-title').textContent = p.title;
  document.body.classList.add('panel-open');
  renderButtons();
  wv.focus();
}

function hide() {
  openId = null;
  document.body.classList.remove('panel-open');
  renderButtons();
}

function toggle(id) {
  if (openId === id) hide();
  else show(id);
}

function remove(id) {
  const wv = views.get(id);
  if (wv) wv.remove();
  views.delete(id);
  panels = panels.filter((p) => p.id !== id);
  save();
  if (openId === id) hide();
  else renderButtons();
}

function add(url, title) {
  const resolved = U.resolveInput(url);
  if (!resolved || !/^https?:/i.test(resolved)) return;
  const p = { id: U.uid(), url: resolved, title: title || U.compactUrl(resolved), favicon: null };
  panels.push(p);
  save();
  show(p.id);
  U.toast(`Added ${p.title} as a panel`);
}

function addCurrent() {
  const tab = ctx.tabs.activeTab();
  if (!tab || tab.kind !== 'web' || U.isNewTabUrl(tab.url)) {
    U.toast('Open the site you want as a panel first');
    return;
  }
  add(tab.url, tab.title);
}

function addMenu(x, y) {
  const existing = new Set(panels.map((p) => U.hostOf(p.url)));
  U.contextMenu([
    { header: 'Add web panel' },
    { label: 'Current page', icon: 'plus', action: addCurrent },
    { label: 'Other site…', icon: 'globe', action: async () => {
      const url = await U.dialog({ title: 'Add web panel', placeholder: 'e.g. web.whatsapp.com', confirmLabel: 'Add' });
      if (url) add(url);
    } },
    { separator: true },
    ...SUGGESTED.filter((s) => !existing.has(U.hostOf(s.url))).map((s) => ({ label: s.title, icon: 'panel', action: () => add(s.url, s.title) })),
  ], x, y);
}

function setup() {
  U.$('add-panel-btn').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    addMenu(r.left, r.top - 8);
  });
  U.$('close-panel-btn').addEventListener('click', hide);
  U.$('panel-open-tab-btn').addEventListener('click', () => {
    const p = panels.find((x) => x.id === openId);
    if (p) ctx.tabs.openTab(currentUrl(p));
  });
  U.$('panel-reload-btn').addEventListener('click', () => {
    const wv = views.get(openId);
    if (wv) wv.reload();
  });
  renderButtons();
}

ctx.panels = { setup, addCurrent, addMenu, toggle, hide };
