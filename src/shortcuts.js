// Keyboard shortcuts in the window: current bindings for hints and the help list, and the
// Settings editor (record a new combo, reset, swap on conflict). The table itself lives in
// main/shortcuts.js; overrides are kept by the main process, which matches the keys.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');
const K = require('../main/shortcuts');

let overrides = {};
const listeners = new Set();
// Labels shown around the window (tooltips, the tour) redraw when the bindings change
function changed() {
  for (const fn of listeners) {
    try { fn(); } catch (err) { console.error(err); }
  }
}
ipcRenderer.invoke('shortcuts-get').then((o) => { overrides = o || {}; changed(); }).catch(() => {});
ipcRenderer.on('shortcuts-changed', (_e, o) => { overrides = o || {}; changed(); });

const bindings = () => K.effective(overrides);
// "⇧⌘T" for an action ('' when it has no shortcut)
const label = (action) => K.display(bindings()[action]);
// "Reload (⌘R)", or just "Reload" when the action has no shortcut
const tip = (text, action) => {
  const keys = label(action);
  return keys ? `${text} (${keys})` : text;
};

// Call fn whenever the user's shortcuts change; returns an unsubscribe function
function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function save(next) {
  overrides = await ipcRenderer.invoke('shortcuts-set', next);
}

// Set one action's combo; returns false (with a toast offering to swap) on a conflict
async function assign(action, combo) {
  const current = bindings();
  const taken = combo && Object.keys(current).find((id) => id !== action && current[id] === combo);
  if (taken) {
    U.toast(`${K.display(combo)} is already used by “${K.LABELS[taken]}”`, {
      actionLabel: 'Swap',
      action: async () => {
        await save({ ...overrides, [action]: combo, [taken]: current[action] });
        if (rerender) rerender();
      },
      duration: 7000,
    });
    return false;
  }
  const next = { ...overrides, [action]: combo };
  if (combo === K.DEFAULTS[action]) delete next[action];
  await save(next);
  return true;
}

/* ------------------------------------------------------------------ */
/* Recording a new combo                                               */
/* ------------------------------------------------------------------ */

let stopRecording = null;
let rerender = null;

// Listens on the window showing the row (the Settings window) while main lets every key
// through; Esc cancels, ⌫ clears
function record(kbd, onDone) {
  if (stopRecording) stopRecording();
  const view = kbd.ownerDocument.defaultView;
  const before = kbd.textContent;
  kbd.textContent = 'Type a shortcut…';
  kbd.classList.add('recording');
  ipcRenderer.send('shortcut-recording', true);

  const onKey = (e) => {
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return finish(undefined);
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return finish(null);
    const combo = K.comboFromInput(e);
    const problem = combo ? K.problem(combo) : 'isn’t a key Surf can use';
    if (problem) {
      U.toast(`${combo ? K.display(combo) : 'That key'} ${problem}`);
      return;
    }
    finish(combo);
  };
  const finish = (combo) => {
    view.removeEventListener('keydown', onKey, true);
    view.removeEventListener('blur', cancel);
    ipcRenderer.send('shortcut-recording', false);
    kbd.classList.remove('recording');
    kbd.textContent = before;
    stopRecording = null;
    if (combo !== undefined) onDone(combo);
  };
  const cancel = () => finish(undefined);
  view.addEventListener('keydown', onKey, true);
  view.addEventListener('blur', cancel);
  stopRecording = cancel;
}

/* ------------------------------------------------------------------ */
/* Settings section                                                    */
/* ------------------------------------------------------------------ */

function renderSettings(container) {
  const list = U.el('div', 'ext-list shortcut-list');
  const paint = () => {
    list.replaceChildren();
    const current = bindings();
    for (const [action] of K.ACTIONS) {
      const row = U.el('div', 'ext-row shortcut-row');
      const kbd = U.el('kbd', 'shortcut-kbd' + (current[action] ? '' : ' none'), K.display(current[action]) || 'None');
      const change = U.el('button', 'btn small', 'Change');
      change.addEventListener('click', () => record(kbd, async (combo) => {
        await assign(action, combo);
        paint();
      }));
      const reset = U.iconButton('undo', 'Reset to default', async () => {
        const next = { ...overrides };
        delete next[action];
        const fallback = K.DEFAULTS[action];
        const clash = fallback && Object.keys(current).find((id) => id !== action && current[id] === fallback);
        // Resetting would collide with another action that took this default: unbind that one
        if (clash) next[clash] = null;
        await save(next);
        if (clash) U.toast(`“${K.LABELS[clash]}” no longer has a shortcut`);
        paint();
      }, 'h-delete');
      reset.classList.toggle('unchanged', !(action in overrides));
      row.append(U.el('span', 'ext-text', K.LABELS[action]), kbd, change, reset);
      list.appendChild(row);
    }
  };
  rerender = () => { if (list.isConnected) paint(); };
  paint();

  const resetAll = U.el('button', 'btn', 'Reset all');
  resetAll.addEventListener('click', async () => {
    if (!Object.keys(overrides).length) return U.toast('All shortcuts are already the defaults');
    const ok = await U.dialog({ title: 'Reset all shortcuts?', message: 'Every shortcut goes back to Surf’s default.', confirmLabel: 'Reset', input: false });
    if (!ok) return;
    await save({});
    paint();
  });
  container.append(list, resetAll, U.el('p', 'settings-hint', 'Click Change, then press the new keys. Esc cancels, ⌫ removes the shortcut. ⌘Q, copy/paste and the fixed shortcuts below can’t be changed.'));
}

function close() {
  if (stopRecording) stopRecording();
  rerender = null;
}

/* ------------------------------------------------------------------ */
/* Tooltips in index.html that name a shortcut                         */
/* ------------------------------------------------------------------ */

// [element id, tooltip text, action, text after the shortcut]
const TOOLTIPS = [
  ['sidebar-toggle-btn', 'Toggle sidebar', 'toggle-sidebar'],
  ['back-btn', 'Back', 'back'],
  ['forward-btn', 'Forward', 'forward'],
  ['reload-btn', 'Reload', 'reload'],
  ['reader-btn', 'Reader view', 'reader'],
  ['new-tab-btn', 'New tab', 'new-tab', ' — right-click for more'],
  ['settings-btn', 'Settings', 'settings'],
  ['find-prev', 'Previous', 'find-prev'],
  ['find-next', 'Next', 'find-next'],
];

function applyTooltips() {
  for (const [id, text, action, after = ''] of TOOLTIPS) {
    const node = document.getElementById(id);
    // While a page loads the reload button is a stop button (nav.js titles it then)
    if (!node || (id === 'reload-btn' && node.classList.contains('loading'))) continue;
    node.title = tip(text, action) + after;
  }
  const badge = document.querySelector('#tabsearch-bar .ts-shortcut');
  if (badge) {
    badge.textContent = label('tab-search');
    badge.style.display = badge.textContent ? '' : 'none';
  }
}
applyTooltips();
onChange(applyTooltips);

ctx.shortcuts = { label, tip, bindings, onChange, renderSettings, close };
