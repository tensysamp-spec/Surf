// Media: a small panel at the bottom of the sidebar listing every tab playing audio/video
// (play/pause, mute, skip and next/previous track via the page's MediaSession), media keys
// while something plays, "mute all other tabs", and auto picture-in-picture.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

let current = null; // the tab that most recently started playing (kept while paused, so it can resume)
let collapsed = !!U.store.get('browser.mediaCollapsed', false);
let keysSent = null; // last state reported to main, so we only send changes
let rendered = ''; // what the panel shows (tabs, icons, titles), so the poll only redraws on change
const SKIP = 10; // seconds for the ±10 s buttons
// Media keys stay ours a little after the last pause, so the same key can resume it
const KEY_GRACE = 2 * 60 * 1000;

// Icons the panel needs that the shared set doesn't have
const svg = (body) => `<svg viewBox="0 0 24 24">${body}</svg>`;
const skipNum = '<text x="12" y="16.2" text-anchor="middle" font-size="7.5" font-weight="600" fill="currentColor" stroke="none">10</text>';
const MEDIA_ICONS = {
  trackPrev: svg('<polygon points="19 20 9 12 19 4 19 20" /><line x1="5" y1="19" x2="5" y2="5"/>'),
  trackNext: svg('<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>'),
  skipBack: svg(`<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><polyline points="3 3 3 8 8 8"/>${skipNum}`),
  skipForward: svg(`<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><polyline points="21 3 21 8 16 8"/>${skipNum}`),
};
for (const [name, markup] of Object.entries(MEDIA_ICONS)) if (!U.ICONS[name]) U.ICONS[name] = markup;

/* ------------------------------------------------------------------ */
/* Page scripts (run in the page's main world)                         */
/* ------------------------------------------------------------------ */

// Remember the action handlers a page gives navigator.mediaSession (next/previous track,
// seek…), so the panel and the media keys can call them. Runs at dom-ready; pages usually
// register handlers once playback starts, so that's early enough.
const HOOK = `(() => {
  const ms = navigator.mediaSession;
  if (!ms || ms.__surfActions) return;
  const actions = {};
  const set = ms.setActionHandler.bind(ms);
  Object.defineProperty(ms, '__surfActions', { value: actions });
  ms.setActionHandler = (action, handler) => { actions[action] = handler; return set(action, handler); };
})()`;

// The page's main media element: the one playing, else the last one played
const FIND_MEDIA = `const media = [...document.querySelectorAll('video, audio')];
  const el = media.find((m) => !m.paused) || media.find((m) => m.currentTime > 0) || media[0];
  const ms = navigator.mediaSession;
  const actions = (ms && ms.__surfActions) || {};`;

// Now Playing details. A page without MediaSession metadata gets its title and site, so
// macOS Now Playing (fed by Chromium from navigator.mediaSession) shows something useful.
const STATE = `(() => {
  ${FIND_MEDIA}
  if (ms && !ms.metadata && el && !el.paused && window.MediaMetadata) {
    const icon = document.querySelector('link[rel~="icon"]');
    try {
      ms.metadata = new MediaMetadata({ title: document.title || location.hostname, artist: location.hostname, artwork: icon ? [{ src: icon.href }] : [] });
      ms.__surfFilled = true;
    } catch {}
  }
  const md = ms && !ms.__surfFilled ? ms.metadata : null;
  return {
    title: md ? md.title || '' : '',
    artist: md ? md.artist || '' : '',
    actions: Object.keys(actions).filter((a) => actions[a]),
    seekable: !!el && Number.isFinite(el.duration) && el.seekable.length > 0 && el.seekable.end(el.seekable.length - 1) > 0,
  };
})()`;

