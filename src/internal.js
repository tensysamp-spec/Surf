// Internal pages that live in the sidebar like tabs: Notes and Easels.
// They render as plain DOM views (no <webview>), stored in localStorage.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const NOTES_KEY = 'browser.notes';
const EASELS_KEY = 'browser.easels';
let notes = U.store.get(NOTES_KEY, {});
let easels = U.store.get(EASELS_KEY, {});
let lastEaselId = U.store.get('browser.lastEasel', null);

const saveNotes = () => U.store.set(NOTES_KEY, notes);
const saveEasels = () => U.store.set(EASELS_KEY, easels);

// The last keystrokes in a note are saved after a short pause; don't lose them when the
// window closes during that pause
let pendingNoteSave = null;
window.addEventListener('beforeunload', () => pendingNoteSave && pendingNoteSave());

function allDocs() {
  return [
    ...Object.values(notes).map((n) => ({ kind: 'note', id: n.id, title: n.title, updated: n.updated })),
    ...Object.values(easels).map((e) => ({ kind: 'easel', id: e.id, title: e.title, updated: e.updated })),
  ].sort((a, b) => b.updated - a.updated);
}

// Keep the sidebar title in sync with the document title
function syncEntryTitle(kind, id, title) {
  for (const tab of ctx.tabs.live.values()) {
    const entry = ctx.tabs.findEntry(tab.entryId);
    if (entry && entry.kind === kind && entry.refId === id) {
      entry.title = title || (kind === 'note' ? 'Untitled note' : 'Untitled easel');
      tab.title = entry.title;
      ctx.sidebar.updateEntry(entry.id);
      if (ctx.tabs.activeEntryId === entry.id) ctx.nav.update();
      ctx.tabs.save();
    }
  }
}

function openDoc(kind, id) {
  // Already open? Switch to it
  for (const space of ctx.tabs.spaces) {
    for (const entry of ctx.tabs.entriesIn([...space.pinned, ...space.today])) {
      if (entry.kind === kind && entry.refId === id) {
        ctx.tabs.showEntry(entry.id);
        return;
      }
    }
  }
  const doc = kind === 'note' ? notes[id] : easels[id];
  if (!doc) return;
  ctx.tabs.openTab(`${kind}://${id}`, { kind, refId: id, title: doc.title || `Untitled ${kind}` });
}

function newNote() {
  const id = U.uid();
  notes[id] = { id, title: '', html: '', updated: Date.now() };
  saveNotes();
  ctx.tabs.openTab(`note://${id}`, { kind: 'note', refId: id, title: 'Untitled note' });
}

function newEasel() {
  const id = U.uid();
  easels[id] = { id, title: '', items: [], updated: Date.now() };
  lastEaselId = id;
  U.store.set('browser.lastEasel', id);
  saveEasels();
  ctx.tabs.openTab(`easel://${id}`, { kind: 'easel', refId: id, title: 'Untitled easel' });
  return id;
}

async function deleteDoc(kind, id) {
  const doc = kind === 'note' ? notes[id] : easels[id];
  const ok = await U.dialog({ title: `Delete “${(doc && doc.title) || `Untitled ${kind}`}”?`, message: 'This can’t be undone.', confirmLabel: 'Delete', danger: true, input: false });
  if (!ok) return false;
  // Close any open tab showing it
  for (const space of ctx.tabs.spaces) {
    for (const entry of ctx.tabs.entriesIn([...space.pinned, ...space.today])) {
      if (entry.kind === kind && entry.refId === id) ctx.tabs.closeEntry(entry.id);
    }
  }
  if (kind === 'note') {
    delete notes[id];
    saveNotes();
  } else {
    delete easels[id];
    saveEasels();
  }
  return true;
}

function createView(entry) {
  if (entry.kind === 'offline') return ctx.reader.offlineView(entry);
  if (entry.kind === 'note') return noteView(entry.refId);
  return easelView(entry.refId);
}

/* ------------------------------------------------------------------ */
/* Notes                                                               */
/* ------------------------------------------------------------------ */

