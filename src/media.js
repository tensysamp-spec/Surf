// Media: sidebar mini player for tabs playing audio/video, mute, and auto picture-in-picture.

const ctx = require('./ctx');
const U = require('./util');

let current = null; // tab shown in the mini player

const PIP_ENTER = `(() => {
  const v = [...document.querySelectorAll('video')].find((v) => !v.paused && v.readyState > 2 && v.videoWidth > 200);
  if (v && !document.pictureInPictureElement && document.pictureInPictureEnabled) v.requestPictureInPicture().catch(() => {});
})()`;
const PIP_EXIT = `(() => { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); })()`;
const TOGGLE_PLAY = `(() => {
  const media = [...document.querySelectorAll('video, audio')];
  const playing = media.filter((m) => !m.paused);
  if (playing.length) { playing.forEach((m) => m.pause()); return false; }
  const target = media.find((m) => m.currentTime > 0) || media[0];
  if (target) { target.play().catch(() => {}); return true; }
  return null;
})()`;

function setPlaying(tab, playing) {
  tab.mediaPlaying = playing;
  if (playing) {
    tab.hadMedia = true;
    current = tab;
  }
  render();
}

function forget(tab) {
  if (current === tab) current = null;
  render();
}

function toggleMute(tab) {
  if (!tab || tab.kind !== 'web') return;
  tab.muted = !tab.muted;
  tab.webview.setAudioMuted(tab.muted);
  ctx.sidebar.updateEntry(tab.entryId);
  render();
}

async function togglePlay(tab) {
  if (!tab || !tab.ready) return;
  try {
    await tab.webview.executeJavaScript(TOGGLE_PLAY, true);
  } catch { /* page gone */ }
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
function pollAudible() {
  for (const tab of ctx.tabs.live.values()) {
    if (tab.kind !== 'web' || !tab.ready) continue;
    let audible = false;
    try {
      audible = tab.webview.isCurrentlyAudible();
    } catch { /* detached */ }
    if (audible !== tab.audible) {
      tab.audible = audible;
      if (audible) current = tab;
      ctx.sidebar.updateEntry(tab.entryId);
      render();
    }
  }
}

function render() {
  const player = U.$('media-player');
  const tab = current && ctx.tabs.live.get(current.entryId) === current ? current : null;
  const visible = tab && (tab.mediaPlaying || tab.audible || tab.hadMedia) && !ctx.tabs.displayed.includes(tab.entryId);
  player.hidden = !visible;
  if (!visible) return;

  player.replaceChildren();
  const info = U.el('button', 'media-info');
  info.title = 'Go to tab';
  const iconWrap = U.el('span', 'row-icon');
  iconWrap.appendChild(U.iconElement(tab.favicon, U.ICONS.globe));
  const text = U.el('span', 'media-text');
  text.append(U.el('span', 'media-title', tab.title || U.compactUrl(tab.url)), U.el('span', 'media-sub', U.compactUrl(tab.url)));
  info.append(iconWrap, text);
  info.addEventListener('click', () => ctx.tabs.showEntry(tab.entryId));

  const controls = U.el('div', 'media-controls');
  controls.appendChild(U.iconButton(tab.mediaPlaying ? 'pause' : 'play', tab.mediaPlaying ? 'Pause' : 'Play', () => togglePlay(tab)));
  controls.appendChild(U.iconButton(tab.muted ? 'mute' : 'volume', tab.muted ? 'Unmute' : 'Mute', () => toggleMute(tab)));
  player.append(info, controls);
}

function setup() {
  setInterval(pollAudible, 1000);
}

ctx.media = { setup, setPlaying, forget, toggleMute, onHide, onShow, render };
