// Keyboard shortcut table: the built-in defaults (action → combo), which the user can
// override per action in Settings. Plain data + helpers with no Electron imports, so both
// main.js (matching keys) and the window (Settings, hints) can require it.
//
// A combo is written "Ctrl+Alt+Shift+Mod+K" (always in that order). Mod is ⌘ on macOS and
// Ctrl elsewhere; Ctrl on its own only exists on macOS. null means "no shortcut".

const isMac = process.platform === 'darwin';

const ACTIONS = [
  ['new-tab', 'Mod+T', 'New tab / command bar'],
  ['focus-url', 'Mod+L', 'Edit address'],
  ['close-tab', 'Mod+W', 'Close tab'],
  ['reopen-closed', 'Shift+Mod+T', 'Reopen closed tab'],
  ['reload', 'Mod+R', 'Reload'],
  ['back', 'Mod+[', 'Back'],
  ['forward', 'Mod+]', 'Forward'],
  ['toggle-pin', 'Mod+D', 'Pin / unpin tab'],
  ['split-view', 'Shift+Mod+D', 'Split view'],
  ['toggle-sidebar', 'Mod+S', 'Toggle sidebar'],
  ['compact', 'Alt+Mod+C', 'Compact mode'],
  ['copy-url', 'Shift+Mod+C', 'Copy URL'],
  ['tab-search', 'Shift+Mod+A', 'Search all tabs'],
  ['reading-list', 'Shift+Mod+L', 'Add to reading list'],
  ['find', 'Mod+F', 'Find in page'],
  ['find-next', 'Mod+G', 'Find next'],
  ['find-prev', 'Shift+Mod+G', 'Find previous'],
  ['zoom-in', 'Mod+=', 'Zoom in'],
  ['zoom-out', 'Mod+-', 'Zoom out'],
  ['zoom-reset', 'Mod+0', 'Actual size'],
  ['reader', 'Shift+Mod+R', 'Reader view'],
  ['capture', 'Shift+Mod+2', 'Capture to easel'],
  ['screenshot', 'Shift+Mod+S', 'Screenshot'],
  ['bookmark-page', null, 'Bookmark this page'],
  ['bookmarks', 'Alt+Mod+B', 'Bookmarks'],
  ['history', 'Mod+Y', 'History'],
  ['downloads', 'Shift+Mod+J', 'Downloads'],
  ['little-window', 'Alt+Mod+N', 'Little window'],
  ['private-window', 'Shift+Mod+N', 'Private window'],
  ['reopen-window', 'Alt+Shift+Mod+T', 'Reopen closed window'],
  ['devtools', 'Alt+Mod+I', 'Page DevTools'],
  ['settings', 'Mod+,', 'Settings'],
];

const DEFAULTS = Object.fromEntries(ACTIONS.map(([id, combo]) => [id, combo]));
const LABELS = Object.fromEntries(ACTIONS.map(([id, , label]) => [id, label]));

// Extra built-in keys that only apply while nothing else claims them (⇧⌘= is ⌘+ on US keyboards)
const ALIASES = { 'Shift+Mod+=': 'zoom-in' };

// Combos that can never be assigned: the system and edit menu, and the fixed shortcuts below
const RESERVED = new Set([
  'Mod+Q', 'Mod+H', 'Alt+Mod+H', 'Mod+M', 'Mod+`',
  'Mod+C', 'Mod+V', 'Mod+X', 'Mod+A', 'Mod+Z', 'Shift+Mod+Z',
  'Ctrl+Tab', 'Shift+Ctrl+Tab', 'Mod+Tab', 'Shift+Mod+Tab', 'F5',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`Mod+${n}`, isMac ? `Ctrl+${n}` : `Alt+${n}`]),
]);

const CODE_KEYS = {
  Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`', IntlBackslash: '§',
  Tab: 'Tab', Enter: 'Enter', Space: 'Space', Backspace: 'Backspace', Delete: 'Delete',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
};

// Works for Electron's before-input-event input and for a DOM KeyboardEvent
function comboFromInput(e) {
  const meta = e.meta ?? e.metaKey;
  const control = e.control ?? e.ctrlKey;
  const alt = e.alt ?? e.altKey;
  const shift = e.shift ?? e.shiftKey;
  const code = e.code || '';
  let key = null;
  const letter = code.match(/^Key([A-Z])$/);
  // Letters follow the keyboard layout (like before), except with ⌥, which changes the character
  if (letter) key = !alt && /^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : letter[1];
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else key = CODE_KEYS[code] || null;
  if (!key) return null;
  const parts = [];
  if (isMac && control) parts.push('Ctrl');
  if (alt) parts.push('Alt');
  if (shift) parts.push('Shift');
  if (isMac ? meta : control) parts.push('Mod');
  parts.push(key);
  return parts.join('+');
}

// Why a combo can't be used, or null if it's fine
function problem(combo) {
  if (combo == null) return null;
  if (RESERVED.has(combo)) return 'is reserved by the system or Surf';
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  const hasMod = parts.includes('Mod') || parts.includes('Ctrl');
  if (!hasMod && !/^F\d{1,2}$/.test(key)) return isMac ? 'needs ⌘ or ⌃' : 'needs Ctrl';
  return null;
}

// Defaults with the user's (valid) overrides applied
function effective(overrides = {}) {
  const out = { ...DEFAULTS };
  for (const [id, combo] of Object.entries(overrides || {})) {
    if (id in DEFAULTS && (combo === null || (typeof combo === 'string' && !problem(combo)))) out[id] = combo;
  }
  return out;
}

function actionFor(combo, overrides) {
  const bindings = effective(overrides);
  const hit = Object.keys(bindings).find((id) => bindings[id] === combo);
  if (hit) return hit;
  const alias = ALIASES[combo];
  return alias && !Object.values(bindings).includes(combo) ? alias : null;
}

const MAC_SYMBOLS = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
const KEY_SYMBOLS = { '=': '+', '-': '−', Up: '↑', Down: '↓', Left: '←', Right: '→', Enter: '↩', Backspace: '⌫', Delete: '⌦', Tab: '⇥', Space: 'Space' };

// "Shift+Mod+T" → "⇧⌘T" on macOS, "Ctrl+Shift+T" elsewhere
function display(combo) {
  if (!combo) return '';
  const parts = combo.split('+');
  // A literal "+" key never occurs (it's "="), so splitting on + is safe
  const key = parts.pop();
  if (isMac) return parts.map((p) => MAC_SYMBOLS[p]).join('') + (KEY_SYMBOLS[key] || key);
  const names = { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
  const order = ['Mod', 'Alt', 'Shift'].filter((p) => parts.includes(p)).map((p) => names[p]);
  return [...order, KEY_SYMBOLS[key] && key !== '=' && key !== '-' ? KEY_SYMBOLS[key] : key].join('+');
}

// For menu items, so the shortcut shown in the menu is the one that works
function toAccelerator(combo) {
  if (!combo) return undefined;
  return combo.split('+').map((p) => ({ Mod: 'CmdOrCtrl', Ctrl: 'Control' }[p] || p)).join('+');
}

module.exports = { ACTIONS, DEFAULTS, LABELS, comboFromInput, problem, effective, actionFor, display, toAccelerator };
