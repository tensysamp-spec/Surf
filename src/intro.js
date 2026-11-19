// Intro: a guided tour that spotlights each part of the window. Runs once on
// first launch and can be replayed from Settings or the command bar.
//
// Adding a step: push an object onto STEPS.
//   id        stable name (handy for tests and for inserting steps relative to others)
//   target    CSS selector, or a list of selectors tried in order. The first one with a
//             visible match wins; every visible match of it is spotlit together.
//             Leave it out for a centered card. Steps whose targets are all missing or
//             hidden are skipped, so a step for an optional feature is always safe.
//   place     preferred side for the card: 'right' (default), 'left', 'top' or 'bottom'
//   title     short heading
//   text      one or two sentences; {⌘T} renders as keyboard keys
//   tips      [[keys, label], …] rendered as a shortcut grid
//   tryIt     { label, run(), isOpen() } — a button that opens the real UI. The tour steps
//             aside while it's open and comes back when it closes. Never change user data.
//   when()    optional extra condition for showing the step

const ctx = require('./ctx');
const U = require('./util');

const SEEN_KEY = 'browser.introSeen';
const MAC = process.platform === 'darwin';

const STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to Surf',
    text: 'A one-minute tour of the essentials. Use {←} {→} to move between steps, or {Esc} to skip at any time.',
    next: 'Show me around',
  },
  {
    id: 'tabs',
    target: ['#today-zone', '#sidebar'],
    title: 'Your tabs live in the sidebar',
    text: 'New tabs land under Today and quietly archive themselves once you stop using them. Show or hide the sidebar with {⌘S}.',
  },
  {
    id: 'command',
    target: '#new-tab-btn',
    title: 'One box for everything',
    text: '{⌘T} opens the command bar: search, type an address, or run any command — try “split” or “summarize”.',
    tryIt: { label: 'Open the command bar', run: () => ctx.command.open(), isOpen: () => ctx.command.isOpen() },
  },
  {
    id: 'pinned',
    // With nothing pinned yet, point at the current tab instead: that's what ⌘D would pin
    target: ['#sidebar.has-pinned #pinned-list', '#today-list .entry-row.active', '#today-list .entry-row'],
    title: 'Pin the sites you live in',
    text: 'Press {⌘D} to pin a tab. Pinned tabs become square tiles that glow in the site’s color — wander off and the ↩ badge takes you back home.',
  },
  {
    id: 'spaces',
    target: ['.spaces-pill', '#spaces-bar'],
    place: 'top',
    title: 'Spaces keep your worlds apart',
    text: 'Work, personal, side projects — each space has its own tabs and color. Switch with {⌃1–9} or swipe two fingers across the sidebar.',
    tryIt: {
      label: 'Pick a color',
      // Clicking the active space opens its menu, color picker included
      run: () => document.querySelector('.space-dot.active').click(),
      isOpen: () => !!document.querySelector('.ctx-menu.has-picker'),
      when: () => !!document.querySelector('.space-dot.active'),
    },
  },
  {
    id: 'move',
    title: 'Get around quickly',
    text: 'Three moves worth learning early:',
    tips: [
      ['⌃Tab', 'Flip through tabs as thumbnails (hold ⌃)'],
      ['⇧-click', 'Peek at a link without leaving the page'],
      ['⇧⌘D', 'Split view — two pages side by side'],
    ],
  },
  {
    id: 'boosts',
    target: ['#boost-btn', '#omnibox'],
    place: 'bottom',
    title: 'Make any site yours',
    text: 'Boosts restyle a site with your own colors, fonts or CSS, and zap the bits you don’t want. The wand sits in the address bar — jump there with {⌘L}.',
  },
  {
    id: 'shields',
    target: '#shields-btn',
    place: 'bottom',
    title: 'Shields block trackers',
    text: 'Ads and trackers are blocked automatically; the count shows how many on this page. Click the shield to turn it off for a site.',
    tryIt: {
      label: 'See your privacy report',
      run: () => ctx.privacy.openReport(),
      isOpen: () => !!document.querySelector('.modal-backdrop'),
    },
  },
  {
    id: 'shelf-library',
    target: '#shelf-btn, #library-btn',
    place: 'top',
    title: 'Shelf and Library',
    text: 'The shelf collects downloads, screenshots and anything you drop on it. The Library keeps history, archived tabs, notes and highlights — open it with {⌘Y}.',
    tryIt: { label: 'Open the Library', run: () => ctx.library.open('history'), isOpen: () => ctx.library.isOpen() },
  },
  {
    id: 'assistant',
    target: '#assistant-btn',
    place: 'top',
    title: 'An assistant, if you want one',
    text: 'Summarize a page, ask about it, or translate it. It’s optional: add your Anthropic API key in Settings {⌘,} to turn it on.',
  },
  {
    id: 'done',
    title: 'You’re set',
    text: 'A few more things to try:',
    tips: [
      ['yt Tab', 'Search a site straight from the address bar'],
      ['⇧⌘R', 'Reader view for clean articles'],
      ['⇧⌘T', 'Bring back a tab you just closed'],
      ['⌥⌘C', 'Compact mode — just the page'],
    ],
    note: 'Replay this tour anytime from Settings → Welcome tour, or pick “Replay intro tour” in the command bar.',
    next: 'Start browsing',
  },
];

