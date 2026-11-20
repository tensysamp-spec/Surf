// Annotate PDF: opens the active tab's PDF in a Surf view built on pdf.js (pages, selectable
// text, fillable form fields), with our own layer on top for highlights, notes, ink and
// signatures. "Save a copy…" writes a new PDF with pdf-lib (src/pdf-export.js); the original
// file is never touched. Chromium's own viewer stays the default for reading PDFs.

const { ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');
const ctx = require('./ctx');
const U = require('./util');
const { exportPdf } = require('./pdf-export');

const SIG_KEY = 'browser.pdfSignature';
const NOTE_SIZE = 12; // pt
const INK_WIDTH = 2; // pt
const SIG_WIDTH = 150; // pt, when first placed
// Helvetica's first baseline sits 0.87em below the top of a line-height 1.2 box
const BASELINE = 0.87;
const LINE = 1.2;

const COLORS = {
  ink: [['#1a1a2e', 'Black'], ['#2563eb', 'Blue'], ['#dc2626', 'Red'], ['#16a34a', 'Green']],
  highlight: [['#ffd400', 'Yellow'], ['#5fe08a', 'Green'], ['#ff8fc8', 'Pink'], ['#6cc4ff', 'Blue']],
};
let colors = { ink: '#1a1a2e', highlight: '#ffd400', ...U.store.get('browser.pdfColors', {}) };

const TOOLS = [
  { id: 'select', key: 'v', label: 'Select', tip: 'Select, move and fill forms (V)' },
  { id: 'highlight', key: 'h', label: 'Highlight', tip: 'Highlight text (H)' },
  { id: 'note', key: 't', label: 'Note', tip: 'Add a text note (T)' },
  { id: 'ink', key: 'd', label: 'Draw', tip: 'Draw (D)' },
  { id: 'signature', key: 's', label: 'Sign', tip: 'Place your signature (S)' },
];

// Our own static SVG strings only (same pattern as U.icon)
const svg = (body) => `<svg viewBox="0 0 24 24">${body}</svg>`;
const ICONS = {
  select: svg('<path d="M4 3l7 17 2.5-7.5L21 10z"/>'),
  highlight: U.ICONS.highlighter,
  note: U.ICONS.type,
  ink: svg('<path d="M3 17c3-6 5-9 7-9s1 6 3 6 3-4 5-4 2 3 3 3"/>'),
  signature: svg('<path d="M3 19h18"/><path d="M5 15c2-5 4-9 5.5-9S10 13 12 13s2-3 3.5-3 1 3 2.5 3"/>'),
  undo: U.ICONS.undo,
  redo: svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  minus: svg('<line x1="5" y1="12" x2="19" y2="12"/>'),
  plus: U.ICONS.plus,
  close: U.ICONS.close,
  pdf: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 17l2.5-2.5 1.5 1.5 4-4"/>'),
};
function icon(name) {
  const span = document.createElement('span');
  span.innerHTML = ICONS[name];
  return span.firstChild;
}

/* ------------------------------------------------------------------ */
/* Which tabs show a PDF                                               */
/* ------------------------------------------------------------------ */

// webContentsId -> URL that Chromium's PDF viewer is showing (reported by main/pdf.js)
const viewerUrls = new Map();

ipcRenderer.on('pdf-viewer-shown', (_e, { webContentsId, url }) => {
  viewerUrls.set(webContentsId, url);
  const tab = ctx.tabs.activeTab();
  if (tab && tab.webContentsId === webContentsId) ctx.nav.update();
});

function isPdf(tab) {
  if (!tab || tab.kind !== 'web' || U.isNewTabUrl(tab.url)) return false;
  if (viewerUrls.get(tab.webContentsId) === tab.url) return true;
  try {
    return /\.pdf$/i.test(new URL(tab.url).pathname);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* pdf.js (loaded on first use, from node_modules — never a CDN)       */
/* ------------------------------------------------------------------ */

let libs = null;
const fileUrl = (request) => pathToFileURL(require.resolve(request)).href;
const dirUrl = (request) => new URL('.', fileUrl(request)).href;

async function loadPdfJs() {
  if (libs) return libs;
  const pdfjs = await import(fileUrl('pdfjs-dist/build/pdf.mjs'));
  pdfjs.GlobalWorkerOptions.workerSrc = fileUrl('pdfjs-dist/build/pdf.worker.mjs');
  globalThis.pdfjsLib = pdfjs; // the viewer components read the library from here
  const viewer = await import(fileUrl('pdfjs-dist/web/pdf_viewer.mjs'));
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = fileUrl('pdfjs-dist/web/pdf_viewer.css');
  document.head.appendChild(css);
  const root = dirUrl('pdfjs-dist/package.json');
  libs = {
    pdfjs,
    viewer,
    options: {
      cMapUrl: `${root}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${root}standard_fonts/`,
      wasmUrl: `${root}wasm/`,
      iccUrl: `${root}iccs/`,
      isEvalSupported: false,
      enableXfa: false,
    },
  };
  return libs;
}

/* ------------------------------------------------------------------ */
/* Open / close                                                        */
/* ------------------------------------------------------------------ */

function fileNameOf(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return name.replace(/\.pdf$/i, '') || 'document';
  } catch {
    return 'document';
  }
}

async function open(tab = ctx.tabs.activeTab()) {
  if (!tab || tab.kind !== 'web') return;
  if (tab.pdfEl) return;
  if (!isPdf(tab)) {
    U.toast('This tab isn’t showing a PDF');
    return;
  }
  const st = createView(tab);
  try {
    const [res, { pdfjs, viewer, options }] = await Promise.all([
      ipcRenderer.invoke('pdf-fetch', { url: tab.url, webContentsId: tab.webContentsId }),
      loadPdfJs(),
    ]);
    if (res.error) throw new Error(res.error);
    if (st.closed) return;
    st.bytes = res.bytes;
    // pdf.js moves the buffer it gets to its worker, so it gets a copy
    st.task = pdfjs.getDocument({ data: res.bytes.slice(), ...options });
    st.doc = await st.task.promise;
    if (st.closed) return st.task.destroy();
    mountViewer(st, pdfjs, viewer);
  } catch (err) {
    console.error(err);
    st.status.textContent = String(err.message || err).replace(/^Error: /, '');
    st.status.classList.add('error');
  }
}

async function close(tab = ctx.tabs.activeTab(), { force = false } = {}) {
  const st = tab && tab.pdfState;
  if (!st) return;
  commitEditing(st);
  if (!force && isDirty(st)) {
    const ok = await U.dialog({
      title: 'Close without saving?',
      message: 'Your annotations will be lost. The original PDF isn’t changed.',
      confirmLabel: 'Discard',
      danger: true,
      input: false,
    });
    if (!ok || tab.pdfState !== st) return;
  }
  st.closed = true;
  st.release();
  tab.webview.removeEventListener('did-navigate', st.onNavigate);
  st.el.remove();
  tab.pdfEl = null;
  tab.pdfState = null;
  if (st.task) st.task.destroy().catch(() => {}); // also stops its worker
  if (tab.entryId === ctx.tabs.activeEntryId) {
    ctx.nav.update();
    tab.webview.focus();
  }
}

function toggle() {
  const tab = ctx.tabs.activeTab();
  if (tab && tab.pdfEl) close(tab);
  else open(tab);
}

const isDirty = (st) => st.history.length !== st.savedAt || (!!st.doc && st.doc.annotationStorage.size > st.savedFields);

/* ------------------------------------------------------------------ */
/* View and toolbar                                                    */
/* ------------------------------------------------------------------ */

function createView(tab) {
  const el = U.el('div', 'pdfa-view tab-overlay');
  el.tabIndex = -1;
  const toolbar = U.el('div', 'pdfa-toolbar');
  const scroll = U.el('div', 'pdfa-scroll');
  const status = U.el('div', 'pdfa-status', 'Opening PDF…');
  el.append(toolbar, scroll, status);

  const st = {
    tab,
    el,
    scroll,
    status,
    name: fileNameOf(tab.url),
    tool: 'select',
    marks: [],
    history: [],
    future: [],
    savedAt: 0,
    savedFields: 0,
    selected: null,
    pages: new Map(), // page index -> { layer, svg, base }
    buttons: {},
  };

  const group = () => U.el('div', 'pdfa-group');
  const tools = group();
  for (const t of TOOLS) {
    const b = U.el('button', 'pdfa-tool');
    b.type = 'button';
    b.title = t.tip;
    b.append(icon(t.id), U.el('span', null, t.label));
    b.addEventListener('click', () => (t.id === 'signature' && st.tool === 'signature' ? signatureMenu(st, b) : setTool(st, t.id)));
    b.addEventListener('contextmenu', (e) => {
      if (t.id !== 'signature') return;
      e.preventDefault();
      signatureMenu(st, b);
    });
    st.buttons[t.id] = b;
    tools.appendChild(b);
  }
  const swatch = U.el('button', 'pdfa-swatch');
  swatch.type = 'button';
  swatch.title = 'Color';
  swatch.addEventListener('click', () => colorMenu(st, swatch));
  tools.appendChild(swatch);
  st.swatch = swatch;

  const edits = group();
  st.buttons.undo = U.el('button', 'icon-btn');
  st.buttons.undo.append(icon('undo'));
  st.buttons.undo.title = 'Undo (⌘Z)';
  st.buttons.undo.addEventListener('click', () => undo(st));
  st.buttons.redo = U.el('button', 'icon-btn');
  st.buttons.redo.append(icon('redo'));
  st.buttons.redo.title = 'Redo (⇧⌘Z)';
  st.buttons.redo.addEventListener('click', () => redo(st));
  edits.append(st.buttons.undo, st.buttons.redo);

  const zoom = group();
  const out = U.el('button', 'icon-btn');
  out.append(icon('minus'));
  out.title = 'Zoom out';
  out.addEventListener('click', () => zoomBy(st, 1 / 1.15));
  st.zoomLabel = U.el('button', 'pdfa-zoom', '100%');
  st.zoomLabel.title = 'Fit width';
  st.zoomLabel.addEventListener('click', () => {
    if (st.viewer) st.viewer.currentScaleValue = 'page-width';
  });
  const inn = U.el('button', 'icon-btn');
  inn.append(icon('plus'));
  inn.title = 'Zoom in';
  inn.addEventListener('click', () => zoomBy(st, 1.15));
  zoom.append(out, st.zoomLabel, inn);

  const spacer = U.el('div', 'pdfa-spacer');
  st.pageLabel = U.el('span', 'pdfa-pages');
  const save = U.el('button', 'btn primary pdfa-save', 'Save a copy…');
  save.title = 'Save a new PDF with your annotations';
  save.addEventListener('click', () => saveCopy(st));
  const closeBtn = U.el('button', 'icon-btn');
  closeBtn.append(icon('close'));
  closeBtn.title = 'Close annotation (Esc)';
  closeBtn.addEventListener('click', () => close(tab));
  toolbar.append(tools, edits, zoom, spacer, st.pageLabel, save, closeBtn);
  for (const b of toolbar.querySelectorAll('button')) b.type = 'button';

  el.addEventListener('keydown', (e) => onKey(st, e));
  // A trackpad pinch arrives as ctrl+wheel
  scroll.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomBy(st, Math.exp(-e.deltaY / 100));
  }, { passive: false });
  // Links in the PDF open as tabs; nothing here may navigate the browser UI itself
  scroll.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (href.startsWith('#')) return;
    e.preventDefault();
    if (/^https?:/i.test(link.href)) ctx.tabs.openTab(link.href);
  }, true);
  scroll.addEventListener('mouseup', () => {
    if (st.tool === 'highlight') setTimeout(() => highlightSelection(st), 0);
  });

  st.release = U.pushEscape(() => onEscape(st));
  st.onNavigate = () => close(tab, { force: true });
  tab.webview.addEventListener('did-navigate', st.onNavigate);
  tab.pdfEl = el;
  tab.pdfState = st;
  U.$('webviews-container').appendChild(el);
  ctx.page.syncOverlays();
  ctx.nav.update();
  setTool(st, 'select');
  updateButtons(st);
  el.focus();
  return st;
}

