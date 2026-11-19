// Live folders: pinned folders that keep themselves up to date from an RSS/Atom
// feed or a GitHub repository's open pull requests / issues. New items get a dot.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const T = () => ctx.tabs;
const MAX_ITEMS = 15;
const REFRESH_MS = 15 * 60 * 1000;

function parseSource(input) {
  const text = input.trim();
  const gh = text.match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\/(pulls|issues))?\/?$/i);
  if (gh && !/^https?:\/\/(?!github\.com)/i.test(text)) {
    return { type: gh[3] && gh[3].toLowerCase() === 'issues' ? 'github-issues' : 'github-pulls', repo: `${gh[1]}/${gh[2]}` };
  }
  const url = U.resolveInput(text);
  if (url && /^https?:/i.test(url) && U.looksLikeUrl(text)) return { type: 'feed', url };
  return null;
}

async function fetchItems(source) {
  if (source.type === 'github-pulls' || source.type === 'github-issues') {
    const kind = source.type === 'github-pulls' ? 'pulls' : 'issues';
    const res = await ipcRenderer.invoke('fetch-text', `https://api.github.com/repos/${source.repo}/${kind}?state=open&per_page=${MAX_ITEMS}`);
    if (res.error) throw new Error(res.error);
    const data = JSON.parse(res.text);
    if (!Array.isArray(data)) throw new Error(data.message || 'Unexpected response');
    return data
      .filter((i) => kind === 'pulls' || !i.pull_request)
      .map((i) => ({ title: `#${i.number} ${i.title}`, url: i.html_url }));
  }

  const res = await ipcRenderer.invoke('fetch-text', source.url);
  if (res.error) throw new Error(res.error);
  // DOMParser never runs scripts; XML is only read for titles and links
  const doc = new DOMParser().parseFromString(res.text, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('That address isn’t an RSS or Atom feed');
  const items = [];
  for (const item of doc.querySelectorAll('item')) {
    const link = item.querySelector('link');
    items.push({ title: (item.querySelector('title') || {}).textContent || '', url: (link && link.textContent.trim()) || '' });
  }
  for (const entry of doc.querySelectorAll('entry')) {
    const link = entry.querySelector('link[rel="alternate"]') || entry.querySelector('link');
    items.push({ title: (entry.querySelector('title') || {}).textContent || '', url: link ? link.getAttribute('href') || link.textContent : '' });
  }
  return items
    .filter((i) => /^https?:/i.test(i.url))
    .map((i) => ({ title: i.title.trim() || U.compactUrl(i.url), url: i.url.trim() }))
    .slice(0, MAX_ITEMS);
}

function findLiveFolders() {
  const out = [];
  for (const space of T().spaces) {
    for (const node of space.pinned) if (node.type === 'folder' && node.live) out.push(node);
  }
  return out;
}

async function refresh(folderId, announce = false) {
  const loc = T().locate(folderId);
  if (!loc || !loc.node.live) return;
  const folder = loc.node;
  let items;
  try {
    items = await fetchItems(folder.live);
  } catch (err) {
    folder.live.error = err.message;
    if (announce) U.toast(`Couldn’t refresh “${folder.name}”: ${err.message}`, { duration: 6000 });
    return;
  }
  folder.live.error = null;
  const firstFetch = !folder.live.lastFetched;
  const seen = new Set(folder.live.seen || []);
  const existing = new Map(folder.children.map((c) => [c.url, c]));
  const next = items.map((item) => {
    const entry = existing.get(item.url) || T().newEntry({ url: item.url, title: item.title, favicon: `https://icons.duckduckgo.com/ip3/${U.hostOf(item.url)}.ico` });
    entry.title = item.title;
    if (!seen.has(item.url) && !firstFetch) entry.unread = true;
    return entry;
  });
  // Keep tabs that are open even if they dropped out of the feed
  for (const child of folder.children) {
    if (!next.includes(child) && T().live.has(child.id)) next.push(child);
  }
  for (const child of folder.children) {
    if (!next.includes(child)) T().unload(child.id);
  }
  folder.children = next;
  folder.live.seen = [...new Set([...seen, ...items.map((i) => i.url)])].slice(-300);
  folder.live.lastFetched = Date.now();
  ctx.sidebar.render();
  T().save();
  const fresh = next.filter((c) => c.unread).length;
  if (announce) U.toast(fresh ? `${fresh} new in “${folder.name}”` : `“${folder.name}” is up to date`);
}

function markRead(folderId) {
  const loc = T().locate(folderId);
  if (!loc) return;
  loc.node.children.forEach((c) => { c.unread = false; });
  ctx.sidebar.render();
  T().save();
}

async function create() {
  const input = await U.dialog({
    title: 'New live folder',
    message: 'Paste an RSS/Atom feed address, or a GitHub repository (owner/repo) to follow its open pull requests. Add /issues for issues.',
    placeholder: 'e.g. github.com/electron/electron or a feed URL',
    confirmLabel: 'Create',
  });
  if (!input) return;
  const source = parseSource(input);
  if (!source) {
    U.toast('That doesn’t look like a feed or a GitHub repo');
    return;
  }
  const defaultName = source.repo ? `${source.repo.split('/')[1]} ${source.type === 'github-issues' ? 'issues' : 'PRs'}` : U.compactUrl(source.url);
  const name = await U.dialog({ title: 'Name this folder', value: defaultName, confirmLabel: 'Done' });
  const folder = { type: 'folder', id: U.uid(), name: name || defaultName, open: true, children: [], live: { ...source, seen: [], lastFetched: 0 } };
  T().activeSpace().pinned.push(folder);
  ctx.sidebar.render();
  T().save();
  await refresh(folder.id, true);
}

function refreshAll() {
  for (const folder of findLiveFolders()) {
    if (Date.now() - (folder.live.lastFetched || 0) > REFRESH_MS - 1000) refresh(folder.id);
  }
}

function setup() {
  setTimeout(refreshAll, 5000);
  setInterval(refreshAll, REFRESH_MS);
}

ctx.liveFolders = { setup, create, refresh, markRead };