const FORMAT_BUTTONS = [
  ['B', 'bold', 'Bold (⌘B)'],
  ['I', 'italic', 'Italic (⌘I)'],
  ['U', 'underline', 'Underline (⌘U)'],
  ['S', 'strikeThrough', 'Strikethrough'],
  ['H1', 'h1', 'Heading'],
  ['H2', 'h2', 'Subheading'],
  ['•', 'insertUnorderedList', 'Bulleted list'],
  ['1.', 'insertOrderedList', 'Numbered list'],
  ['❝', 'blockquote', 'Quote'],
];

function noteView(id) {
  const view = U.el('div', 'internal-view note-view');
  const note = notes[id];
  if (!note) {
    view.appendChild(U.el('div', 'history-empty', 'This note was deleted.'));
    return view;
  }

  const page = U.el('div', 'note-page');
  const title = U.el('input', 'note-title');
  title.placeholder = 'Untitled';
  title.value = note.title;
  title.spellcheck = false;

  const toolbar = U.el('div', 'note-toolbar');
  const body = U.el('div', 'note-body');
  body.contentEditable = 'true';
  body.dataset.placeholder = 'Start writing…';
  body.innerHTML = U.sanitizeHtml(note.html);

  for (const [label, command, tip] of FORMAT_BUTTONS) {
    const b = U.el('button', 'fmt-btn', label);
    b.title = tip;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      body.focus();
      if (['h1', 'h2', 'blockquote'].includes(command)) {
        const current = document.queryCommandValue('formatBlock').toLowerCase();
        document.execCommand('formatBlock', false, current === command ? 'p' : command);
      } else {
        document.execCommand(command);
      }
      persist();
    });
    toolbar.appendChild(b);
  }
  const meta = U.el('span', 'note-meta');
  toolbar.appendChild(meta);

  let timer = null;
  const write = () => {
    clearTimeout(timer);
    if (pendingNoteSave === write) pendingNoteSave = null;
    note.title = title.value.trim();
    note.html = U.sanitizeHtml(body.innerHTML);
    note.updated = Date.now();
    saveNotes();
    meta.textContent = 'Saved';
  };
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(write, 300);
    pendingNoteSave = write;
    meta.textContent = 'Editing…';
  };

  title.addEventListener('input', () => {
    persist();
    syncEntryTitle('note', id, title.value.trim());
  });
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      body.focus();
    }
  });
  body.addEventListener('input', persist);
  // Paste as plain text: keeps notes clean and keeps foreign markup out
  body.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  page.append(title, toolbar, body);
  view.appendChild(page);
  requestAnimationFrame(() => (note.title ? body : title).focus());
  return view;
}

/* ------------------------------------------------------------------ */
/* Easels                                                              */
/* ------------------------------------------------------------------ */