function mountViewer(st, pdfjs, viewer) {
  const container = st.scroll;
  const inner = U.el('div', 'pdfViewer');
  container.appendChild(inner);
  const eventBus = new viewer.EventBus();
  const linkService = new viewer.PDFLinkService({ eventBus });
  const pdfViewer = new viewer.PDFViewer({
    container,
    viewer: inner,
    eventBus,
    linkService,
    annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
    annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE,
    textLayerMode: 1,
    removePageBorders: true,
  });
  linkService.setViewer(pdfViewer);
  st.viewer = pdfViewer;
  st.pdfjs = pdfjs;

  eventBus.on('pagesinit', () => {
    pdfViewer.currentScaleValue = container.clientWidth < 900 ? 'page-width' : 'auto';
    st.status.hidden = true;
  });
  eventBus.on('scalechanging', ({ scale }) => {
    st.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  });
  eventBus.on('pagechanging', ({ pageNumber }) => {
    st.pageLabel.textContent = `${pageNumber} / ${st.doc.numPages}`;
  });
  // pdf.js rebuilds a page's DOM as it renders, zooms, and frees far-away pages, so our
  // layer is (re)attached every time a page or its form layer is drawn
  const attach = ({ source }) => attachLayer(st, source);
  eventBus.on('pagerendered', attach);
  eventBus.on('annotationlayerrendered', attach);

  pdfViewer.setDocument(st.doc);
  linkService.setDocument(st.doc);
  st.pageLabel.textContent = `1 / ${st.doc.numPages}`;
}

