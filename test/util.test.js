const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

// src/util.js needs electron's ipcRenderer and the window's localStorage at load
require('./helpers/fake-electron');
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
const U = require('../src/util');

const DDG = 'https://duckduckgo.com/?q=';
const NEWTAB = pathToFileURL(path.join(__dirname, '..', 'newtab.html')).href;

test.beforeEach(() => {
  storage.clear();
  U.setSpaceEngine(null);
});

test('NEWTAB_URL points at newtab.html', () => {
  assert.equal(U.NEWTAB_URL, NEWTAB);
});

test('resolveInput: full URLs and special schemes pass through', () => {
  for (const url of ['https://example.com', 'http://a.b/c?d#e', 'file:///tmp/x.html', 'chrome-extension://abc/page.html', 'ftp://host/x',
    'about:blank', 'data:text/plain,hi', 'mailto:me@example.com', 'view-source:https://example.com']) {
    assert.equal(U.resolveInput(url), url);
  }
});

test('resolveInput: trims, and empty input is null', () => {
  assert.equal(U.resolveInput('  https://example.com  '), 'https://example.com');
  assert.equal(U.resolveInput(''), null);
  assert.equal(U.resolveInput('   '), null);
  assert.equal(U.resolveInput(null), null);
  assert.equal(U.resolveInput(undefined), null);
});

test('resolveInput: domains get https', () => {
  assert.equal(U.resolveInput('example.com'), 'https://example.com');
  assert.equal(U.resolveInput('www.example.co.uk/path?q=1#x'), 'https://www.example.co.uk/path?q=1#x');
  assert.equal(U.resolveInput('sub-domain.example.io:8443/x'), 'https://sub-domain.example.io:8443/x');
  assert.equal(U.resolveInput('Example.COM'), 'https://Example.COM');
  assert.equal(U.resolveInput('xn--bcher-kva.example'), 'https://xn--bcher-kva.example');
  assert.equal(U.resolveInput('example.xn--p1ai'), 'https://example.xn--p1ai');
});

test('resolveInput: local hosts and IP addresses get http', () => {
  assert.equal(U.resolveInput('localhost'), 'http://localhost');
  assert.equal(U.resolveInput('localhost:3000/app'), 'http://localhost:3000/app');
  assert.equal(U.resolveInput('127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(U.resolveInput('0.0.0.0'), 'http://0.0.0.0');
  assert.equal(U.resolveInput('[::1]:5000'), 'http://[::1]:5000');
  assert.equal(U.resolveInput('192.168.1.10/admin'), 'http://192.168.1.10/admin');
});

test('resolveInput: everything else is a search', () => {
  assert.equal(U.resolveInput('hello world'), DDG + 'hello%20world');
  assert.equal(U.resolveInput('example.com is down'), DDG + 'example.com%20is%20down');
  assert.equal(U.resolveInput('weather'), DDG + 'weather');
  assert.equal(U.resolveInput('a.b'), DDG + 'a.b', 'one-letter TLDs are not domains');
  assert.equal(U.resolveInput('c++'), DDG + 'c%2B%2B');
  assert.equal(U.resolveInput('1.5'), DDG + '1.5');
  assert.equal(U.resolveInput('what?'), DDG + 'what%3F');
});

test('search engine: settings choice, and a Space can override it', () => {
  storage.set('browser.settings', JSON.stringify({ searchEngine: 'google' }));
  assert.equal(U.resolveInput('cats'), 'https://www.google.com/search?q=cats');
  U.setSpaceEngine('bing');
  assert.equal(U.resolveInput('cats'), 'https://www.bing.com/search?q=cats');
  U.setSpaceEngine('not-an-engine');
  assert.equal(U.resolveInput('cats'), 'https://www.google.com/search?q=cats');
  storage.set('browser.settings', JSON.stringify({ searchEngine: 'nope' }));
  assert.equal(U.resolveInput('cats'), DDG + 'cats');
});

test('looksLikeUrl', () => {
  for (const text of ['example.com', 'https://x.y', 'localhost:3000', '10.0.0.1', 'about:blank']) assert.equal(U.looksLikeUrl(text), true, text);
  for (const text of ['hello world', 'weather', '', '   ', 'a.b']) assert.equal(U.looksLikeUrl(text), false, text);
  // Follows the current search engine
  U.setSpaceEngine('brave');
  assert.equal(U.looksLikeUrl('weather'), false);
  assert.equal(U.looksLikeUrl('example.com'), true);
});

test('isNewTabUrl', () => {
  assert.equal(U.isNewTabUrl(NEWTAB), true);
  assert.equal(U.isNewTabUrl(NEWTAB + '?space=1'), true);
  assert.equal(U.isNewTabUrl(NEWTAB + '#x'), true);
  assert.equal(U.isNewTabUrl('https://example.com'), false);
  assert.equal(U.isNewTabUrl(NEWTAB.replace('newtab', 'index')), false);
  assert.equal(U.isNewTabUrl(''), false);
  assert.equal(U.isNewTabUrl(null), false);
});

test('displayUrl: blank for the new tab page', () => {
  assert.equal(U.displayUrl(NEWTAB), '');
  assert.equal(U.displayUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(U.displayUrl(''), '');
  assert.equal(U.displayUrl(undefined), '');
});

test('compactUrl: host without www for web pages', () => {
  assert.equal(U.compactUrl('https://www.example.com/a/b?c'), 'example.com');
  assert.equal(U.compactUrl('http://sub.example.com:8080/'), 'sub.example.com:8080');
  assert.equal(U.compactUrl('https://wwwexample.com'), 'wwwexample.com');
  assert.equal(U.compactUrl('file:///tmp/a.html'), 'file:///tmp/a.html');
  assert.equal(U.compactUrl('about:blank'), 'about:blank');
  assert.equal(U.compactUrl('not a url'), 'not a url');
  assert.equal(U.compactUrl(NEWTAB), '');
  assert.equal(U.compactUrl(''), '');
  assert.equal(U.compactUrl(null), '');
});

test('hostOf', () => {
  assert.equal(U.hostOf('https://www.example.com/a'), 'www.example.com');
  assert.equal(U.hostOf('http://localhost:3000'), 'localhost:3000');
  assert.equal(U.hostOf('file:///tmp/x'), '');
  assert.equal(U.hostOf('not a url'), 'not a url');
  assert.equal(U.hostOf(''), '');
  assert.equal(U.hostOf(undefined), '');
});

test('store: JSON values with fallbacks', () => {
  assert.equal(U.store.get('browser.missing', 7), 7);
  U.store.set('browser.thing', { a: [1, 2] });
  assert.deepEqual(U.store.get('browser.thing', null), { a: [1, 2] });
  storage.set('browser.broken', '{not json');
  assert.equal(U.store.get('browser.broken', 'fallback'), 'fallback');
  storage.set('browser.null', 'null');
  assert.equal(U.store.get('browser.null', 'fallback'), 'fallback');
});

test('formatBytes and uid', () => {
  assert.equal(U.formatBytes(0), '0 B');
  assert.equal(U.formatBytes(512), '512 B');
  assert.equal(U.formatBytes(1536), '1.5 KB');
  assert.equal(U.formatBytes(5 * 1024 ** 3), '5.0 GB');
  const a = U.uid();
  const b = U.uid();
  assert.match(a, /^[a-z0-9]+$/);
  assert.notEqual(a, b);
});
