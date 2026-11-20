// Pure helpers of the tab model (src/tabs.js), kept apart so they can be tested without a window.

// Pinned tabs and favorites keep a home page; this is what counts as "the same page" for it
const pageKey = (u) => {
  try {
    const x = new URL(u);
    return x.host.replace(/^www\./, '') + x.pathname.replace(/\/$/, '') + x.search;
  } catch {
    return u;
  }
};

function hslHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// A custom space color { h: 0–360, s: 0–1, i: 0–1 } -> a palette shaped like THEMES
function paletteFromColor({ h, s, i = 0.6 }) {
  const sat = s * 100 * (0.35 + 0.65 * i);
  return {
    a: hslHex(h, sat * 0.95, 86 - 4 * i),
    b: hslHex(h, sat * 0.9, 95),
    c: hslHex(h + 50, sat * 0.75, 87),
    accent: hslHex(h, 8 + 57 * s, 50),
    dark: {
      a: hslHex(h, sat * 0.5, 20 + 10 * i),
      b: hslHex(h, sat * 0.2, 10),
      c: hslHex(h + 40, sat * 0.4, 18 + 4 * i),
      accent: hslHex(h, 20 + 80 * s, 78),
    },
  };
}

module.exports = { pageKey, hslHex, paletteFromColor };
