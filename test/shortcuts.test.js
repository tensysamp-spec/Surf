const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../main/shortcuts');

// Mod is ⌘ on macOS and Ctrl elsewhere; the expectations below are written per platform
const isMac = process.platform === 'darwin';
const mac = { skip: !isMac && 'macOS key mapping' };
const other = { skip: isMac && 'non-macOS key mapping' };

// A DOM KeyboardEvent-shaped object and an Electron before-input-event-shaped one
const dom = (code, key, mods = {}) => ({ code, key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
const input = (code, key, mods = {}) => ({ code, key, meta: false, control: false, alt: false, shift: false, ...mods });

test('table: every action has a label and a valid (or no) default', () => {
  const ids = new Set();
  for (const [id, combo, label] of S.ACTIONS) {
    assert.ok(!ids.has(id), `duplicate action ${id}`);
    ids.add(id);
    assert.ok(label, `${id} has a label`);
    assert.equal(S.problem(combo), null, `${id} default ${combo}`);
  }
});

test('table: no two actions share a default combo', () => {
  const combos = S.ACTIONS.map(([, combo]) => combo).filter(Boolean);
  assert.equal(new Set(combos).size, combos.length);
});

test('comboFromInput: ⌘ letters, modifiers in fixed order (macOS)', mac, () => {
  assert.equal(S.comboFromInput(dom('KeyT', 't', { metaKey: true })), 'Mod+T');
  assert.equal(S.comboFromInput(dom('KeyT', 'T', { metaKey: true, shiftKey: true })), 'Shift+Mod+T');
  assert.equal(S.comboFromInput(dom('KeyK', 'k', { metaKey: true, shiftKey: true, altKey: true, ctrlKey: true })), 'Ctrl+Alt+Shift+Mod+K');
  assert.equal(S.comboFromInput(input('KeyT', 't', { meta: true })), 'Mod+T');
  assert.equal(S.comboFromInput(input('KeyT', 't', { control: true })), 'Ctrl+T');
});

test('comboFromInput: Ctrl is Mod (non-macOS)', other, () => {
  assert.equal(S.comboFromInput(dom('KeyT', 't', { ctrlKey: true })), 'Mod+T');
  assert.equal(S.comboFromInput(input('KeyT', 't', { control: true, shift: true })), 'Shift+Mod+T');
});

test('comboFromInput: letters follow the layout, except with ⌥', () => {
  // AZERTY: the key at KeyQ types "a"
  assert.match(S.comboFromInput(dom('KeyQ', 'a', { metaKey: true, ctrlKey: true })), /\+A$/);
  // ⌥ changes the character (⌥C is "ç"), so use the physical key
  assert.match(S.comboFromInput(dom('KeyC', 'ç', { altKey: true, metaKey: true, ctrlKey: true })), /^.*Alt.*\+C$/);
  // A non-letter character on a letter key falls back to the physical key
  assert.match(S.comboFromInput(dom('KeyQ', 'й', { metaKey: true, ctrlKey: true })), /\+Q$/);
});

test('comboFromInput: digits, F-keys and named keys', mac, () => {
  assert.equal(S.comboFromInput(dom('Digit2', '@', { metaKey: true, shiftKey: true })), 'Shift+Mod+2');
  assert.equal(S.comboFromInput(dom('F5', 'F5')), 'F5');
  assert.equal(S.comboFromInput(dom('F12', 'F12', { altKey: true })), 'Alt+F12');
  assert.equal(S.comboFromInput(dom('Equal', '=', { metaKey: true })), 'Mod+=');
  assert.equal(S.comboFromInput(dom('Minus', '-', { metaKey: true })), 'Mod+-');
  assert.equal(S.comboFromInput(dom('Comma', ',', { metaKey: true })), 'Mod+,');
  assert.equal(S.comboFromInput(dom('BracketLeft', '[', { metaKey: true })), 'Mod+[');
  assert.equal(S.comboFromInput(dom('ArrowUp', 'ArrowUp', { metaKey: true })), 'Mod+Up');
  assert.equal(S.comboFromInput(dom('Tab', 'Tab', { ctrlKey: true })), 'Ctrl+Tab');
});

test('comboFromInput: modifier-only and unknown keys give null', () => {
  assert.equal(S.comboFromInput(dom('MetaLeft', 'Meta', { metaKey: true })), null);
  assert.equal(S.comboFromInput(dom('ShiftLeft', 'Shift', { shiftKey: true })), null);
  assert.equal(S.comboFromInput(dom('', 'Unidentified')), null);
  assert.equal(S.comboFromInput({}), null);
});

test('problem: reserved combos', () => {
  for (const combo of ['Mod+Q', 'Mod+C', 'Mod+V', 'Mod+Z', 'Shift+Mod+Z', 'Ctrl+Tab', 'Mod+1', 'Mod+9', 'F5']) {
    assert.match(S.problem(combo), /reserved/, combo);
  }
});

test('problem: needs a command key unless it is an F-key', () => {
  assert.ok(S.problem('K'));
  assert.ok(S.problem('Shift+K'));
  assert.ok(S.problem('Alt+Shift+K'));
  assert.equal(S.problem('F6'), null);
  assert.equal(S.problem('Shift+F12'), null);
  assert.equal(S.problem('Mod+K'), null);
  assert.equal(S.problem('Ctrl+K'), null);
  assert.equal(S.problem(null), null);
  assert.equal(S.problem(undefined), null);
});

test('problem: messages per platform', mac, () => {
  assert.equal(S.problem('K'), 'needs ⌘ or ⌃');
});

test('effective: defaults without overrides', () => {
  assert.deepEqual(S.effective(), S.DEFAULTS);
  assert.deepEqual(S.effective(null), S.DEFAULTS);
  assert.notEqual(S.effective(), S.DEFAULTS, 'returns a copy');
});

test('effective: valid overrides apply, invalid ones are ignored', () => {
  const out = S.effective({
    'new-tab': 'Alt+Mod+T', // valid
    reload: null, // cleared
    find: 'Mod+Q', // reserved
    history: 'K', // no command key
    back: 42, // not a string
    'no-such-action': 'Mod+K', // unknown
  });
  assert.equal(out['new-tab'], 'Alt+Mod+T');
  assert.equal(out.reload, null);
  assert.equal(out.find, S.DEFAULTS.find);
  assert.equal(out.history, S.DEFAULTS.history);
  assert.equal(out.back, S.DEFAULTS.back);
  assert.ok(!('no-such-action' in out));
});

test('actionFor: defaults and overrides', () => {
  assert.equal(S.actionFor('Mod+T'), 'new-tab');
  assert.equal(S.actionFor('Mod+,'), 'settings');
  assert.equal(S.actionFor('Mod+K'), null);
  // Moving new-tab frees Mod+T and claims the new combo
  const moved = { 'new-tab': 'Alt+Mod+T' };
  assert.equal(S.actionFor('Alt+Mod+T', moved), 'new-tab');
  assert.equal(S.actionFor('Mod+T', moved), null);
  // Clearing a shortcut
  assert.equal(S.actionFor('Mod+R', { reload: null }), null);
  // Taking another action's default: the first matching action in table order wins
  assert.equal(S.actionFor('Mod+R', { 'new-tab': 'Mod+R' }), 'new-tab');
  // An invalid override is ignored, so the default still works
  assert.equal(S.actionFor('Mod+F', { find: 'Mod+Q' }), 'find');
  assert.equal(S.actionFor('Mod+Q', { find: 'Mod+Q' }), null);
});

test('actionFor: ⇧⌘= is zoom-in unless something else claims it', () => {
  assert.equal(S.actionFor('Shift+Mod+='), 'zoom-in');
  assert.equal(S.actionFor('Shift+Mod+=', { reader: 'Shift+Mod+=' }), 'reader');
  // Zoom in moved elsewhere: the alias still works while it's free
  assert.equal(S.actionFor('Shift+Mod+=', { 'zoom-in': 'Alt+Mod+=' }), 'zoom-in');
});

test('display: macOS symbols', mac, () => {
  assert.equal(S.display('Shift+Mod+T'), '⇧⌘T');
  assert.equal(S.display('Ctrl+Alt+Shift+Mod+K'), '⌃⌥⇧⌘K');
  assert.equal(S.display('Mod+='), '⌘+');
  assert.equal(S.display('Mod+-'), '⌘−');
  assert.equal(S.display('Alt+Mod+Up'), '⌥⌘↑');
  assert.equal(S.display('Mod+Enter'), '⌘↩');
  assert.equal(S.display('F5'), 'F5');
});

test('display: names elsewhere', other, () => {
  assert.equal(S.display('Shift+Mod+T'), 'Ctrl+Shift+T');
  assert.equal(S.display('Alt+Mod+Up'), 'Ctrl+Alt+↑');
  assert.equal(S.display('Mod+='), 'Ctrl+=');
});

test('display: nothing for no shortcut', () => {
  assert.equal(S.display(null), '');
  assert.equal(S.display(''), '');
});

test('toAccelerator: Electron menu accelerators', () => {
  assert.equal(S.toAccelerator('Shift+Mod+T'), 'Shift+CmdOrCtrl+T');
  assert.equal(S.toAccelerator('Ctrl+Alt+Mod+K'), 'Control+Alt+CmdOrCtrl+K');
  assert.equal(S.toAccelerator('F5'), 'F5');
  assert.equal(S.toAccelerator(null), undefined);
});

test('round trip: a pressed key matches the action it is bound to', mac, () => {
  const combo = S.comboFromInput(input('KeyT', 'T', { meta: true, shift: true }));
  assert.equal(S.actionFor(combo), 'reopen-closed');
  const custom = { 'tab-search': 'Ctrl+Mod+K' };
  assert.equal(S.actionFor(S.comboFromInput(input('KeyK', 'k', { meta: true, control: true })), custom), 'tab-search');
});