function zoomBy(st, factor) {
  if (!st.viewer) return;
  st.viewer.currentScale = Math.max(0.25, Math.min(5, st.viewer.currentScale * factor));
}

function setTool(st, tool) {
  if (tool === 'signature' && !U.store.get(SIG_KEY, null)) {
    drawSignature().then((ok) => ok && setTool(st, 'signature'));
    return;
  }
  commitEditing(st);
  st.tool = tool;
  st.el.dataset.tool = tool;
  for (const t of TOOLS) st.buttons[t.id].classList.toggle('active', t.id === tool);
  const palette = COLORS[tool === 'highlight' ? 'highlight' : 'ink'];
  st.swatch.hidden = !['highlight', 'ink', 'note'].includes(tool);
  st.swatch.style.setProperty('--swatch', colors[tool === 'highlight' ? 'highlight' : 'ink'] || palette[0][0]);
  if (tool !== 'select') select(st, null);
  // Text already selected when Highlight is picked gets highlighted straight away
  if (tool === 'highlight') highlightSelection(st);
}

function colorMenu(st, anchor) {
  const kind = st.tool === 'highlight' ? 'highlight' : 'ink';
  const r = anchor.getBoundingClientRect();
  U.contextMenu([{
    swatches: COLORS[kind].map(([color, title]) => ({
      color,
      title,
      active: colors[kind] === color,
      action: () => {
        colors[kind] = color;
        U.store.set('browser.pdfColors', colors);
        st.swatch.style.setProperty('--swatch', color);
        // Recolor the selected mark too, when it's the matching kind
        const m = st.selected;
        if (m && (kind === 'highlight' ? m.type === 'highlight' : ['ink', 'text'].includes(m.type)) && m.color !== color) {
          const before = m.color;
          change(st, () => { m.color = color; render(st, m.page); }, () => { m.color = before; render(st, m.page); });
        }
      },
    })),
  }], r.left, r.bottom + 6);
}