function easelView(id) {
  const view = U.el('div', 'internal-view easel-view');
  const easel = easels[id];
  if (!easel) {
    view.appendChild(U.el('div', 'history-empty', 'This easel was deleted.'));
    return view;
  }
  lastEaselId = id;
  U.store.set('browser.lastEasel', id);

  const bar = U.el('div', 'easel-bar');
  const title = U.el('input', 'easel-title');
  title.placeholder = 'Untitled easel';
  title.value = easel.title;
  title.spellcheck = false;
  title.addEventListener('input', () => {
    easel.title = title.value.trim();
    easel.updated = Date.now();
    saveEasels();
    syncEntryTitle('easel', id, easel.title);
  });

  const board = U.el('div', 'easel-board');
  const canvas = U.el('div', 'easel-canvas');
  board.appendChild(canvas);

  const addText = U.el('button', 'chip');
  addText.append(U.icon('type'), document.createTextNode(' Text'));
  addText.addEventListener('click', () => {
    const item = { id: U.uid(), type: 'text', text: '', x: board.scrollLeft + 80, y: board.scrollTop + 80, w: 260, h: 120 };
    easel.items.push(item);
    persist();
    const node = renderItem(item);
    node.querySelector('.easel-text').focus();
  });
  const capture = U.el('button', 'chip');
  capture.append(U.icon('crop'), document.createTextNode(' Capture from tab'));
  capture.title = 'Select an area of a web page to add (⇧⌘2)';
  capture.addEventListener('click', () => {
    lastEaselId = id;
    U.store.set('browser.lastEasel', id);
    startCapture({ fromEasel: true });
  });
  bar.append(title, addText, capture);

  const persist = () => {
    easel.updated = Date.now();
    saveEasels();
  };

  function renderItem(item) {
    const node = U.el('div', `easel-item easel-${item.type}`);
    node.style.left = `${item.x}px`;
    node.style.top = `${item.y}px`;
    node.style.width = `${item.w}px`;
    if (item.type !== 'image') node.style.height = `${item.h}px`;

    if (item.type === 'image') {
      const img = U.el('img');
      img.src = item.src;
      img.draggable = false;
      node.appendChild(img);
      if (item.sourceUrl) {
        const source = U.el('a', 'easel-source', U.compactUrl(item.sourceUrl));
        source.title = `Open ${item.sourceUrl}`;
        source.addEventListener('click', (e) => {
          e.preventDefault();
          ctx.tabs.openTab(item.sourceUrl);
        });
        node.appendChild(source);
      }
    } else {
      const text = U.el('div', 'easel-text');
      text.contentEditable = 'true';
      text.textContent = item.text;
      text.dataset.placeholder = 'Type something…';
      text.addEventListener('input', () => {
        item.text = text.innerText;
        persist();
      });
      text.addEventListener('paste', (e) => {
        e.preventDefault();
        document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
      });
      node.appendChild(text);
    }

    const del = U.iconButton('close', 'Remove', () => {
      easel.items = easel.items.filter((x) => x !== item);
      persist();
      node.remove();
      updateEmpty();
    }, 'easel-delete');
    const handle = U.el('div', 'easel-resize');
    node.append(del, handle);

    // Drag to move (anywhere except editable text), corner to resize
    node.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.easel-delete, a') || (e.target.isContentEditable && document.activeElement === e.target)) return;
      const resizing = e.target === handle;
      if (!resizing && e.target.isContentEditable) return;
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, ix: item.x, iy: item.y, w: item.w, h: node.offsetHeight };
      canvas.appendChild(node); // bring to front
      const move = (ev) => {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (resizing) {
          item.w = Math.max(120, start.w + dx);
          node.style.width = `${item.w}px`;
          if (item.type !== 'image') {
            item.h = Math.max(60, start.h + dy);
            node.style.height = `${item.h}px`;
          }
        } else {
          item.x = Math.max(0, start.ix + dx);
          item.y = Math.max(0, start.iy + dy);
          node.style.left = `${item.x}px`;
          node.style.top = `${item.y}px`;
        }
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        easel.items = [...easel.items.filter((x) => x !== item), item];
        persist();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    canvas.appendChild(node);
    updateEmpty();
    return node;
  }

  const emptyHint = U.el('div', 'easel-empty');
  emptyHint.append(U.icon('easel'), U.el('p', null, 'Capture parts of web pages with ⇧⌘2, or add text. Drag things around to arrange them.'));
  const updateEmpty = () => { emptyHint.hidden = easel.items.length > 0; };

  easel.items.forEach(renderItem);
  view.append(bar, board, emptyHint);
  updateEmpty();
  view.addItem = renderItem; // used by capture to add live
  view.easelId = id;
  return view;
}

/* ------------------------------------------------------------------ */
/* Capture an area of a web page                                       */
/* ------------------------------------------------------------------ */

let capturing = false;

function lastWebTab() {
  const active = ctx.tabs.activeTab();
  if (active && active.kind === 'web' && !U.isNewTabUrl(active.url)) return active;
  // From an easel: use the most recently active web tab in this space
  const entries = ctx.tabs.orderedEntries()
    .filter((e) => e.kind === 'web' && ctx.tabs.live.has(e.id) && !U.isNewTabUrl(ctx.tabs.live.get(e.id).url))
    .sort((a, b) => b.lastActive - a.lastActive);
  return entries.length ? ctx.tabs.live.get(entries[0].id) : null;
}

