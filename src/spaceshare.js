// Space export / import (.surfspace files) and space templates.
// A .surfspace file is plain JSON: the space's look (name, color, icon, search engine) and its
// pinned tabs + folders as links, optionally with Today's tabs. It never carries cookies,
// passwords, history or the space's separate-logins data — only what's written below.
// Imports are rebuilt field by field from a strict check, so nothing else in a file gets in.
const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const T = () => ctx.tabs;

const FORMAT = 'surfspace';
const VERSION = 1;
const TEMPLATES_KEY = 'browser.spaceTemplates';
const LIMITS = { bytes: 2 * 1024 * 1024, entries: 1000, depth: 4, name: 80, title: 500, url: 4096, favicon: 32 * 1024, templates: 50 };

const favicon = (url) => `https://icons.duckduckgo.com/ip3/${U.hostOf(url)}.ico`;
const link = (title, url) => ({ type: 'entry', title, url, favicon: favicon(url) });

// Built-in templates use the same shape as an exported file (pinned links only)
const BUILT_IN = [
  { id: 'builtin-work', name: 'Work', theme: 1, icon: '💼', pinned: [
    link('Gmail', 'https://mail.google.com/'),
    link('Calendar', 'https://calendar.google.com/'),
    link('Docs', 'https://docs.google.com/'),
  ] },
  { id: 'builtin-study', name: 'Study', theme: 2, icon: '📚', pinned: [
    link('Wikipedia', 'https://www.wikipedia.org/'),
    link('Google Scholar', 'https://scholar.google.com/'),
    link('Notion', 'https://www.notion.so/'),
  ] },
  { id: 'builtin-watch', name: 'Watch', theme: 3, icon: '🎬', pinned: [
    link('YouTube', 'https://www.youtube.com/'),
    link('Netflix', 'https://www.netflix.com/'),
    link('Twitch', 'https://www.twitch.tv/'),
  ] },
  { id: 'builtin-build', name: 'Build', theme: 0, icon: '🛠️', pinned: [
    link('GitHub', 'https://github.com/'),
    link('Stack Overflow', 'https://stackoverflow.com/'),
    link('MDN Web Docs', 'https://developer.mozilla.org/'),
  ] },
];

/* ------------------------------------------------------------------ */
/* Export: a space -> plain links                                      */
/* ------------------------------------------------------------------ */

const isWebUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url);

// A folder's look (src/folders.js) travels with it; a live folder goes as a plain one
function exportFolder(folder) {
  const out = { type: 'folder', name: folder.name, open: !!folder.open };
  if (folder.color) out.color = folder.color;
  if (folder.icon) out.icon = folder.icon;
  if (folder.site) out.site = folder.site;
  out.children = exportNodes(folder.children);
  return out;
}

function exportNodes(list) {
  const out = [];
  for (const node of list) {
    if (node.type === 'folder') out.push(exportFolder(node));
    else if (node.type === 'split') out.push(...exportNodes(node.children)); // splits don't travel; their tabs do
    else if (node.type === 'entry' && node.kind === 'web' && isWebUrl(node.url)) {
      const icon = T().entryFavicon(node);
      out.push({ type: 'entry', title: T().entryTitle(node), url: node.url, favicon: cleanFavicon(icon) });
    }
  }
  return out;
}

function serialize(space, { includeToday = false } = {}) {
  const data = {
    format: FORMAT,
    version: VERSION,
    name: space.name,
    theme: space.theme || 0,
    color: space.color || null,
    icon: space.icon || null,
    searchEngine: space.searchEngine || null,
    pinned: exportNodes(space.pinned),
  };
  if (includeToday) data.today = exportNodes(space.today);
  return data;
}

const countLinks = (nodes) => nodes.reduce((n, node) => n + (node.type === 'folder' ? countLinks(node.children) : 1), 0);

