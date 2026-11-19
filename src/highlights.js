// Highlights: select text, right-click → Highlight. Saved per page and
// re-applied whenever you come back. Listed in the Library.

const ctx = require('./ctx');
const U = require('./util');

const KEY = 'browser.highlights';
let highlights = U.store.get(KEY, []); // { id, url, title, text, created }
const save = () => U.store.set(KEY, highlights);

// Pages are matched without the #fragment
const pageKey = (url) => String(url || '').split('#')[0];

// Runs inside the page: wraps each saved text (which may span several elements) in <mark>
const APPLY_SCRIPT = (texts) => `(() => {
  const texts = ${JSON.stringify(texts)};
  if (!document.getElementById('__bh-style')) {
    const style = document.createElement('style');
    style.id = '__bh-style';
    style.textContent = 'mark.__bh{background:#ffe58f;color:inherit;border-radius:2px;padding:0 1px;box-shadow:0 0 0 1px rgba(217,160,0,.25)}@media (prefers-color-scheme:dark){mark.__bh{background:#8a6d00;color:#fff}}';
    document.head.appendChild(style);
  }
  let applied = 0;
  for (const raw of texts) {
    const target = raw.replace(/\\s+/g, ' ').trim();
    if (!target) continue;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && !/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(n.parentElement.tagName) && !n.parentElement.closest('mark.__bh') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    // Build a whitespace-normalized copy of the page text with a map back to nodes
    const nodes = [];
    let flat = '';
    const map = [];
    let lastSpace = true;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      nodes.push(node);
      const value = node.nodeValue;
      for (let i = 0; i < value.length; i++) {
        const ch = /\\s/.test(value[i]) ? ' ' : value[i];
        if (ch === ' ' && lastSpace) continue;
        flat += ch;
        map.push([node, i]);
        lastSpace = ch === ' ';
      }
    }
    const at = flat.indexOf(target);
    if (at === -1) continue;
    const [startNode, startOffset] = map[at];
    const [endNode, endOffset] = map[at + target.length - 1];
    // Wrap the text node segments between start and end
    const startIdx = nodes.indexOf(startNode);
    const endIdx = nodes.indexOf(endNode);
    for (let n = endIdx; n >= startIdx; n--) {
      const node = nodes[n];
      const from = n === startIdx ? startOffset : 0;
      const to = n === endIdx ? endOffset + 1 : node.nodeValue.length;
      if (to <= from || !node.nodeValue.slice(from, to).trim()) continue;
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      const mark = document.createElement('mark');
      mark.className = '__bh';
      try { range.surroundContents(mark); } catch (e) { /* skip odd boundaries */ }
    }
    applied++;
  }
  return applied;
})()`;

function forPage(url) {
  const key = pageKey(url);
  return highlights.filter((h) => h.url === key);
}

async function apply(tab) {
  if (!tab || tab.kind !== 'web' || !tab.ready) return 0;
  const list = forPage(tab.url);
  if (!list.length) return 0;
  try {
    return await tab.webview.executeJavaScript(APPLY_SCRIPT(list.map((h) => h.text)));
  } catch {
    return 0;
  }
}

async function add(tab, text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!tab || !clean) return;
  if (clean.length > 2000) {
    U.toast('That selection is too long to highlight');
    return;
  }
  highlights.unshift({ id: U.uid(), url: pageKey(tab.url), title: tab.title || U.compactUrl(tab.url), text: clean, created: Date.now() });
  save();
  try {
    await tab.webview.executeJavaScript(APPLY_SCRIPT([clean]));
  } catch { /* page navigated */ }
  U.toast(U.PRIVATE ? 'Highlighted (not saved in private windows)' : 'Highlighted — find it later in Library › Highlights', { duration: 3000 });
}

function remove(id) {
  highlights = highlights.filter((h) => h.id !== id);
  save();
}

function all() {
  return highlights;
}

function bindTab(tab) {
  tab.webview.addEventListener('did-stop-loading', () => {
    if (forPage(tab.url).length) apply(tab);
  });
}

ctx.highlights = { bindTab, add, remove, all, forPage };
