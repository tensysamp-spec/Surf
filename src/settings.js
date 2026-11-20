// Settings: persisted preferences + the settings panel.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const KEY = 'browser.settings';
const DEFAULTS = {
  hibernateMinutes: 30,
  gestures: true,
  aiMemory: true,
  atcRules: [],
  appearance: 'system',
  linkTarget: 'little',
  translateTo: '',
  aiRenameDownloads: true,
  searchEngine: 'duckduckgo',
  archiveAfterHours: 12,
  autoPip: true,
  shields: true,
  sidebarPosition: 'left',
};

let values = { ...DEFAULTS, ...U.store.get(KEY, {}) };
// Carry over the shields toggle from the previous version
if (U.store.get('browser.shields', null) === false && !('shields' in U.store.get(KEY, {}))) values.shields = false;

const get = (key) => values[key];
function set(key, value) {
  values[key] = value;
  U.store.set(KEY, values);
}

// Shortcuts that aren't in the customizable table (main/shortcuts.js), shown below it
const SHORTCUTS = [
  ['⌘1–9', 'Go to tab'],
  ['⌃1–9', 'Go to space'],
  ['⌃Tab', 'Switch tabs (hold ⌃)'],
  ['F5', 'Reload'],
  ['⇧ over a link', 'AI link preview'],
  ['⇧-click', 'Open link in Peek'],
  ['Two-finger swipe', 'Back / forward (on the sidebar: switch space)'],
  ['Tab after “yt”, “gh”…', 'Search a site'],
  ['Right-drag ← → ↓ ↓→', 'Gestures: back, forward, new tab, close'],
];

// The Settings window: a real window (main lets this window open it) that this browser
// window's code draws into, so every section keeps working with the live tabs, sidebar etc.
let win = null;
let sections = []; // { id, title, el, nav }
let showSection = null;

const SECTION_ICONS = {
  appearance: 'palette', start: 'sparkles', default: 'globe', browsing: 'window', atc: 'send',
  passwords: 'key', autofill: 'card', privacy: 'shield', import: 'download', profiles: 'user',
  extensions: 'zap', ai: 'sparkles', 'ai-provider': 'brain', skills: 'wand', memory: 'brain', shortcuts: 'keyboard',
};

function close() {
  if (win && !win.closed) win.close();
}

// The Settings window looks like this window: same theme classes and space colors, kept in sync
function mirrorLook(doc) {
  const copy = () => {
    doc.body.className = `settings-window ${document.body.className}`;
    doc.documentElement.style.cssText = document.documentElement.style.cssText;
  };
  copy();
  const observer = new MutationObserver(copy);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  return observer;
}

function filterSections(query) {
  const q = query.trim().toLowerCase();
  for (const sec of sections) {
    const rows = sec.el.querySelectorAll('.settings-row, .ext-row, .settings-picker');
    const titleHit = !q || sec.title.toLowerCase().includes(q);
    let hits = 0;
    rows.forEach((row) => {
      const hit = titleHit || row.textContent.toLowerCase().includes(q);
      row.hidden = !hit;
      if (hit) hits++;
    });
    sec.match = titleHit || hits > 0;
    sec.nav.hidden = !sec.match;
  }
  if (q) {
    // Searching shows every matching section at once
    for (const sec of sections) sec.el.hidden = !sec.match;
    sections.forEach((sec) => sec.nav.classList.remove('active'));
  } else {
    showSection(sections.find((x) => x.nav.classList.contains('was-active'))?.id || sections[0].id);
  }
}

function field(label, control, hint) {
  const row = U.el('label', 'settings-row');
  const text = U.el('div', 'settings-label');
  text.appendChild(U.el('span', null, label));
  if (hint) text.appendChild(U.el('small', null, hint));
  row.append(text, control);
  return row;
}