// A small dialog with one checkbox (U.dialog only does text and confirm)
function exportDialog(space) {
  return new Promise((resolve) => {
    const pinned = countLinks(exportNodes(space.pinned));
    const today = countLinks(exportNodes(space.today));
    const backdrop = U.el('div', 'dialog-backdrop');
    const box = U.el('form', 'dialog');
    box.appendChild(U.el('h3', null, `Export “${space.name}”`));
    box.appendChild(U.el('p', null, `Saves the space’s color, icon, search engine and ${pinned} pinned tab${pinned === 1 ? '' : 's'} as a .surfspace file you can import or share.`));
    const row = U.el('label', 'ss-check');
    const check = U.el('input');
    check.type = 'checkbox';
    check.disabled = !today;
    row.append(check, U.el('span', null, today ? `Include Today’s tabs (${today})` : 'Include Today’s tabs (none open)'));
    box.appendChild(row);
    box.appendChild(U.el('p', 'ss-hint', 'Logins, cookies, passwords and history are never included.'));
    const actions = U.el('div', 'dialog-actions');
    const cancel = U.el('button', 'btn', 'Cancel');
    cancel.type = 'button';
    const ok = U.el('button', 'btn primary', 'Export…');
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
      finish({ includeToday: check.checked });
    });
    requestAnimationFrame(() => ok.focus());
  });
}

async function exportSpace(space = T().activeSpace()) {
  const choice = await exportDialog(space);
  if (!choice) return;
  const json = JSON.stringify(serialize(space, choice), null, 2);
  const result = await ipcRenderer.invoke('space-export', { name: space.name, json });
  if (!result) return;
  if (result.error) U.toast(result.error);
  else U.toast(`Exported “${space.name}”`, { actionLabel: 'Show', action: () => ipcRenderer.send('download-action', { action: 'show', savePath: result.path }) });
}

/* ------------------------------------------------------------------ */
/* Import: strict check, then rebuild only the known fields            */
/* ------------------------------------------------------------------ */

class Invalid extends Error {}
const fail = (msg) => { throw new Invalid(msg); };

// Control characters and surrounding space out; length capped
function cleanText(value, max, what) {
  if (typeof value !== 'string') fail(`${what} must be text`);
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (text.length > max) fail(`${what} is too long`);
  return text;
}

