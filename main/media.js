// Media keys: while a tab plays, the keyboard's play/pause, next and previous keys control
// it even when Surf isn't focused. They're registered only while something plays, so an
// idle Surf doesn't take them from Music or Spotify.
//
// macOS only lets an app claim media keys this way when it's a trusted accessibility client.
// Without that, register() fails and Chromium's own Now Playing integration (which routes
// the keys to whichever app played last, and shows the page's navigator.mediaSession
// metadata) still does the job, so a failure here is quiet.

const { app, ipcMain, globalShortcut } = require('electron');

const KEYS = { MediaPlayPause: 'playpause', MediaNextTrack: 'next', MediaPreviousTrack: 'previous' };

module.exports = function setupMedia() {
  const windows = new Map(); // webContents id → { contents, at } for windows with media
  let registered = false;
  let available = true; // false once macOS refused us; retried when playback starts anew
  const watched = new Set(); // windows we already listen to for 'destroyed'

  // The window whose tab started playing most recently gets the keys
  function target() {
    let best = null;
    for (const w of windows.values()) if (!best || w.at > best.at) best = w;
    return best && !best.contents.isDestroyed() ? best.contents : null;
  }

  function register() {
    if (registered || !available) return;
    registered = true;
    for (const [accel, action] of Object.entries(KEYS)) {
      let ok = false;
      try {
        ok = globalShortcut.register(accel, () => {
          const contents = target();
          if (contents) contents.send('media-key', action);
        });
      } catch { /* unsupported accelerator */ }
      if (!ok) available = false;
    }
    if (!available) unregister();
  }

  function unregister() {
    if (!registered) return;
    registered = false;
    for (const accel of Object.keys(KEYS)) {
      try {
        if (globalShortcut.isRegistered(accel)) globalShortcut.unregister(accel);
      } catch { /* already gone */ }
    }
  }

  function update() {
    if (windows.size) register();
    else unregister();
  }

  // A browser window reports whether it has media worth controlling (and when it started)
  ipcMain.on('media-keys', (event, { active, at } = {}) => {
    const contents = event.sender;
    if (active) {
      if (!windows.has(contents.id)) {
        available = true; // a fresh start: try again (accessibility may have been granted)
      }
      if (!watched.has(contents.id)) {
        watched.add(contents.id);
        const id = contents.id;
        contents.once('destroyed', () => {
          watched.delete(id);
          windows.delete(id);
          update();
        });
      }
      windows.set(contents.id, { contents, at: Number(at) || Date.now() });
    } else {
      windows.delete(contents.id);
    }
    update();
  });

  ipcMain.handle('media-keys-status', () => ({ registered, available }));

  app.on('will-quit', unregister);
};
