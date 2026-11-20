const test = require('node:test');
const assert = require('node:assert/strict');
const { pageKey, hslHex, paletteFromColor } = require('../src/tab-helpers');

test('pageKey: ignores scheme, www, trailing slash and hash', () => {
  const key = pageKey('https://www.example.com/docs/');
  assert.equal(key, 'example.com/docs');
  assert.equal(pageKey('http://example.com/docs'), key);
  assert.equal(pageKey('https://example.com/docs#intro'), key);
  assert.equal(pageKey('https://example.com'), 'example.com');
  assert.equal(pageKey('https://example.com/'), 'example.com');
});

test('pageKey: keeps the query, port and subdomains apart', () => {
  assert.equal(pageKey('https://example.com/search?q=a'), 'example.com/search?q=a');
  assert.notEqual(pageKey('https://example.com/?q=a'), pageKey('https://example.com/?q=b'));
  assert.notEqual(pageKey('https://mail.example.com'), pageKey('https://example.com'));
  assert.equal(pageKey('http://localhost:3000/x/'), 'localhost:3000/x');
});

test('pageKey: anything that is not a URL is its own key', () => {
  assert.equal(pageKey('not a url'), 'not a url');
  assert.equal(pageKey(''), '');
  assert.equal(pageKey(undefined), undefined);
});

test('hslHex: primary colors, grays and clamping', () => {
  assert.equal(hslHex(0, 100, 50), '#ff0000');
  assert.equal(hslHex(120, 100, 50), '#00ff00');
  assert.equal(hslHex(240, 100, 50), '#0000ff');
  assert.equal(hslHex(0, 0, 0), '#000000');
  assert.equal(hslHex(0, 0, 100), '#ffffff');
  assert.equal(hslHex(200, 0, 50), '#808080');
  // Hue wraps around, saturation and lightness are clamped
  assert.equal(hslHex(360, 100, 50), hslHex(0, 100, 50));
  assert.equal(hslHex(-120, 100, 50), hslHex(240, 100, 50));
  assert.equal(hslHex(30, 150, 50), hslHex(30, 100, 50));
  assert.equal(hslHex(30, 50, -10), '#000000');
});

test('paletteFromColor: the THEMES shape with valid colors', () => {
  const p = paletteFromColor({ h: 260, s: 0.7 });
  const hex = /^#[0-9a-f]{6}$/;
  for (const k of ['a', 'b', 'c', 'accent']) {
    assert.match(p[k], hex, k);
    assert.match(p.dark[k], hex, `dark.${k}`);
  }
  // Intensity defaults to 0.6
  assert.deepEqual(p, paletteFromColor({ h: 260, s: 0.7, i: 0.6 }));
  // Without saturation everything is gray
  const gray = paletteFromColor({ h: 10, s: 0, i: 1 });
  for (const c of [gray.a, gray.b, gray.c, gray.dark.b]) assert.equal(c.slice(1, 3), c.slice(3, 5));
});

test('paletteFromColor: light backgrounds are lighter than dark ones', () => {
  const p = paletteFromColor({ h: 120, s: 0.5, i: 0.5 });
  const lum = (hex) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
  assert.ok(lum(p.b) > lum(p.dark.b));
  assert.ok(lum(p.a) > lum(p.dark.a));
});