// Perform a media action: the page's own handler when it has one, otherwise the element
const ACTION = (action) => `(() => {
  ${FIND_MEDIA}
  const action = ${JSON.stringify(action)};
  const call = (name, extra) => { if (!actions[name]) return false; try { actions[name]({ action: name, ...extra }); } catch {} return true; };
  if (action === 'playpause') {
    const playing = media.filter((m) => !m.paused);
    if (playing.length) { playing.forEach((m) => m.pause()); return; }
    if (el) { el.play().catch(() => {}); return; }
    // Players that keep their <audio> out of the DOM (e.g. Spotify) only answer MediaSession
    call(ms && ms.playbackState === 'playing' ? 'pause' : 'play');
  } else if (action === 'seekbackward' || action === 'seekforward') {
    const delta = action === 'seekforward' ? ${SKIP} : -${SKIP};
    if (el && Number.isFinite(el.duration)) el.currentTime = Math.max(0, Math.min(el.duration, el.currentTime + delta));
    else call(action, { seekOffset: ${SKIP} });
  } else if (!call(action) && action === 'previoustrack' && el) {
    el.currentTime = 0;
  }
})()`;

const PIP_ENTER = `(() => {
  const v = [...document.querySelectorAll('video')].find((v) => !v.paused && v.readyState > 2 && v.videoWidth > 200);
  if (v && !document.pictureInPictureElement && document.pictureInPictureEnabled) v.requestPictureInPicture().catch(() => {});
})()`;
const PIP_EXIT = `(() => { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); })()`;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const isLive = (tab) => !!tab && ctx.tabs.live.get(tab.entryId) === tab;

function bindTab(tab) {
  tab.webview.addEventListener('dom-ready', () => tab.webview.executeJavaScript(HOOK).catch(() => {}));
}

function setPlaying(tab, playing) {
  tab.mediaPlaying = playing;
  if (playing) {
    tab.hadMedia = true;
    tab.mediaAt = Date.now();
    current = tab;
    if (tab.ready) tab.webview.executeJavaScript(HOOK).catch(() => {});
    refreshMeta(tab);
  } else {
    tab.pausedAt = Date.now();
  }
  render();
}

function forget(tab) {
  if (current === tab) current = null;
  render();
}

// A paused tab lingers briefly (in the panel and on the media keys) so it can be resumed
const recentlyPaused = (t) => t === current && t.hadMedia && Date.now() - (t.pausedAt || 0) < KEY_GRACE;

// Tabs worth listing, most recently started first
function items() {
  const list = [...ctx.tabs.live.values()].filter((t) => t.kind === 'web' && (t.mediaPlaying || t.audible || recentlyPaused(t)));
  return list.sort((a, b) => (b.mediaAt || 0) - (a.mediaAt || 0));
}

// The tab the media keys control: the most recent one still playing, else the last one played
function keyTarget() {
  const list = items();
  return list.find((t) => t.mediaPlaying || t.audible) || list[0] || null;
}

// Tell main whether to hold the media keys: only while something plays (or just paused)
function syncKeys() {
  const target = keyTarget();
  const active = !!target;
  const state = active ? `on:${target.mediaAt || 0}` : 'off';
  if (state === keysSent) return;
  keysSent = state;
  ipcRenderer.send('media-keys', { active, at: active ? target.mediaAt : 0 });
}