function updateButtons(st) {
  st.buttons.undo.disabled = !st.history.length;
  st.buttons.redo.disabled = !st.future.length;
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

const isEditable = (node) => !!node && (node.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName));

function onKey(st, e) {
  const mod = e.metaKey || e.ctrlKey;
  if (isEditable(e.target)) return; // typing in a note or a form field
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(st);
    else undo(st);
    return;
  }
  if (mod || e.altKey) return;
  if ((e.key === 'Backspace' || e.key === 'Delete') && st.selected) {
    e.preventDefault();
    removeMark(st, st.selected);
    return;
  }
  const tool = TOOLS.find((t) => t.key === e.key.toLowerCase());
  if (tool && !e.shiftKey) {
    e.preventDefault();
    setTool(st, tool.id);
  }
}

function onEscape(st) {
  if (isEditable(document.activeElement) && st.el.contains(document.activeElement)) {
    document.activeElement.blur();
    st.el.focus();
  } else if (st.tool !== 'select') {
    setTool(st, 'select');
  } else if (st.selected) {
    select(st, null);
  } else {
    close(st.tab);
  }
}

/* ------------------------------------------------------------------ */
/* Undo                                                                */
/* ------------------------------------------------------------------ */

// Every change is a pair of functions; doing it runs `redo`
function change(st, redoFn, undoFn) {
  redoFn();
  record(st, redoFn, undoFn);
}

// For changes that already happened (a drag, typing in a note)
function record(st, redoFn, undoFn) {
  if (st.savedAt > st.history.length) st.savedAt = -1; // the saved state can't come back
  st.history.push({ undo: undoFn, redo: redoFn });
  st.future = [];
  updateButtons(st);
}

function undo(st) {
  commitEditing(st);
  const step = st.history.pop();
  if (!step) return;
  step.undo();
  st.future.push(step);
  select(st, null);
  updateButtons(st);
}

function redo(st) {
  const step = st.future.pop();
  if (!step) return;
  step.redo();
  st.history.push(step);
  updateButtons(st);
}

function addMark(st, m) {
  change(st, () => { st.marks.push(m); render(st, m.page); }, () => { st.marks = st.marks.filter((x) => x !== m); render(st, m.page); });
}

function removeMark(st, m) {
  const index = st.marks.indexOf(m);
  if (index === -1) return;
  select(st, null);
  change(st, () => { st.marks = st.marks.filter((x) => x !== m); render(st, m.page); }, () => { st.marks.splice(index, 0, m); render(st, m.page); });
}

function offset(m, dx, dy) {
  if (m.type === 'ink') m.points = m.points.map(([x, y]) => [x + dx, y + dy]);
  else if (m.type === 'highlight') m.rects = m.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
  else {
    m.x += dx;
    m.y += dy;
  }
}

/* ------------------------------------------------------------------ */
/* The annotation layer of each page                                   */
/* ------------------------------------------------------------------ */