// onImage: handle the captured image yourself (screenshots); default adds it to an easel
function startCapture({ fromEasel = false, onImage = null } = {}) {
  if (capturing) return;
  const tab = lastWebTab();
  if (!tab) {
    U.toast('Open a web page to capture from');
    return;
  }
  const returnTo = fromEasel ? ctx.tabs.activeEntryId : null;
  if (ctx.tabs.activeEntryId !== tab.entryId) ctx.tabs.showEntry(tab.entryId, { focus: false });
  capturing = true;

  const rect = tab.view.getBoundingClientRect();
  const overlay = U.el('div', 'capture-overlay');
  Object.assign(overlay.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  const hint = U.el('div', 'capture-hint', 'Drag to select an area · Esc to cancel');
  const selection = U.el('div', 'capture-selection');
  selection.hidden = true;
  overlay.append(hint, selection);
  document.body.appendChild(overlay);

  const finish = () => {
    capturing = false;
    overlay.remove();
    release();
  };
  const release = U.pushEscape(() => {
    finish();
    if (returnTo) ctx.tabs.showEntry(returnTo);
  });

  let start = null;
  overlay.addEventListener('mousedown', (e) => {
    start = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    selection.hidden = false;
    hint.hidden = true;
  });
  overlay.addEventListener('mousemove', (e) => {
    if (!start) return;
    const x = Math.min(start.x, e.clientX - rect.left);
    const y = Math.min(start.y, e.clientY - rect.top);
    const w = Math.abs(e.clientX - rect.left - start.x);
    const h = Math.abs(e.clientY - rect.top - start.y);
    Object.assign(selection.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  });
  overlay.addEventListener('mouseup', async (e) => {
    if (!start) return;
    const x = Math.round(Math.min(start.x, e.clientX - rect.left));
    const y = Math.round(Math.min(start.y, e.clientY - rect.top));
    const w = Math.round(Math.abs(e.clientX - rect.left - start.x));
    const h = Math.round(Math.abs(e.clientY - rect.top - start.y));
    finish();
    if (w < 12 || h < 12) {
      if (returnTo) ctx.tabs.showEntry(returnTo);
      return;
    }
    try {
      const image = await tab.webview.capturePage({ x, y, width: w, height: h });
      if (onImage) {
        onImage(image, tab);
        return;
      }
      const src = await ipcRenderer.invoke('save-clip', image.toPNG());
      addClip({ src, w, h, sourceUrl: tab.url, sourceTitle: tab.title }, returnTo);
    } catch (err) {
      console.error(err);
      U.toast('Capture failed');
    }
  });
}

function addClip({ src, w, h, sourceUrl }, returnTo) {
  let easelId = lastEaselId && easels[lastEaselId] ? lastEaselId : null;
  if (!easelId) {
    easelId = U.uid();
    easels[easelId] = { id: easelId, title: 'My Easel', items: [], updated: Date.now() };
    lastEaselId = easelId;
    U.store.set('browser.lastEasel', easelId);
  }
  const easel = easels[easelId];
  const width = Math.min(w, 480);
  const offset = (easel.items.length % 8) * 28;
  const item = { id: U.uid(), type: 'image', src, sourceUrl, x: 60 + offset, y: 60 + offset, w: width, h: Math.round((h * width) / w) };
  easel.items.push(item);
  easel.updated = Date.now();
  saveEasels();

  // If the easel is open, add it live
  for (const tab of ctx.tabs.live.values()) {
    if (tab.view.easelId === easelId && tab.view.addItem) tab.view.addItem(item);
  }
  if (returnTo) ctx.tabs.showEntry(returnTo);
  else U.toast(`Added to ${easel.title || 'easel'}`, { action: () => openDoc('easel', easelId), actionLabel: 'Open' });
}

function noteText(id) {
  const note = notes[id];
  if (!note) return '';
  const div = document.createElement('div');
  div.innerHTML = U.sanitizeHtml(note.html);
  return `${note.title}\n\n${div.innerText || div.textContent}`;
}

ctx.internal = { noteText, createView, newNote, newEasel, openDoc, deleteDoc, allDocs, startCapture };