function cleanUrl(value) {
  if (typeof value !== 'string' || value.length > LIMITS.url) fail('A tab has a missing or overlong URL');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`Not a valid URL: ${value.slice(0, 80)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(`Only http(s) links are allowed, not ${url.protocol}`);
  if (url.username || url.password) fail('Links with a user name or password are not allowed');
  // Keep the link exactly as written (pinned tabs compare against it), but only a clean one
  return /[\s\u0000-\u001f\u007f]/.test(value) ? url.href : value;
}

// Favicons are optional: an http(s) URL or a small raster data: image, else dropped
function cleanFavicon(value) {
  if (typeof value !== 'string') return null;
  if (/^https?:\/\//i.test(value) && value.length <= LIMITS.url) {
    try {
      return new URL(value).href;
    } catch {
      return null;
    }
  }
  if (/^data:image\/(png|x-icon|vnd\.microsoft\.icon|gif|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(value) && value.length <= LIMITS.favicon) return value;
  return null;
}

function checkNodes(list, depth, budget, what) {
  if (!Array.isArray(list)) fail(`${what} must be a list`);
  if (depth > LIMITS.depth) fail('Folders are nested too deeply');
  return list.map((node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) fail(`${what} has an invalid item`);
    if (++budget.count > LIMITS.entries) fail(`Too many tabs (the limit is ${LIMITS.entries})`);
    if (node.type === 'folder') {
      const folder = {
        type: 'folder',
        name: cleanText(node.name, LIMITS.title, 'A folder name') || 'Folder',
        open: node.open === true,
        color: checkFolderColor(node.color),
        icon: checkIcon(node.icon, 'A folder icon'),
        site: checkSite(node.site),
        children: checkNodes(node.children, depth + 1, budget, 'A folder'),
      };
      for (const key of ['color', 'icon', 'site']) if (folder[key] == null) delete folder[key];
      return folder;
    }
    if (node.type !== 'entry') fail(`${what} has an item of unknown type`);
    const url = cleanUrl(node.url);
    const title = node.title == null ? '' : cleanText(node.title, LIMITS.title, 'A tab title');
    return { type: 'entry', url, title: title || U.hostOf(url), favicon: cleanFavicon(node.favicon) };
  });
}

function checkColor(color) {
  if (color == null) return null;
  const num = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  if (typeof color !== 'object' || !num(color.h, 0, 360) || !num(color.s, 0, 1) || !(color.i == null || num(color.i, 0, 1))) fail('The space color is invalid');
  return { h: color.h, s: color.s, i: color.i == null ? 0.6 : color.i };
}

function checkIcon(icon, what = 'The space icon') {
  if (icon == null || icon === '') return null;
  if (typeof icon !== 'string' || icon.length > 16) fail(`${what} is invalid`);
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(icon)];
  if (graphemes.length !== 1 || /[\u0000-\u001f\u007f]/.test(icon)) fail(`${what} must be a single emoji or character`);
  return icon;
}

// Folder colors are a swatch (#rrggbb) or a site's icon color (hsl(), from src/sitecolor.js)
function checkFolderColor(color) {
  if (color == null || color === '') return null;
  if (typeof color !== 'string' || !(/^#[0-9a-f]{6}$/i.test(color) || /^hsl\(\d{1,3}(\.\d+)?, \d{1,3}(\.\d+)?%, \d{1,3}(\.\d+)?%\)$/.test(color))) fail('A folder color is invalid');
  return color;
}

// The site a "Group tabs from this site" folder collects: a bare host name (anything else is dropped)
function checkSite(site) {
  if (typeof site !== 'string' || site.length > 253 || !/^[a-z0-9.-]+$/i.test(site)) return null;
  return site.toLowerCase();
}

// Throws Invalid with a readable reason; returns a clean copy with only known fields
function validate(text) {
  if (typeof text !== 'string') fail('The file is empty');
  if (text.length > LIMITS.bytes) fail('The file is too large');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    fail('The file isn’t valid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.format !== FORMAT) fail('This isn’t a Surf space file');
  if (!Number.isInteger(data.version) || data.version < 1) fail('The file has no valid version');
  if (data.version > VERSION) fail('This space was made by a newer version of Surf');
  const name = cleanText(data.name, LIMITS.name, 'The space name');
  if (!name) fail('The space has no name');
  const theme = data.theme == null ? 0 : data.theme;
  if (!Number.isInteger(theme) || theme < 0 || theme >= T().THEMES.length) fail('The space theme is invalid');
  if (data.searchEngine != null && !Object.hasOwn(U.SEARCH_ENGINES, data.searchEngine)) fail('Unknown search engine');
  const budget = { count: 0 };
  return {
    format: FORMAT,
    version: VERSION,
    name,
    theme,
    color: checkColor(data.color),
    icon: checkIcon(data.icon),
    searchEngine: data.searchEngine || null,
    pinned: checkNodes(data.pinned == null ? [] : data.pinned, 1, budget, 'Pinned tabs'),
    today: checkNodes(data.today == null ? [] : data.today, 1, budget, 'Today’s tabs'),
  };
}

// Fresh ids for everything; entries go through the same constructor as any new tab
function buildNodes(nodes) {
  return nodes.map((node) => (node.type === 'folder'
    ? { ...node, id: U.uid(), children: buildNodes(node.children) }
    : T().newEntry({ url: node.url, title: node.title, favicon: node.favicon })));
}

function createSpace(data, name = data.name) {
  const space = {
    id: U.uid(),
    name,
    theme: data.theme || 0,
    color: data.color ? { ...data.color } : null,
    icon: data.icon || null,
    searchEngine: data.searchEngine || null,
    pinned: buildNodes(data.pinned || []),
    today: buildNodes(data.today || []),
    activeEntryId: null,
  };
  T().spaces.push(space);
  T().switchSpace(space.id);
  ctx.sidebar.render();
  return space;
}

// { name, text } or { error } from the main process (file dialog or Finder)
async function importData(file, { confirm = false } = {}) {
  if (!file) return null;
  let data;
  try {
    if (file.error) fail(file.error);
    data = validate(file.text);
  } catch (err) {
    if (!(err instanceof Invalid)) console.error(err);
    U.toast(`Couldn’t import ${file.name || 'space'}: ${err instanceof Invalid ? err.message : 'unexpected error'}`, { duration: 5000 });
    return null;
  }
  const count = countLinks(data.pinned) + countLinks(data.today);
  if (confirm) {
    const ok = await U.dialog({
      title: `Add “${data.name}” as a new space?`,
      message: `${count} tab${count === 1 ? '' : 's'} from ${file.name}. Nothing in your other spaces changes.`,
      confirmLabel: 'Add space',
      input: false,
    });
    if (!ok) return null;
  }
  const space = createSpace(data);
  U.toast(`Imported “${space.name}” · ${count} tab${count === 1 ? '' : 's'}`);
  return space;
}

async function importFile() {
  return importData(await ipcRenderer.invoke('space-import-file'));
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

const savedTemplates = () => {
  const list = U.store.get(TEMPLATES_KEY, []);
  return Array.isArray(list) ? list : [];
};

function newFromTemplate(template) {
  let data;
  try {
    data = validate(JSON.stringify({ ...template, format: FORMAT, version: VERSION }));
  } catch (err) {
    U.toast(`That template is damaged: ${err.message}`);
    return null;
  }
  const space = createSpace({ ...data, today: [] });
  U.toast(`Created “${space.name}” from a template`);
  return space;
}

async function saveAsTemplate(space = T().activeSpace()) {
  const name = await U.dialog({
    title: 'Save as template',
    message: 'Keeps the space’s look and pinned tabs, so you can start new spaces from it.',
    value: space.name,
    confirmLabel: 'Save template',
  });
  if (!name) return;
  const list = savedTemplates();
  if (list.length >= LIMITS.templates) {
    U.toast(`You can keep up to ${LIMITS.templates} templates — delete one first`);
    return;
  }
  const { format, version, ...data } = serialize(space);
  list.push({ ...data, id: U.uid(), name: name.slice(0, LIMITS.name) });
  U.store.set(TEMPLATES_KEY, list);
  U.toast(`Saved template “${name}”`);
}

async function deleteTemplate(id) {
  const template = savedTemplates().find((t) => t.id === id);
  if (!template) return;
  const ok = await U.dialog({ title: `Delete template “${template.name}”?`, message: 'Spaces made from it stay as they are.', confirmLabel: 'Delete', danger: true, input: false });
  if (!ok) return;
  U.store.set(TEMPLATES_KEY, savedTemplates().filter((t) => t.id !== id));
  U.toast('Template deleted');
}

const templateLabel = (t) => `${t.icon ? t.icon + '  ' : ''}${t.name}`;
const templateHint = (t) => `${countLinks(t.pinned || [])} tabs`;

function templateMenu(x = window.innerWidth / 2 - 120, y = 120) {
  const mine = savedTemplates();
  U.contextMenu([
    { header: 'New space from template' },
    ...BUILT_IN.map((t) => ({ label: templateLabel(t), hint: templateHint(t), action: () => newFromTemplate(t) })),
    mine.length && { separator: true },
    mine.length && { header: 'Your templates' },
    ...mine.map((t) => ({ label: templateLabel(t), hint: templateHint(t), action: () => newFromTemplate(t) })),
    { separator: true },
    { label: 'Save this space as a template…', icon: 'layers', action: () => saveAsTemplate() },
    mine.length && { label: 'Delete a template…', icon: 'trash', action: () => deleteTemplateMenu(x, y) },
  ], x, y);
}

function deleteTemplateMenu(x, y) {
  U.contextMenu([
    { header: 'Delete template' },
    ...savedTemplates().map((t) => ({ label: templateLabel(t), icon: 'trash', danger: true, action: () => deleteTemplate(t.id) })),
  ], x, y);
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function setup() {
  ipcRenderer.on('space-import-request', () => importFile());
  // Files opened from Finder go to the main window only; it asks for them once it's ready
  if (!U.PRIVATE) {
    ipcRenderer.on('space-import-data', (_e, file) => importData(file, { confirm: true }));
    ipcRenderer.send('space-import-ready');
  }
}

ctx.spaceShare = {
  BUILT_IN,
  serialize,
  validate,
  exportSpace,
  importFile,
  importData,
  templateMenu,
  newFromTemplate,
  saveAsTemplate,
  deleteTemplate,
  savedTemplates,
  setup,
};