// Marks are kept in each page's unscaled viewport units (PDF points, top-left origin, the
// page's own rotation applied); the layer scales with the page through its viewBox and --k
function attachLayer(st, pageView) {
  if (!pageView || !pageView.div || !pageView.pdfPage) return;
  const index = pageView.id - 1;
  let page = st.pages.get(index);
  if (!page) {
    const base = pageView.pdfPage.getViewport({ scale: 1 });
    const layer = U.el('div', 'pdfa-layer');
    const ns = 'http://www.w3.org/2000/svg';
    const svgEl = document.createElementNS(ns, 'svg');
    svgEl.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
    svgEl.setAttribute('preserveAspectRatio', 'none');
    svgEl.classList.add('pdfa-svg');
    layer.appendChild(svgEl);
    page = { index, base, layer, svg: svgEl };
    st.pages.set(index, page);
    bindLayer(st, page);
  }
  if (page.layer.parentNode !== pageView.div) pageView.div.appendChild(page.layer);
  else pageView.div.appendChild(page.layer); // keep it above layers pdf.js added since
  page.layer.style.setProperty('--k', String(pageView.viewport.width / page.base.width));
  if (!page.rendered) render(st, index);
}

function pointIn(page, e) {
  const r = page.layer.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * page.base.width, ((e.clientY - r.top) / r.height) * page.base.height];
}

const pct = (v, total) => `${(v / total) * 100}%`;

function render(st, index) {
  const page = st.pages.get(index);
  if (!page) return;
  page.rendered = true;
  const { layer, svg: svgEl, base } = page;
  for (const node of [...layer.children]) if (node !== svgEl) node.remove();
  svgEl.replaceChildren();
  const ns = 'http://www.w3.org/2000/svg';
  for (const m of st.marks.filter((x) => x.page === index)) {
    let node;
    if (m.type === 'highlight') {
      node = document.createElementNS(ns, 'g');
      node.setAttribute('class', 'pdfa-hl');
      node.setAttribute('fill', m.color);
      for (const r of m.rects) {
        const rect = document.createElementNS(ns, 'rect');
        for (const [k, v] of Object.entries({ x: r.x, y: r.y, width: r.w, height: r.h })) rect.setAttribute(k, v);
        node.appendChild(rect);
      }
      svgEl.appendChild(node);
    } else if (m.type === 'ink') {
      node = document.createElementNS(ns, 'polyline');
      node.setAttribute('class', 'pdfa-ink');
      node.setAttribute('points', m.points.map((p) => p.join(',')).join(' '));
      node.setAttribute('stroke', m.color);
      node.setAttribute('stroke-width', m.width);
      svgEl.appendChild(node);
    } else if (m.type === 'text') {
      node = U.el('div', 'pdfa-note');
      node.textContent = m.text;
      node.contentEditable = 'plaintext-only';
      node.spellcheck = false;
      node.dataset.placeholder = 'Note';
      Object.assign(node.style, { left: pct(m.x, base.width), top: pct(m.y, base.height), color: m.color });
      node.style.setProperty('--size', m.size);
      bindNote(st, m, node);
      layer.appendChild(node);
    } else if (m.type === 'image') {
      node = U.el('div', 'pdfa-sig');
      const img = U.el('img');
      img.src = m.src;
      img.draggable = false;
      const handle = U.el('div', 'pdfa-resize');
      handle.title = 'Drag to resize';
      node.append(img, handle);
      Object.assign(node.style, { left: pct(m.x, base.width), top: pct(m.y, base.height), width: pct(m.w, base.width), height: pct(m.h, base.height) });
      layer.appendChild(node);
    }
    m.node = node;
    node.classList.add('pdfa-mark');
    if (st.selected === m) node.classList.add('selected');
    node.addEventListener('pointerdown', (e) => onMarkDown(st, page, m, e));
  }
}

function select(st, m) {
  if (st.selected && st.selected.node) st.selected.node.classList.remove('selected');
  st.selected = m;
  if (m && m.node) m.node.classList.add('selected');
}

// Creating marks: the layer only takes the mouse for the note, draw and sign tools
function bindLayer(st, page) {
  // Keep focus where we put it (a new note) instead of letting the click move it
  page.layer.addEventListener('mousedown', (e) => {
    const note = e.target.closest('.pdfa-note');
    if (note && document.activeElement === note) return; // placing the caret while editing
    e.preventDefault();
  });
  page.layer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.pdfa-mark')) return;
    const [x, y] = pointIn(page, e);
    if (st.tool === 'ink') {
      e.preventDefault();
      drawStroke(st, page, e, [x, y]);
    } else if (st.tool === 'note') {
      e.preventDefault();
      commitEditing(st);
      const m = { type: 'text', page: page.index, x, y: y - NOTE_SIZE * 0.6, text: '', size: NOTE_SIZE, color: colors.ink, fresh: true };
      st.marks.push(m);
      render(st, page.index);
      focusNote(m.node);
    } else if (st.tool === 'signature') {
      e.preventDefault();
      placeSignature(st, page, x, y);
    } else if (st.tool === 'select') {
      select(st, null);
    }
  });
}

