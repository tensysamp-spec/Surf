// Site colors: the dominant color of a site's icon, used to tint and glow its
// favorite tile and pinned tab. Results are cached (and remembered across launches).

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

// v3: v2 could hold failed lookups saved as '' (no color) for good
const KEY = 'browser.siteColors.v3';
const LIMIT = 400;

// favicon URL -> 'hsl(...)', or '' when the icon has no real color (gray, black, white)
const cache = new Map(Object.entries(U.store.get(KEY, {})));
const pending = new Set();
// Lookups that failed (offline, timeout, bad image) aren't cached; they retry after a
// backoff that doubles each time: key -> { until, delay }
const failed = new Map();
const RETRY_MIN = 60 * 1000;
const RETRY_MAX = 60 * 60 * 1000;

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const entries = [...cache.entries()].slice(-LIMIT);
    U.store.set(KEY, Object.fromEntries(entries));
  }, 1000);
}

let renderQueued = false;
function rerender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    ctx.sidebar.render();
  });
}

async function loadImage(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

// The icon's most common color: bucket colorful pixels by hue, take the heaviest
// bucket, and average within it (so multicolor icons like Gmail pick red, not a muddy mix)
function dominant(img) {
  const size = 32;
  const BUCKETS = 18;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, size, size);
  const { data } = g.getImageData(0, 0, size, size);

  const buckets = Array.from({ length: BUCKETS }, () => ({ w: 0, x: 0, y: 0, s: 0 }));
  let opaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    if (a < 0.5) continue;
    opaque++;
    const r = data[i] / 255, gr = data[i + 1] / 255, b = data[i + 2] / 255;
    const max = Math.max(r, gr, b), min = Math.min(r, gr, b), d = max - min;
    const l = (max + min) / 2;
    const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    if (s < 0.2 || l < 0.1 || l > 0.93) continue;
    let h = max === r ? ((gr - b) / d) % 6 : max === gr ? (b - r) / d + 2 : (r - gr) / d + 4;
    h = (h * 60 + 360) % 360;
    const w = s * a;
    const bucket = buckets[Math.floor(h / (360 / BUCKETS)) % BUCKETS];
    bucket.w += w;
    bucket.x += Math.cos((h * Math.PI) / 180) * w;
    bucket.y += Math.sin((h * Math.PI) / 180) * w;
    bucket.s += s * w;
  }
  // Merge each bucket with its neighbors so a hue split across a boundary still wins
  let best = null, bestW = 0;
  buckets.forEach((_, i) => {
    const group = [buckets[(i + BUCKETS - 1) % BUCKETS], buckets[i], buckets[(i + 1) % BUCKETS]];
    const w = group.reduce((sum, k) => sum + k.w, 0);
    if (w > bestW) {
      bestW = w;
      best = group;
    }
  });
  // Mostly-monochrome icons (e.g. GitHub, X, Wikipedia) get no glow
  if (!opaque || bestW < opaque * 0.06) return '';
  const x = best.reduce((sum, k) => sum + k.x, 0);
  const y = best.reduce((sum, k) => sum + k.y, 0);
  const sat = best.reduce((sum, k) => sum + k.s, 0) / bestW;
  const hue = Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
  const s = Math.round(Math.max(45, Math.min(90, sat * 100)));
  return `hsl(${hue}, ${s}%, 55%)`;
}

async function extract(url, partition) {
  const src = url.startsWith('data:') ? url : await ipcRenderer.invoke('fetch-icon', url, partition);
  if (!src) throw new Error('icon unavailable');
  return dominant(await loadImage(src));
}

// Icons that are data: URLs can be huge; key those by a short hash instead
function keyOf(url) {
  if (url.length < 300) return url;
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0;
  return `data#${url.length}:${h}`;
}

// Returns the color now if known; otherwise starts working it out and re-renders the sidebar when done
// (partition: the session of the tab the icon belongs to, e.g. an isolated Space)
function get(url, partition) {
  if (!url) return null;
  const key = keyOf(url);
  if (cache.has(key)) return cache.get(key) || null;
  const failure = failed.get(key);
  if (failure && Date.now() < failure.until) return null;
  if (!pending.has(key)) {
    pending.add(key);
    extract(url, partition).then(
      (color) => {
        pending.delete(key);
        failed.delete(key);
        cache.delete(key);
        cache.set(key, color);
        persist();
        if (color) rerender();
      },
      () => {
        pending.delete(key);
        const delay = failure ? Math.min(failure.delay * 2, RETRY_MAX) : RETRY_MIN;
        failed.set(key, { until: Date.now() + delay, delay });
      },
    );
  }
  return null;
}

// Give a sidebar element its site color (as --site), or clear it
function apply(node, url, partition) {
  const color = get(url, partition);
  node.classList.toggle('has-site', !!color);
  if (color) node.style.setProperty('--site', color);
  else node.style.removeProperty('--site');
}

ctx.siteColor = { get, apply };
