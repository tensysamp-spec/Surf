// Update checker: asks GitHub for the latest release and tells the browser window when it's
// newer than this build. The app is unsigned, so nothing installs itself — the window shows a
// card whose Download button fetches the release's .zip into Surf's downloads + shelf.

// Where releases come from. Point this at a public releases repo to turn checks on for
// everyone; while the repo is private GitHub answers 404 and the checker stays quiet.
// SURF_UPDATE_URL overrides the whole endpoint (used to test with a local JSON file).
const UPDATE_REPO = 'tensysamp-spec/surf';

const { app, ipcMain, net } = require('electron');

const FIRST_CHECK_MS = 10 * 1000;
const EVERY_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 15 * 1000;

const endpoint = () => process.env.SURF_UPDATE_URL || `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

// "v1.2.3", "1.2", "1.2.3-beta.1" -> { nums: [1, 2, 3], pre: ['beta', 1] } (null if not a version)
function parseVersion(text) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text || '').trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { nums: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)], pre };
}

// Semver order: numbers first; a prerelease sorts before its release; identifiers compare
// numerically when both are numbers, numbers before words, and a longer list wins a tie.
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return (y.pre.length > 0) - (x.pre.length > 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p !== typeof q) return typeof p === 'number' ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

// The Apple Silicon zip if there is one, else any zip/dmg, else the release page itself
function pickAsset(assets, fallback) {
  const list = Array.isArray(assets) ? assets.filter((a) => a && a.browser_download_url) : [];
  const named = (re) => list.find((a) => re.test(a.name || ''));
  const asset = named(/arm64.*\.zip$/i) || named(/\.zip$/i) || named(/\.dmg$/i);
  return asset ? asset.browser_download_url : fallback;
}

module.exports = function setupUpdates(M, features) {
  const prefs = () => features.prefs();
  const autoEnabled = () => prefs().updatesAuto !== false;
  let available = null; // the newer release found by the last check (until a check says otherwise)
  let timer = null;

  // { status: 'available', update } | { status: 'current' } | { status: 'error' }
  async function check() {
    let res;
    try {
      res = await net.fetch(endpoint(), {
        headers: { 'User-Agent': `Surf/${app.getVersion()}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch {
      return { status: 'error' }; // offline, DNS, timeout
    }
    // 404 (private repo / no releases yet), 403 (rate limit) and friends: nothing to say
    if (!res.ok) return { status: 'error', code: res.status };
    let release;
    try {
      release = await res.json();
    } catch {
      return { status: 'error' };
    }
    const version = parseVersion(release && release.tag_name) && String(release.tag_name).replace(/^v/, '');
    if (!version || release.draft || release.prerelease) return { status: 'current' };
    if (compareVersions(version, app.getVersion()) <= 0) {
      available = null;
      return { status: 'current' };
    }
    const page = /^https:\/\//.test(release.html_url) ? release.html_url : `https://github.com/${UPDATE_REPO}/releases`;
    available = {
      version,
      name: release.name || `Surf ${version}`,
      notesUrl: page,
      downloadUrl: pickAsset(release.assets, page),
    };
    return { status: 'available', update: available };
  }

  // Background check: only speaks up about a newer version the user hasn't skipped
  async function checkQuietly() {
    if (!autoEnabled()) return;
    const result = await check();
    if (result.status === 'available' && result.update.version !== prefs().updatesSkipped) {
      M.sendToMain('update-available', result.update);
    }
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    if (autoEnabled()) timer = setInterval(checkQuietly, EVERY_MS);
  }

  app.whenReady().then(() => {
    setTimeout(checkQuietly, FIRST_CHECK_MS);
    schedule();
  });

  ipcMain.handle('updates-state', () => ({
    version: app.getVersion(),
    auto: autoEnabled(),
    // A window opened after the check (or reopened) still gets to show the card
    pending: available && available.version !== prefs().updatesSkipped ? available : null,
  }));
  ipcMain.handle('updates-check', () => check());
  ipcMain.on('updates-set-auto', (_e, on) => {
    features.setPref('updatesAuto', !!on);
    schedule();
  });
  ipcMain.on('updates-skip', (_e, version) => features.setPref('updatesSkipped', String(version || '')));

  return { check, compareVersions };
};

module.exports.compareVersions = compareVersions;
module.exports.pickAsset = pickAsset;