async function refreshMeta(tab) {
  if (!tab.ready) return;
  let meta = null;
  try {
    meta = await tab.webview.executeJavaScript(STATE, true);
  } catch { /* page gone */ }
  if (!meta) return;
  const before = JSON.stringify(tab.mediaMeta || null);
  tab.mediaMeta = meta;
  if (JSON.stringify(meta) !== before) render();
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function toggleMute(tab) {
  if (!tab || tab.kind !== 'web') return;
  tab.muted = !tab.muted;
  tab.webview.setAudioMuted(tab.muted);
  ctx.sidebar.updateEntry(tab.entryId);
  render();
}

function setMuted(tab, muted) {
  if (tab.muted !== muted) toggleMute(tab);
}

async function act(tab, action) {
  if (!tab || !tab.ready) return;
  try {
    await tab.webview.executeJavaScript(ACTION(action), true);
  } catch { /* page gone */ }
}

const togglePlay = (tab) => act(tab, 'playpause');

// Live web tabs that would be muted to leave only `keep` audible
function othersToMute(keep) {
  return [...ctx.tabs.live.values()].filter((t) => t.kind === 'web' && t !== keep && !t.muted);
}

function muteOthers(keep = ctx.tabs.activeTab()) {
  const tabs = othersToMute(keep);
  if (!tabs.length) {
    U.toast('No other tabs to mute');
    return;
  }
  tabs.forEach((t) => setMuted(t, true));
  const playing = tabs.filter((t) => t.mediaPlaying || t.audible).length;
  U.toast(playing ? `Muted ${playing} other tab${playing === 1 ? '' : 's'} playing sound` : `Muted ${tabs.length} other tab${tabs.length === 1 ? '' : 's'}`, {
    actionLabel: 'Undo',
    action: () => tabs.filter(isLive).forEach((t) => setMuted(t, false)),
  });
}

// A media key from main (Surf may be in the background)
function onMediaKey(key) {
  const tab = keyTarget();
  if (!tab) return;
  if (key === 'playpause') togglePlay(tab);
  else if (key === 'next') act(tab, 'nexttrack');
  else if (key === 'previous') act(tab, 'previoustrack');
}

// Auto picture-in-picture when leaving a tab with a playing video
function onHide(tabs) {
  if (!ctx.settings.get('autoPip')) return;
  for (const tab of tabs) {
    if (tab.kind === 'web' && tab.ready && tab.mediaPlaying) tab.webview.executeJavaScript(PIP_ENTER, true).catch(() => {});
  }
}

function onShow(tabs) {
  for (const tab of tabs) {
    if (tab.kind === 'web' && tab.ready && tab.mediaPlaying) tab.webview.executeJavaScript(PIP_EXIT, true).catch(() => {});
  }
  render();
}

// Audible state isn't evented on <webview>; poll the few live tabs
let ticks = 0;
function poll() {
  for (const tab of ctx.tabs.live.values()) {
    if (tab.kind !== 'web' || !tab.ready) continue;
    let audible = false;
    try {
      audible = tab.webview.isCurrentlyAudible();
    } catch { /* detached */ }
    if (audible !== tab.audible) {
      tab.audible = audible;
      if (audible && !tab.mediaPlaying) {
        tab.hadMedia = true;
        tab.mediaAt = Date.now();
        current = tab;
      }
      if (!audible) tab.pausedAt = Date.now();
      ctx.sidebar.updateEntry(tab.entryId);
      render();
    }
  }
  // Titles and available actions change as tracks advance; a cheap look every few seconds
  if (++ticks % 3 === 0 && !U.$('media-player').hidden) items().forEach(refreshMeta);
  // Favicons and titles arrive after playback starts and aren't evented here
  if (signature() !== rendered) render();
  syncKeys();
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

function setCollapsed(value) {
  collapsed = value;
  U.store.set('browser.mediaCollapsed', collapsed);
  render();
}

function itemMenu(tab, e) {
  e.preventDefault();
  U.contextMenu([
    { label: 'Go to Tab', icon: 'arrow', action: () => ctx.tabs.showEntry(tab.entryId) },
    { label: tab.muted ? 'Unmute Tab' : 'Mute Tab', icon: tab.muted ? 'volume' : 'mute', action: () => toggleMute(tab) },
    { label: 'Mute All Other Tabs', icon: 'mute', action: () => muteOthers(tab) },
  ], e.clientX, e.clientY);
}

function renderItem(tab, primary) {
  const meta = tab.mediaMeta || {};
  const actions = new Set(meta.actions || []);
  const playing = tab.mediaPlaying || tab.audible;
  const site = U.compactUrl(tab.url);

  const item = U.el('div', `media-item${primary ? ' primary' : ''}${playing ? '' : ' paused'}`);
  item.addEventListener('contextmenu', (e) => itemMenu(tab, e));

  const row = U.el('div', 'media-row');
  const info = U.el('button', 'media-info');
  info.type = 'button';
  info.title = 'Go to tab';
  const iconWrap = U.el('span', 'row-icon');
  iconWrap.appendChild(U.iconElement(tab.favicon, U.ICONS.globe));
  const text = U.el('span', 'media-text');
  text.append(
    U.el('span', 'media-title', meta.title || tab.title || site),
    U.el('span', 'media-sub', meta.artist && meta.artist !== site ? `${meta.artist} · ${site}` : site),
  );
  info.append(iconWrap, text);
  info.addEventListener('click', () => ctx.tabs.showEntry(tab.entryId));

  const controls = U.el('div', 'media-controls');
  const playBtn = U.iconButton(playing ? 'pause' : 'play', playing ? 'Pause' : 'Play', () => togglePlay(tab), 'icon-btn small');
  const muteBtn = U.iconButton(tab.muted ? 'mute' : 'volume', tab.muted ? 'Unmute' : 'Mute', () => toggleMute(tab), 'icon-btn small');
  row.append(info, controls);
  item.appendChild(row);

  // The primary tab gets a transport row when there's more to it than play/pause
  if (primary && (meta.seekable || actions.has('previoustrack') || actions.has('nexttrack'))) {
    const bar = U.el('div', 'media-transport');
    const button = (name, title, action) => U.iconButton(name, title, () => act(tab, action), 'icon-btn small');
    if (actions.has('previoustrack')) bar.appendChild(button('trackPrev', 'Previous track', 'previoustrack'));
    if (meta.seekable) bar.appendChild(button('skipBack', `Back ${SKIP} seconds`, 'seekbackward'));
    bar.appendChild(playBtn);
    if (meta.seekable) bar.appendChild(button('skipForward', `Forward ${SKIP} seconds`, 'seekforward'));
    if (actions.has('nexttrack')) bar.appendChild(button('trackNext', 'Next track', 'nexttrack'));
    item.appendChild(bar);
    controls.append(muteBtn);
  } else {
    controls.append(playBtn, muteBtn);
  }
  return item;
}

const signature = () => items().map((t) => `${t.entryId}|${t.favicon}|${t.title}`).join('\n');

function render() {
  const player = U.$('media-player');
  const list = items();
  rendered = signature();
  // Hidden when nothing plays, or when the only media is the tab you're looking at
  const visible = list.length > 0 && !(list.length === 1 && ctx.tabs.displayed.includes(list[0].entryId));
  player.hidden = !visible;
  if (!visible) return;

  player.replaceChildren();
  player.classList.toggle('collapsed', collapsed);

  const head = U.el('div', 'media-head');
  const toggle = U.el('button', 'media-head-toggle');
  toggle.type = 'button';
  toggle.title = collapsed ? 'Show all playing tabs' : 'Show only the latest';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  const playingCount = list.filter((t) => t.mediaPlaying || t.audible).length;
  toggle.append(U.icon(collapsed ? 'chevronRight' : 'chevronDown'), U.el('span', null, playingCount > 1 ? `${playingCount} playing` : playingCount ? 'Now playing' : 'Paused'));
  toggle.addEventListener('click', () => setCollapsed(!collapsed));
  head.appendChild(toggle);
  if (othersToMute(list[0]).some((t) => t.mediaPlaying || t.audible)) {
    head.appendChild(U.iconButton('mute', 'Mute all other tabs', () => muteOthers(list[0]), 'icon-btn small media-mute-others'));
  }
  player.appendChild(head);

  player.appendChild(renderItem(list[0], !collapsed));
  if (!collapsed) {
    const rest = U.el('div', 'media-rest');
    list.slice(1).forEach((tab) => rest.appendChild(renderItem(tab, false)));
    if (rest.childElementCount) player.appendChild(rest);
  }
}

function setup() {
  setInterval(poll, 1000);
  ipcRenderer.on('media-key', (_e, key) => onMediaKey(key));
}

ctx.media = { setup, bindTab, setPlaying, forget, toggleMute, togglePlay, muteOthers, othersToMute, onHide, onShow, render };