function drawStroke(st, page, e, start) {
  const ns = 'http://www.w3.org/2000/svg';
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('class', 'pdfa-ink');
  line.setAttribute('stroke', colors.ink);
  line.setAttribute('stroke-width', INK_WIDTH);
  page.svg.appendChild(line);
  const points = [start];
  const draw = () => line.setAttribute('points', points.map((p) => p.map((v) => v.toFixed(2)).join(',')).join(' '));
  draw();
  page.layer.setPointerCapture(e.pointerId);
  const move = (ev) => {
    for (const ce of ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev]) {
      const p = pointIn(page, ce);
      const last = points[points.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 0.6) points.push(p);
    }
    draw();
  };
  const up = () => {
    page.layer.removeEventListener('pointermove', move);
    page.layer.removeEventListener('pointerup', up);
    page.layer.removeEventListener('pointercancel', up);
    line.remove();
    addMark(st, { type: 'ink', page: page.index, points, color: colors.ink, width: INK_WIDTH });
  };
  page.layer.addEventListener('pointermove', move);
  page.layer.addEventListener('pointerup', up);
  page.layer.addEventListener('pointercancel', up);
}

// Select, move, and (signatures) resize existing marks with the Select tool
function onMarkDown(st, page, m, e) {
  if (st.tool !== 'select' || e.button !== 0) return;
  const editing = m.type === 'text' && document.activeElement === m.node;
  if (editing) return;
  e.preventDefault();
  e.stopPropagation();
  commitEditing(st);
  select(st, m);
  st.el.focus();
  const resizing = e.target.classList.contains('pdfa-resize');
  const start = pointIn(page, e);
  const orig = { w: m.w, h: m.h };
  let moved = false;
  let dx = 0;
  let dy = 0;
  const move = (ev) => {
    const p = pointIn(page, ev);
    const nx = p[0] - start[0];
    const ny = p[1] - start[1];
    if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
    moved = true;
    if (resizing) {
      m.w = Math.max(24, orig.w + nx);
      m.h = (m.w * orig.h) / orig.w;
    } else {
      offset(m, nx - dx, ny - dy);
      dx = nx;
      dy = ny;
    }
    render(st, page.index);
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (moved) {
      if (resizing) {
        const after = { w: m.w, h: m.h };
        record(st, () => { Object.assign(m, after); render(st, m.page); }, () => { Object.assign(m, orig); render(st, m.page); });
      } else {
        const [fx, fy] = [dx, dy];
        record(st, () => { offset(m, fx, fy); render(st, m.page); }, () => { offset(m, -fx, -fy); render(st, m.page); });
      }
      select(st, m);
    } else if (m.type === 'text') {
      focusNote(m.node);
    }
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

/* ------------------------------------------------------------------ */
/* Notes                                                               */
/* ------------------------------------------------------------------ */

function focusNote(node) {
  if (!node) return;
  node.focus();
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function bindNote(st, m, node) {
  let before = m.text;
  node.addEventListener('focus', () => {
    before = m.text;
    select(st, m);
  });
  node.addEventListener('input', () => {
    m.text = node.innerText.replace(/\n$/, '');
  });
  node.addEventListener('blur', () => {
    m.text = node.innerText.replace(/\n$/, '');
    if (m.fresh) {
      // A new note becomes one undo step once it has text; an empty one just goes away
      delete m.fresh;
      st.marks = st.marks.filter((x) => x !== m);
      if (m.text.trim()) addMark(st, m);
      else render(st, m.page);
    } else if (!m.text.trim()) {
      m.text = before;
      removeMark(st, m);
    } else if (m.text !== before) {
      const [a, b] = [before, m.text];
      record(st, () => { m.text = b; render(st, m.page); }, () => { m.text = a; render(st, m.page); });
    }
  });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) node.blur();
  });
  // Plain text only, whatever is pasted
  node.addEventListener('paste', (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });
}

function commitEditing(st) {
  const active = document.activeElement;
  if (active && active.classList.contains('pdfa-note') && st.el.contains(active)) active.blur();
}

/* ------------------------------------------------------------------ */
/* Highlights from the text selection                                  */
/* ------------------------------------------------------------------ */