function select(options, value, onChange) {
  const s = U.el('select', 'settings-select');
  for (const [v, label] of options) {
    const o = U.el('option', null, label);
    o.value = v;
    o.selected = String(v) === String(value);
    s.appendChild(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function toggle(value, onChange) {
  const t = U.el('input', 'settings-toggle');
  t.type = 'checkbox';
  t.checked = value;
  t.addEventListener('change', () => onChange(t.checked));
  return t;
}

async function open(section = null) {
  if (win && !win.closed) {
    win.focus();
    if (section && showSection) showSection(section);
    return;
  }
  win = window.open('about:blank', 'surf-settings');
  if (!win) return;
  const doc = win.document;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>Settings</title><link rel="stylesheet" href="${new URL('style.css', location.href).href}"></head><body></body></html>`);
  doc.close();
  const observer = mirrorLook(doc);
  U.setPopupDocument(doc);

  const shell = U.el('div', 'sw');
  const nav = U.el('nav', 'sw-nav');
  nav.setAttribute('aria-label', 'Settings sections');
  const navTop = U.el('div', 'sw-nav-top');
  const search = U.el('input', 'sw-search');
  search.type = 'search';
  search.placeholder = 'Search settings';
  search.spellcheck = false;
  navTop.appendChild(search);
  const navList = U.el('div', 'sw-nav-list');
  nav.append(navTop, navList);
  const main = U.el('main', 'sw-main');
  shell.append(nav, main);
  doc.body.appendChild(shell);

  sections = [];
  let body = null;
  const heading = (text, id) => {
    id = id || text.toLowerCase().replace(/[^a-z]+/g, '-');
    const el = U.el('section', 'sw-section');
    el.dataset.section = id;
    el.appendChild(U.el('h1', 'sw-title', text));
    main.appendChild(el);
    const btn = U.el('button', 'sw-nav-item');
    btn.type = 'button';
    btn.append(U.icon(SECTION_ICONS[id] || 'settings'), U.el('span', null, text));
    btn.addEventListener('click', () => {
      search.value = '';
      filterSections('');
      showSection(id);
    });
    navList.appendChild(btn);
    sections.push({ id, title: text, el, nav: btn });
    body = el;
    return el;
  };
  showSection = (id) => {
    const target = sections.find((x) => x.id === id) || sections[0];
    for (const sec of sections) {
      sec.el.hidden = sec !== target;
      sec.nav.classList.toggle('active', sec === target);
      sec.nav.classList.toggle('was-active', sec === target);
    }
    main.scrollTop = 0;
  };

  heading('Appearance');
  body.appendChild(field('Theme', select(
    [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']],
    get('appearance'),
    (v) => {
      set('appearance', v);
      ipcRenderer.send('set-pref', 'appearance', v);
    },
  ), 'Space colors adapt automatically.'));
  body.appendChild(field('Sidebar position', select(
    [['left', 'Left'], ['right', 'Right']],
    get('sidebarPosition'),
    (v) => {
      set('sidebarPosition', v);
      ctx.sidebar.setPosition(v);
    },
  ), 'Which side of the window the sidebar sits on.'));

  const space = ctx.tabs.activeSpace();
  const colorRow = U.el('div', 'settings-picker');
  const colorText = U.el('div', 'settings-label');
  colorText.append(U.el('span', null, 'Space color'), U.el('small', null, `Colors the “${space.name}” space. Each space keeps its own; switch spaces to change another.`));
  colorRow.append(colorText, ctx.sidebar.themePicker(space));
  body.appendChild(colorRow);

  heading('Getting started', 'start');
  const introBtn = U.el('button', 'btn', 'Replay intro');
  introBtn.addEventListener('click', () => {
    close();
    window.focus();
    ctx.intro.start();
  });
  body.appendChild(field('Welcome tour', introBtn, 'A quick walkthrough of the sidebar, spaces, the command bar and more.'));

  heading('Default browser', 'default');
  const status = await ipcRenderer.invoke('default-browser-status');
  const defaultBtn = U.el('button', 'btn' + (status.isDefault ? '' : ' primary'), status.isDefault ? 'Default ✓' : 'Make default');
  defaultBtn.disabled = status.isDefault;
  defaultBtn.addEventListener('click', async () => {
    const ok = await ipcRenderer.invoke('set-default-browser');
    if (!status.packaged) {
      U.toast('Run the packaged app (npm run package) to become the default browser', { duration: 7000 });
      return;
    }
    U.toast(ok ? 'Confirm in the system dialog to finish' : 'Couldn’t set the default browser');
  });
  body.appendChild(field('Use as default browser', defaultBtn, status.packaged
    ? 'Links you click in other apps open here.'
    : 'Only works in the packaged app — run “npm run package” and open Surf.app.'));
  body.appendChild(field('Open links from other apps in', select(
    [['little', 'Little window'], ['tab', 'New tab']],
    get('linkTarget'),
    (v) => {
      set('linkTarget', v);
      ipcRenderer.send('set-pref', 'linkTarget', v);
    },
  )));

  heading('Browsing');
  body.appendChild(field('Search engine', select(
    Object.entries(U.SEARCH_ENGINES).map(([k, v]) => [k, v.name]),
    get('searchEngine'),
    (v) => set('searchEngine', v),
  )));
  body.appendChild(field('Archive unused tabs after', select(
    [[0, 'Never'], [12, '12 hours'], [24, '24 hours'], [168, '7 days'], [720, '30 days']],
    get('archiveAfterHours'),
    (v) => set('archiveAfterHours', Number(v)),
  ), 'Today tabs you haven’t opened in this long move to the archive. Pinned tabs are kept.'));
  body.appendChild(field('Picture-in-picture when switching tabs', toggle(get('autoPip'), (v) => set('autoPip', v)), 'Playing videos pop out when you leave their tab.'));
  body.appendChild(field('Shields (block ads & trackers)', toggle(get('shields'), (v) => {
    if (v !== get('shields')) ctx.nav.toggleShields();
  })));

  const permCount = await ipcRenderer.invoke('permissions-count');
  const resetPerms = U.el('button', 'btn', 'Reset');
  resetPerms.disabled = !permCount;
  resetPerms.addEventListener('click', async () => {
    await ipcRenderer.invoke('permissions-reset');
    resetPerms.disabled = true;
    U.toast('Site permissions reset — sites will ask again');
  });
  body.appendChild(field('Site permissions', resetPerms, permCount ? `${permCount} saved choice${permCount === 1 ? '' : 's'} for camera, microphone, location and notifications.` : 'Sites ask before using your camera, microphone, location or notifications.'));

  body.appendChild(field('Put unused tabs to sleep after', select(
    [[0, 'Never'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [240, '4 hours']],
    get('hibernateMinutes'),
    (v) => set('hibernateMinutes', Number(v)),
  ), 'Sleeping tabs free memory and reload when you click them. Tabs playing audio stay awake.'));
  body.appendChild(field('Mouse gestures', toggle(get('gestures'), (v) => {
    set('gestures', v);
    ipcRenderer.send('set-pref', 'gestures', v);
  }), 'Hold the right mouse button and drag: ← back, → forward, ↓ new tab, ↓→ close tab, ↑↓ reload.'));

  heading('Air Traffic Control', 'atc');
  body.appendChild(U.el('p', 'settings-hint', 'Links from other apps that contain a pattern open straight in a chosen space — e.g. “figma.com” → Work.'));
  const atcList = U.el('div', 'ext-list');
  const renderAtc = () => {
    atcList.replaceChildren();
    const rules = get('atcRules') || [];
    if (!rules.length) atcList.appendChild(U.el('div', 'ext-empty', 'No rules yet.'));
    rules.forEach((rule, i) => {
      const row = U.el('div', 'ext-row');
      const space = ctx.tabs.getSpace(rule.spaceId);
      const text = U.el('div', 'ext-text');
      text.append(U.el('span', 'ext-name', rule.pattern), U.el('span', 'ext-version', `→ ${space ? space.name : 'deleted space'}`));
      row.appendChild(text);
      row.appendChild(U.iconButton('trash', 'Delete rule', () => {
        const next = rules.filter((_, j) => j !== i);
        set('atcRules', next);
        ipcRenderer.send('set-pref', 'atcRules', next);
        renderAtc();
      }, 'h-delete'));
      atcList.appendChild(row);
    });
  };
  renderAtc();
  body.appendChild(atcList);
  const atcRow = U.el('div', 'settings-key');
  const atcInput = U.el('input', 'dialog-input');
  atcInput.placeholder = 'Link contains… e.g. figma.com';
  atcInput.spellcheck = false;
  const atcSpace = select(ctx.tabs.spaces.map((sp) => [sp.id, sp.name]), ctx.tabs.activeSpaceId, () => {});
  const atcAdd = U.el('button', 'btn primary', 'Add');
  atcAdd.addEventListener('click', () => {
    const pattern = atcInput.value.trim();
    if (!pattern) return;
    const next = [...(get('atcRules') || []), { pattern, spaceId: atcSpace.value }];
    set('atcRules', next);
    ipcRenderer.send('set-pref', 'atcRules', next);
    atcInput.value = '';
    renderAtc();
  });
  atcRow.append(atcInput, atcSpace, atcAdd);
  body.appendChild(atcRow);

  heading('Passwords', 'passwords');
  const pwList = U.el('div', 'ext-list');
  body.appendChild(pwList);
  ctx.passwords.renderManager(pwList);
  if (!U.PRIVATE) body.appendChild(ctx.passwords.transferControls(pwList));
  body.appendChild(U.el('p', 'settings-hint', 'Saved when you sign in (you’ll be asked), filled when you click a login field. Encrypted with your macOS Keychain; copying a password asks for Touch ID when available. Import takes a CSV exported from Chrome, Safari or Firefox.'));

  heading('Addresses & cards', 'autofill');
  const afList = U.el('div');
  body.appendChild(afList);
  ctx.autofill.renderManager(afList);
  body.appendChild(U.el('p', 'settings-hint', 'Offered when you click a checkout field; nothing is filled until you pick one. Encrypted with your macOS Keychain. Card security codes are never saved, and cards fill only on https pages.'));

  heading('Privacy');
  const reportBtn = U.el('button', 'btn', 'Open report');
  reportBtn.addEventListener('click', () => {
    window.focus();
    ctx.privacy.openReport();
  });
  body.appendChild(field('Privacy report', reportBtn, 'Which trackers were blocked, and on which sites.'));

  heading('Import', 'import');
  const importRow = U.el('div', 'boost-row');
  const sources = await ipcRenderer.invoke('import-detect');
  if (!sources.length) importRow.appendChild(U.el('span', 'settings-hint', 'No other browsers found on this Mac.'));
  for (const source of sources) {
    const btn = U.el('button', 'chip', `From ${source.name}`);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = `Importing from ${source.name}…`;
      const result = await ipcRenderer.invoke('import-run', source.id);
      btn.disabled = false;
      btn.textContent = `From ${source.name}`;
      if (result.error === 'fda') {
        U.toast(`${source.name}’s data is protected — allow Full Disk Access for this app, then try again`, {
          actionLabel: 'Open Settings',
          action: () => ipcRenderer.send('open-fda-settings'),
          duration: 9000,
        });
        return;
      }
      if (result.error) {
        U.toast(`Import failed: ${result.error}`, { duration: 6000 });
        return;
      }
      const added = ctx.library.importHistory(result.history);
      const marks = ctx.bookmarks.importItems(source.name, result.bookmarks);
      U.toast(`Imported ${marks} bookmark${marks === 1 ? '' : 's'} and ${added} history page${added === 1 ? '' : 's'} from ${source.name}`, {
        // The old way: the same bookmarks as a pinned folder of tabs in this space
        ...(marks ? { actionLabel: 'Also pin as folder', action: () => ctx.tabs.importBookmarks(source.name, result.bookmarks) } : {}),
        duration: 8000,
      });
    });
    importRow.appendChild(btn);
  }
  body.appendChild(importRow);
  body.appendChild(U.el('p', 'settings-hint', 'Bookmarks go to Library → Bookmarks (in a folder named after the browser); history merges into yours. Close the other browser first for the freshest history. A bookmarks.html file can be imported from the Bookmarks tab.'));

  heading('Profiles', 'profiles');
  const profileBox = U.el('div');
  body.appendChild(profileBox);
  await ctx.profiles.renderSettings(profileBox);

  heading('Extensions', 'extensions');
  const extList = U.el('div', 'ext-list');
  await ctx.extensions.list();
  const refreshExt = () => ctx.extensions.renderList(extList, { onChange: refreshExt });
  refreshExt();
  body.appendChild(extList);
  ctx.extensions.installControls(body, refreshExt);
  body.appendChild(U.el('p', 'settings-hint', 'Click “Add to Chrome” on any Chrome Web Store page to install; store extensions update automatically. Content scripts (e.g. Dark Reader, ad blockers) work best. Toolbar popups open in a small window; some extensions that rely on Chrome’s tab APIs may not work fully.'));

  heading('AI features', 'ai');
  const languages = ['', 'English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Russian', 'Ukrainian', 'Polish', 'Turkish', 'Arabic', 'Hindi', 'Japanese', 'Korean', 'Chinese (Simplified)', 'Chinese (Traditional)'];
  body.appendChild(field('Translate pages into', select(
    languages.map((l) => [l, l || 'My system language']),
    get('translateTo'),
    (v) => set('translateTo', v),
  )));
  body.appendChild(field('Give downloads better names', toggle(get('aiRenameDownloads'), (v) => set('aiRenameDownloads', v)), 'Files named like “download.pdf” or random letters get a descriptive name.'));

  heading('Skills', 'skills');
  const skillList = U.el('div', 'ext-list');
  const renderSkills = () => {
    skillList.replaceChildren();
    for (const skill of ctx.ai.skills()) {
      const row = U.el('div', 'ext-row');
      const text = U.el('div', 'ext-text');
      text.append(U.el('span', 'ext-name', skill.name), U.el('span', 'ext-version', skill.prompt));
      row.append(U.icon('zap'), text, U.iconButton('trash', 'Delete skill', () => { ctx.ai.deleteSkill(skill.id); renderSkills(); }, 'h-delete'));
      skillList.appendChild(row);
    }
  };
  renderSkills();
  body.appendChild(skillList);
  const newSkillBtn = U.el('button', 'btn', 'New skill…');
  newSkillBtn.addEventListener('click', async () => { await ctx.ai.newSkill(); renderSkills(); });
  body.appendChild(newSkillBtn);

  heading('Memory', 'memory');
  body.appendChild(field('Let the assistant remember things about you', toggle(get('aiMemory'), (v) => set('aiMemory', v)), 'Say things like “remember I’m vegetarian” in the assistant.'));
  const memList = U.el('div', 'ext-list');
  const renderMemory = () => {
    memList.replaceChildren();
    const list = ctx.ai.memories();
    if (!list.length) memList.appendChild(U.el('div', 'ext-empty', 'Nothing remembered yet.'));
    for (const m of list) {
      const row = U.el('div', 'ext-row');
      row.append(U.icon('brain'), U.el('div', 'ext-text', m.text), U.iconButton('trash', 'Forget', () => { ctx.ai.deleteMemory(m.id); renderMemory(); }, 'h-delete'));
      memList.appendChild(row);
    }
  };
  renderMemory();
  body.appendChild(memList);
  heading('AI provider', 'ai-provider');
  const hasKey = await ipcRenderer.invoke('ai-has-key');
  const keyRow = U.el('div', 'settings-key');
  const keyInput = U.el('input', 'dialog-input');
  keyInput.type = 'password';
  keyInput.placeholder = hasKey ? '•••••••• saved — paste a new key to replace' : 'sk-ant-…';
  keyInput.spellcheck = false;
  const saveBtn = U.el('button', 'btn primary', 'Save key');
  const removeBtn = U.el('button', 'btn', 'Remove');
  removeBtn.disabled = !hasKey;
  saveBtn.addEventListener('click', async () => {
    if (!keyInput.value.trim()) return;
    await ipcRenderer.invoke('ai-set-key', keyInput.value);
    keyInput.value = '';
    keyInput.placeholder = '•••••••• saved — paste a new key to replace';
    removeBtn.disabled = false;
    U.toast('API key saved');
  });
  removeBtn.addEventListener('click', async () => {
    await ipcRenderer.invoke('ai-set-key', '');
    keyInput.placeholder = 'sk-ant-…';
    removeBtn.disabled = true;
    U.toast('API key removed');
  });
  keyRow.append(keyInput, saveBtn, removeBtn);
  body.appendChild(keyRow);
  body.insertBefore(field('Claude API key', U.el('span'), 'Used for page summaries, web answers, link previews (hover a link and press Shift), translation, download names, and tidying tabs. Your key is stored encrypted on this computer and sent only to Anthropic’s API. Get one at platform.claude.com.'), keyRow);

  // Your own AI server (e.g. Ollama on a free cloud VM) instead of Claude
  const server = await ipcRenderer.invoke('ai-get-server');
  body.appendChild(U.el('h4', null, 'Your own AI server'));
  const serverRow = U.el('div', 'settings-key');
  const urlInput = U.el('input', 'dialog-input');
  urlInput.placeholder = 'https://1-2-3-4.sslip.io';
  urlInput.value = server ? server.url : '';
  const modelInput = U.el('input', 'dialog-input');
  modelInput.placeholder = 'llama3.2:3b';
  modelInput.value = server ? server.model : '';
  modelInput.style.maxWidth = '140px';
  for (const input of [urlInput, modelInput]) input.spellcheck = false;
  serverRow.append(urlInput, modelInput);
  const tokenRow = U.el('div', 'settings-key');
  const tokenInput = U.el('input', 'dialog-input');
  tokenInput.type = 'password';
  tokenInput.spellcheck = false;
  tokenInput.placeholder = server && server.hasToken ? '•••••••• saved — paste a new token to replace' : 'Access token (from the setup script)';
  const useBtn = U.el('button', 'btn primary', server ? 'Save' : 'Use server');
  const testBtn = U.el('button', 'btn', 'Test');
  const claudeBtn = U.el('button', 'btn', 'Use Claude');
  testBtn.disabled = claudeBtn.disabled = !server;
  useBtn.addEventListener('click', async () => {
    const result = await ipcRenderer.invoke('ai-set-server', {
      url: urlInput.value,
      model: modelInput.value,
      token: tokenInput.value.trim() ? tokenInput.value : undefined,
    });
    if (result && result.error) return U.toast(result.error);
    if (tokenInput.value.trim()) tokenInput.placeholder = '•••••••• saved — paste a new token to replace';
    tokenInput.value = '';
    useBtn.textContent = 'Save';
    testBtn.disabled = claudeBtn.disabled = false;
    U.toast('AI features now use your server');
  });
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.textContent = 'Testing…';
    const result = await ipcRenderer.invoke('ai-test-server');
    testBtn.disabled = false;
    testBtn.textContent = 'Test';
    U.toast(result.error || `Server works — it said “${result.text}”`, { duration: 6000 });
  });
  claudeBtn.addEventListener('click', async () => {
    await ipcRenderer.invoke('ai-set-server', null);
    urlInput.value = modelInput.value = '';
    tokenInput.placeholder = 'Access token (from the setup script)';
    useBtn.textContent = 'Use server';
    testBtn.disabled = claudeBtn.disabled = true;
    U.toast('AI features now use Claude');
  });
  tokenRow.append(tokenInput, useBtn, testBtn, claudeBtn);
  body.append(serverRow, tokenRow);
  body.appendChild(U.el('p', 'settings-hint', 'Runs the AI features on an open model you host — for example Ollama on a free Oracle Cloud server (see server/README.md). When set, nothing is sent to Anthropic. Small models are weaker than Claude, long pages get cut short, and “Ask Claude (web search)” answers without searching.'));

  heading('Keyboard shortcuts', 'shortcuts');
  ctx.shortcuts.renderSettings(body);
  body.appendChild(U.el('h4', null, 'Other shortcuts'));
  const grid = U.el('div', 'shortcut-grid');
  for (const [keys, label] of SHORTCUTS) {
    const keyText = process.platform === 'darwin' ? keys : keys.replace(/⌘/g, 'Ctrl+').replace(/⇧/g, 'Shift+').replace(/⌥/g, 'Alt+').replace(/⌃/g, 'Alt+');
    grid.append(U.el('kbd', null, keyText), U.el('span', null, label));
  }
  body.appendChild(grid);

  showSection(section || 'appearance');
  search.addEventListener('input', () => filterSections(search.value));

  doc.addEventListener('keydown', (e) => {
    // Esc closes a menu or dialog first, then clears the search, then the window
    if (e.key === 'Escape') {
      if (U.handleEscape()) return;
      if (search.value) {
        search.value = '';
        filterSections('');
      } else close();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      search.focus();
    }
  });
  win.addEventListener('pagehide', () => {
    ctx.shortcuts.close();
    observer.disconnect();
    U.setPopupDocument(null);
    win = null;
    showSection = null;
    sections = [];
  });
  win.focus();
}

ctx.settings = { get, set, open, close };