let state = null;

function isOpen() {
  return !!state;
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */

function isVisible(node) {
  if (!node || node.closest('[hidden]')) return false;
  const r = node.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return false;
  const style = getComputedStyle(node);
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
}

// The elements to spotlight for a step: [] for centered cards and missing targets
function targetsFor(step) {
  const selectors = [].concat(step.target || []);
  for (const sel of selectors) {
    let nodes = [];
    try {
      nodes = [...document.querySelectorAll(sel)].filter(isVisible);
    } catch {
      // A bad selector skips the step rather than breaking the tour
    }
    if (nodes.length) return nodes;
  }
  return [];
}

function available(step) {
  if (step.when && !step.when()) return false;
  return !step.target || targetsFor(step).length > 0;
}

// Union of the targets' rectangles, padded and kept inside the window
function holeRect(nodes) {
  const pad = 6;
  const rects = nodes.map((n) => n.getBoundingClientRect());
  return {
    left: Math.max(4, Math.min(...rects.map((r) => r.left)) - pad),
    top: Math.max(4, Math.min(...rects.map((r) => r.top)) - pad),
    right: Math.min(innerWidth - 4, Math.max(...rects.map((r) => r.right)) + pad),
    bottom: Math.min(innerHeight - 4, Math.max(...rects.map((r) => r.bottom)) + pad),
  };
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

// Put the card on the preferred side of the hole, flipping or falling back to
// whichever side has room, then clamp it fully inside the window.
function cardPosition(box, cw, ch, place) {
  const gap = 14;
  const m = 12;
  const W = innerWidth;
  const H = innerHeight;
  const midY = (box.top + box.bottom) / 2 - ch / 2;
  const midX = (box.left + box.right) / 2 - cw / 2;
  const sides = {
    right: { fits: box.right + gap + cw <= W - m, left: box.right + gap, top: midY },
    left: { fits: box.left - gap - cw >= m, left: box.left - gap - cw, top: midY },
    bottom: { fits: box.bottom + gap + ch <= H - m, left: midX, top: box.bottom + gap },
    top: { fits: box.top - gap - ch >= m, left: midX, top: box.top - gap - ch },
  };
  const opposite = { right: 'left', left: 'right', top: 'bottom', bottom: 'top' };
  const order = [place, opposite[place], 'right', 'bottom', 'top', 'left'];
  const side = order.find((s) => sides[s].fits) || 'right';
  const pick = sides[side];
  return {
    side,
    left: Math.round(Math.min(Math.max(m, pick.left), W - cw - m)),
    top: Math.round(Math.min(Math.max(m, pick.top), H - ch - m)),
  };
}

// Measure and place the hole and card. Cheap enough to run every frame:
// it only writes styles when something actually moved.
function layout() {
  if (!state || state.suspended) return;
  const { root, hole, card } = state;
  const step = STEPS[state.index];
  const nodes = targetsFor(step);
  const centered = nodes.length === 0;
  const box = centered ? null : holeRect(nodes);
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const key = centered ? `c:${innerWidth}x${innerHeight}:${ch}` : `${box.left},${box.top},${box.right},${box.bottom}:${cw}x${ch}:${innerWidth}x${innerHeight}`;
  if (key === state.layoutKey) return;
  state.layoutKey = key;

  root.classList.toggle('centered', centered);
  if (centered) {
    const w = 0;
    Object.assign(hole.style, { left: `${innerWidth / 2}px`, top: `${innerHeight / 2}px`, width: `${w}px`, height: `${w}px` });
    card.style.left = `${Math.round((innerWidth - cw) / 2)}px`;
    card.style.top = `${Math.round(Math.max(12, Math.min(innerHeight * 0.26, innerHeight - ch - 12)))}px`;
    card.dataset.side = 'center';
    return;
  }
  Object.assign(hole.style, {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.right - box.left}px`,
    height: `${box.bottom - box.top}px`,
  });
  const pos = cardPosition(box, cw, ch, step.place || 'right');
  card.style.left = `${pos.left}px`;
  card.style.top = `${pos.top}px`;
  card.dataset.side = pos.side;
}

// Follow the target through window resizes, sidebar slides, scrolling and re-renders
function track() {
  if (!state) return;
  layout();
  state.frame = requestAnimationFrame(track);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function keyLabel(token) {
  if (MAC) return token;
  return token.replace('⌘', 'Ctrl+').replace('⌥', 'Alt+').replace('⌃', 'Ctrl+').replace('⇧', 'Shift+');
}

// "⇧⌘D" -> <kbd>⇧</kbd><kbd>⌘</kbd><kbd>D</kbd>; "⇧-click" -> <kbd>⇧</kbd> click
function keys(combo) {
  const wrap = U.el('span', 'intro-keys');
  const parts = combo.match(/[⌘⇧⌥⌃]|[^⌘⇧⌥⌃]+/g) || [];
  for (const part of parts) {
    const word = part.replace(/^-/, '');
    if (/^(click|Tab)$/.test(word.trim()) && part.startsWith('-')) wrap.appendChild(U.el('span', 'intro-key-word', word));
    else if (/\s/.test(word)) {
      // "yt Tab": something you type, then a key
      const [typed, key] = word.split(/\s+/);
      wrap.append(U.el('span', 'intro-key-word', `“${typed}”`), U.el('kbd', null, key));
    } else wrap.appendChild(U.el('kbd', null, keyLabel(word)));
  }
  wrap.setAttribute('aria-label', combo);
  return wrap;
}

// Text with {⌘T}-style key tokens
function richText(tag, className, text) {
  const node = U.el(tag, className);
  text.split(/\{([^}]+)\}/).forEach((part, i) => {
    if (!part) return;
    node.appendChild(i % 2 ? keys(part) : document.createTextNode(part));
  });
  return node;
}

function render() {
  const { card } = state;
  const visible = state.steps;
  const pos = visible.indexOf(state.index);
  const step = STEPS[state.index];
  const first = pos === 0;
  const last = pos === visible.length - 1;
  card.replaceChildren();
  card.dataset.step = step.id;

  const body = U.el('div', 'intro-body');
  body.id = 'intro-body';
  body.setAttribute('aria-live', 'polite');
  const count = U.el('div', 'intro-count', last ? 'All done' : first ? 'Quick tour' : `Step ${pos} of ${visible.length - 2}`);
  const title = U.el('h3', null, step.title);
  title.id = 'intro-title';
  body.append(count, title);
  if (step.text) body.appendChild(richText('p', null, step.text));
  if (step.tips) {
    const grid = U.el('div', 'intro-tips');
    for (const [combo, label] of step.tips) grid.append(keys(combo), U.el('span', null, label));
    body.appendChild(grid);
  }
  if (step.tryIt && (!step.tryIt.when || step.tryIt.when())) {
    const tryBtn = U.el('button', 'intro-try');
    tryBtn.type = 'button';
    tryBtn.append(U.icon('sparkles'), U.el('span', null, step.tryIt.label));
    tryBtn.addEventListener('click', () => tryIt(step.tryIt));
    body.appendChild(tryBtn);
  }
  if (step.note) body.appendChild(U.el('p', 'intro-note', step.note));
  card.appendChild(body);

  // Progress dots double as quick navigation
  const dots = U.el('div', 'intro-dots');
  dots.setAttribute('role', 'group');
  dots.setAttribute('aria-label', 'Tour progress');
  visible.forEach((stepIndex, i) => {
    const dot = U.el('button', 'intro-dot' + (i === pos ? ' active' : '') + (i < pos ? ' done' : ''));
    dot.type = 'button';
    dot.tabIndex = -1;
    dot.setAttribute('aria-label', `Step ${i + 1}: ${STEPS[stepIndex].title}`);
    if (i === pos) dot.setAttribute('aria-current', 'step');
    dot.addEventListener('click', () => go(stepIndex));
    dots.appendChild(dot);
  });

  const actions = U.el('div', 'intro-actions');
  if (!last) {
    const skip = U.el('button', 'text-btn intro-skip', 'Skip tour');
    skip.type = 'button';
    skip.addEventListener('click', finish);
    actions.appendChild(skip);
  }
  actions.appendChild(U.el('div', 'intro-spacer'));
  if (!first) {
    const back = U.el('button', 'btn', 'Back');
    back.type = 'button';
    back.addEventListener('click', () => move(-1));
    actions.appendChild(back);
  }
  const next = U.el('button', 'btn primary intro-next', step.next || 'Next');
  next.type = 'button';
  next.addEventListener('click', () => (last ? finish() : move(1)));
  actions.appendChild(next);

  card.append(dots, actions);
  state.layoutKey = null;
  layout();
  next.focus({ preventScroll: true });
}

// Visible step indexes, worked out when the tour opens and again on every move
// (a step's target may appear or vanish while the tour runs)
function visibleSteps() {
  return STEPS.map((s, i) => i).filter((i) => available(STEPS[i]));
}

function go(index) {
  if (!state || state.suspended || index < 0 || index >= STEPS.length || index === state.index) return;
  state.index = index;
  state.steps = visibleSteps();
  if (!state.steps.includes(index)) state.steps = [...state.steps, index].sort((a, b) => a - b);
  // Let the hole and card glide to the new spot, then go back to tracking instantly
  const { root, card } = state;
  root.classList.add('moving');
  clearTimeout(state.moveTimer);
  state.moveTimer = setTimeout(() => state && root.classList.remove('moving'), 360);
  if (!reducedMotion()) {
    card.classList.remove('step-in');
    void card.offsetWidth;
    card.classList.add('step-in');
  }
  render();
}

function move(dir) {
  if (!state) return;
  const steps = visibleSteps();
  const target = dir > 0 ? steps.find((i) => i > state.index) : [...steps].reverse().find((i) => i < state.index);
  if (target !== undefined) go(target);
  else if (dir > 0) finish();
}

/* ------------------------------------------------------------------ */
/* "Try it": step aside while the real UI is open                      */
/* ------------------------------------------------------------------ */

function tryIt(action) {
  if (!state || state.suspended) return;
  state.suspended = true;
  state.root.classList.add('suspended');
  state.root.setAttribute('aria-hidden', 'true');
  let seen = false;
  const check = () => {
    if (!state || !state.suspended) return;
    if (action.isOpen()) seen = true;
    else if (seen) resume();
  };
  state.observer = new MutationObserver(check);
  state.observer.observe(document.body, { childList: true, attributes: true, attributeFilter: ['class'] });
  // If the thing never opened (or opens without touching the body), don't strand the user
  state.tryTimer = setTimeout(() => {
    if (!seen && !action.isOpen()) resume();
  }, 1500);
  try {
    Promise.resolve(action.run()).then(check, resume);
  } catch {
    resume();
  }
  check();
}

function resume() {
  if (!state || !state.suspended) return;
  state.observer.disconnect();
  clearTimeout(state.tryTimer);
  state.suspended = false;
  state.root.classList.remove('suspended');
  state.root.removeAttribute('aria-hidden');
  state.layoutKey = null;
  layout();
  const next = state.card.querySelector('.intro-next');
  if (next) next.focus({ preventScroll: true });
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

// Esc normally never gets here (the main process captures it and routes it through
// U.pushEscape); the fallback covers key events that bypass that route
function onKey(e) {
  if (!state || state.suspended) return;
  if (e.key === 'Escape') finish();
  else if (e.key === 'ArrowRight') move(1);
  else if (e.key === 'ArrowLeft') move(-1);
  else if (e.key === 'Enter') {
    // Enter on a focused button presses that button; anywhere else it means Next
    if (e.target.closest && e.target.closest('.intro-card button')) return;
    move(1);
  } else if (e.key === 'Tab') trapFocus(e);
  else return;
  e.preventDefault();
  e.stopPropagation();
}

// Keep Tab / ⇧Tab cycling inside the card
function trapFocus(e) {
  const items = [...state.card.querySelectorAll('button:not([tabindex="-1"])')].filter((b) => !b.disabled);
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  const nextIndex = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === -1 || i === items.length - 1 ? 0 : i + 1);
  items[nextIndex].focus();
}

// Focus wandering out (e.g. a click on the dimmed area) comes straight back
function onFocusIn(e) {
  if (!state || state.suspended || state.card.contains(e.target)) return;
  const next = state.card.querySelector('.intro-next');
  if (next) next.focus({ preventScroll: true });
}

/* ------------------------------------------------------------------ */
/* Open / close                                                        */
/* ------------------------------------------------------------------ */

function finish() {
  if (!state) return;
  const { root, release, restoreFocus, frame, observer } = state;
  cancelAnimationFrame(frame);
  if (observer) observer.disconnect();
  clearTimeout(state.tryTimer);
  clearTimeout(state.moveTimer);
  state = null;
  release();
  window.removeEventListener('keydown', onKey, true);
  document.removeEventListener('focusin', onFocusIn, true);
  root.classList.add('leaving');
  setTimeout(() => root.remove(), reducedMotion() ? 0 : 180);
  // The tour only revealed a collapsed sidebar for itself; let it slide away again
  document.body.classList.remove('intro-reveal');
  U.store.set(SEEN_KEY, true);
  if (restoreFocus && restoreFocus.isConnected && restoreFocus !== document.body) restoreFocus.focus({ preventScroll: true });
}

function start() {
  if (state) return;
  ctx.settings.close();
  ctx.command.close();
  if (ctx.library.isOpen()) ctx.library.close();
  U.closeContextMenu();

  // Most steps point into the sidebar. Show a collapsed (or compact) sidebar over the
  // page just for the tour, without touching the saved collapsed / compact setting.
  const wasHidden = document.body.classList.contains('sidebar-collapsed') && !document.body.classList.contains('sidebar-peek');
  document.body.classList.add('intro-reveal');

  const root = U.el('div', 'intro-overlay');
  if (reducedMotion()) root.classList.add('no-motion');
  const hole = U.el('div', 'intro-hole');
  const card = U.el('div', 'intro-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'intro-title');
  card.setAttribute('aria-describedby', 'intro-body');
  root.append(hole, card);
  // Swallow clicks so the tour isn't dismissed or the UI underneath triggered by accident
  root.addEventListener('mousedown', (e) => {
    if (!card.contains(e.target)) e.preventDefault();
  });
  document.body.appendChild(root);

  const steps = visibleSteps();
  state = {
    root, hole, card,
    index: steps[0],
    steps,
    release: U.pushEscape(() => (state && state.suspended ? null : finish())),
    restoreFocus: document.activeElement,
    layoutKey: null,
    suspended: false,
  };
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', onFocusIn, true);
  render();
  // Re-measure once the sidebar has slid in (tracking keeps it right after that too)
  state.frame = requestAnimationFrame(track);
  // A sidebar that was sliding in hid its steps from the first count; count again once it's in
  if (wasHidden) {
    setTimeout(() => {
      if (!state || state.suspended || state.index !== steps[0]) return;
      state.steps = visibleSteps();
      render();
    }, 320);
  }
}

function maybeShowFirstRun() {
  if (U.PRIVATE || U.store.get(SEEN_KEY, false)) return;
  setTimeout(() => {
    // Something else (a dialog, a restored session's menu) may have taken over; try once more later
    if (!state) start();
  }, 600);
}

ctx.intro = { start, finish, isOpen, maybeShowFirstRun, steps: STEPS };