function highlightSelection(st) {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  if (!st.scroll.contains(range.commonAncestorContainer)) return;
  const byPage = new Map();
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (const page of st.pages.values()) {
      if (!page.layer.isConnected) continue;
      const b = page.layer.getBoundingClientRect();
      if (cx < b.left || cx > b.right || cy < b.top || cy > b.bottom) continue;
      // Skip the selection's whole-block rects (e.g. pdf.js's end-of-content marker)
      if (r.height > b.height * 0.2) break;
      const k = page.base.width / b.width;
      const rect = { x: (r.left - b.left) * k, y: (r.top - b.top) * k, w: r.width * k, h: r.height * k };
      if (!byPage.has(page.index)) byPage.set(page.index, []);
      byPage.get(page.index).push(rect);
      break;
    }
  }
  sel.removeAllRanges();
  if (!byPage.size) return;
  const steps = [...byPage].map(([index, rects]) => ({ type: 'highlight', page: index, rects: mergeRects(rects), color: colors.highlight }));
  change(st, () => {
    st.marks.push(...steps);
    for (const m of steps) render(st, m.page);
  }, () => {
    st.marks = st.marks.filter((x) => !steps.includes(x));
    for (const m of steps) render(st, m.page);
  });
}

// One rect per run of text on a line, so overlapping glyph boxes don't darken twice
function mergeRects(rects) {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    const sameLine = last && Math.abs(last.y + last.h / 2 - (r.y + r.h / 2)) < Math.min(last.h, r.h) * 0.5;
    if (sameLine && r.x <= last.x + last.w + 2) {
      const x2 = Math.max(last.x + last.w, r.x + r.w);
      const y1 = Math.min(last.y, r.y);
      const y2 = Math.max(last.y + last.h, r.y + r.h);
      Object.assign(last, { w: x2 - last.x, y: y1, h: y2 - y1 });
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Signature                                                           */
/* ------------------------------------------------------------------ */

function placeSignature(st, page, x, y) {
  const src = U.store.get(SIG_KEY, null);
  if (!src) return;
  const img = new Image();
  img.onload = () => {
    const w = Math.min(SIG_WIDTH, page.base.width * 0.6);
    const h = (w * img.naturalHeight) / img.naturalWidth;
    const m = { type: 'image', page: page.index, src, x: x - w / 2, y: y - h / 2, w, h };
    addMark(st, m);
    setTool(st, 'select');
    select(st, m);
  };
  img.src = src;
}

function signatureMenu(st, anchor) {
  const r = anchor.getBoundingClientRect();
  U.contextMenu([
    { label: 'Draw a new signature…', icon: 'edit', action: () => drawSignature().then((ok) => ok && setTool(st, 'signature')) },
    { label: 'Delete saved signature', icon: 'trash', danger: true, disabled: !U.store.get(SIG_KEY, null), action: () => {
      U.store.set(SIG_KEY, null);
      setTool(st, 'select');
      U.toast('Signature deleted');
    } },
  ], r.left, r.bottom + 6);
}

// A pad to draw a signature once; it's kept (on this Mac only, never in private windows)
// and placed with a click from then on
function drawSignature() {
  return new Promise((resolve) => {
    const backdrop = U.el('div', 'dialog-backdrop');
    const box = U.el('div', 'dialog pdfa-sigpad');
    box.appendChild(U.el('h3', null, 'Your signature'));
    box.appendChild(U.el('p', null, U.PRIVATE
      ? 'Sign with your trackpad or mouse. In a private window it’s only kept until the window closes.'
      : 'Sign with your trackpad or mouse. It’s saved in Surf on this Mac so you can reuse it.'));
    const canvas = U.el('canvas', 'pdfa-sigcanvas');
    const W = 460;
    const H = 170;
    const dpr = 2;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = 2.6;
    g.strokeStyle = '#1a1a2e';
    const hint = U.el('div', 'pdfa-sighint', 'Sign here');
    const pad = U.el('div', 'pdfa-sigbox');
    pad.append(canvas, hint);
    box.appendChild(pad);

    const actions = U.el('div', 'dialog-actions');
    const clear = U.el('button', 'btn', 'Clear');
    const cancel = U.el('button', 'btn', 'Cancel');
    const ok = U.el('button', 'btn primary', 'Use signature');
    for (const b of [clear, cancel, ok]) b.type = 'button';
    ok.disabled = true;
    clear.style.marginRight = 'auto';
    actions.append(clear, cancel, ok);
    box.appendChild(actions);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    let drawn = false;
    let bounds = null;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const at = (ev) => [ev.offsetX, ev.offsetY];
      let [px, py] = at(e);
      const grow = (x, y) => {
        bounds = bounds ? { x1: Math.min(bounds.x1, x), y1: Math.min(bounds.y1, y), x2: Math.max(bounds.x2, x), y2: Math.max(bounds.y2, y) } : { x1: x, y1: y, x2: x, y2: y };
      };
      g.beginPath();
      g.arc(px, py, g.lineWidth / 2, 0, Math.PI * 2);
      g.fillStyle = g.strokeStyle;
      g.fill();
      grow(px, py);
      const move = (ev) => {
        for (const ce of ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev]) {
          const [x, y] = at(ce);
          g.beginPath();
          g.moveTo(px, py);
          g.lineTo(x, y);
          g.stroke();
          [px, py] = [x, y];
          grow(x, y);
        }
      };
      const up = () => {
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        drawn = true;
        ok.disabled = false;
        hint.hidden = true;
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      hint.hidden = true;
    });

    const finish = (result) => {
      release();
      U.removeAnimated(backdrop);
      resolve(result);
    };
    const release = U.pushEscape(() => finish(false));
    clear.addEventListener('click', () => {
      g.clearRect(0, 0, W, H);
      drawn = false;
      bounds = null;
      ok.disabled = true;
      hint.hidden = false;
    });
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => {
      if (!drawn || !bounds) return;
      // Crop to the ink so the signature places snugly
      const padPx = 6;
      const x = Math.max(0, bounds.x1 - padPx) * dpr;
      const y = Math.max(0, bounds.y1 - padPx) * dpr;
      const w = Math.min(W * dpr - x, (bounds.x2 - bounds.x1 + padPx * 2) * dpr);
      const h = Math.min(H * dpr - y, (bounds.y2 - bounds.y1 + padPx * 2) * dpr);
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(w));
      out.height = Math.max(1, Math.round(h));
      out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, out.width, out.height);
      U.store.set(SIG_KEY, out.toDataURL('image/png'));
      finish(true);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Save a copy                                                         */
/* ------------------------------------------------------------------ */

// View marks -> PDF user space, page by page (handles each page's rotation and crop box)
async function toPdfMarks(st) {
  const out = [];
  const bases = new Map();
  for (const m of st.marks) {
    if (!bases.has(m.page)) bases.set(m.page, (await st.doc.getPage(m.page + 1)).getViewport({ scale: 1 }));
    const base = bases.get(m.page);
    const P = (x, y) => base.convertToPdfPoint(x, y);
    const rotate = base.rotation;
    if (m.type === 'highlight') {
      const rects = m.rects.map((r) => {
        const [x1, y1] = P(r.x, r.y);
        const [x2, y2] = P(r.x + r.w, r.y + r.h);
        return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
      });
      out.push({ type: 'highlight', page: m.page, rects, color: m.color });
    } else if (m.type === 'ink') {
      out.push({ type: 'ink', page: m.page, points: m.points.map(([x, y]) => P(x, y)), color: m.color, width: m.width });
    } else if (m.type === 'text') {
      const lines = m.text.split('\n').map((text, i) => {
        const [x, y] = P(m.x, m.y + m.size * (BASELINE + LINE * i));
        return { text, x, y };
      });
      out.push({ type: 'text', page: m.page, lines, size: m.size, color: m.color, rotate });
    } else if (m.type === 'image') {
      const [x, y] = P(m.x, m.y + m.h);
      out.push({ type: 'image', page: m.page, src: m.src, x, y, w: m.w, h: m.h, rotate });
    }
  }
  return out;
}

async function saveCopy(st) {
  if (!st.doc || st.saving) return;
  commitEditing(st);
  st.saving = true;
  try {
    // pdf.js writes the filled-in form fields; pdf-lib then draws our marks on top
    const fields = st.doc.annotationStorage.size;
    const base = fields ? await st.doc.saveDocument() : st.bytes;
    const bytes = await exportPdf(base, await toPdfMarks(st));
    const file = await ipcRenderer.invoke('pdf-save-copy', { bytes, name: st.name });
    if (!file) return;
    st.savedAt = st.history.length;
    st.savedFields = fields;
    U.toast(`Saved “${file.split('/').pop()}”`, { actionLabel: 'Show', action: () => ipcRenderer.send('download-action', { action: 'show', savePath: file }) });
  } catch (err) {
    console.error(err);
    U.toast(/encrypt/i.test(String(err)) ? 'This PDF is encrypted, so a copy can’t be saved' : 'Couldn’t save the PDF');
  } finally {
    st.saving = false;
  }
}

/* ------------------------------------------------------------------ */
/* Address bar button                                                  */
/* ------------------------------------------------------------------ */

let button = null;

function updateButton(tab) {
  if (!button) {
    button = U.el('button', 'icon-btn small omni-btn pdfa-omni');
    button.id = 'pdf-annotate-btn';
    button.type = 'button';
    button.title = 'Annotate PDF';
    button.setAttribute('aria-label', 'Annotate PDF');
    button.appendChild(icon('pdf'));
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', () => toggle());
    U.$('omnibox').insertBefore(button, U.$('reader-btn'));
  }
  const pdf = isPdf(tab);
  button.classList.toggle('pdf-ready', pdf);
  button.disabled = !pdf;
  button.classList.toggle('active', !!(tab && tab.pdfEl));
}

ctx.pdfAnnotate = { open, close, toggle, isPdf, updateButton };
