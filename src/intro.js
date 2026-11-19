// Intro: a guided tour that spotlights each part of the window. Runs once on
// first launch and can be replayed from Settings or the command bar.

const ctx = require('./ctx');
const U = require('./util');

const SEEN_KEY = 'browser.introSeen';
const mod = process.platform === 'darwin' ? '⌘' : 'Ctrl+';

// target: element id to spotlight (null = centered card)
const STEPS = [
  {
    target: null,
    title: 'Welcome to Browser',
    text: 'A quick tour of the essentials — about a minute. Use ← → to move between steps, or Esc to skip. You can replay it any time from Settings.',
  },
  {
    target: 'sidebar',
    title: 'Everything lives in the sidebar',
    text: `Your tabs run down the side instead of across the top. Toggle it with ${mod}S, or drag its edge to resize.`,
  },
  {
    target: 'omnibox',
    title: 'Search or type an address',
    text: `Press ${mod}L to edit the address. Type “yt”, “gh” and other shortcuts then Tab to search a site directly. The buttons here open Reader view, Boosts, and favorites.`,
  },
  {
    target: 'shields-btn',
    title: 'Shields block trackers',
    text: 'Ads and trackers are blocked automatically. The count shows how many were stopped on this page — click to turn Shields off for a site.',
  },
  {
    target: 'new-tab-btn',
    title: 'New tabs and the command bar',
    text: `${mod}T opens the command bar: search, open a URL, or run any command (try typing “split” or “summarize”). The arrow gives notes, easels, split view, and folders.`,
  },
  {
    target: 'today-zone',
    title: 'Today tabs tidy themselves',
    text: 'Tabs you open land here. Ones you don’t revisit are archived automatically (adjustable in Settings), and “Clear” archives them all at once.',
  },
  {
    target: 'pinned-zone',
    title: 'Pin what you keep coming back to',
    text: `Drag a tab above the line, or press ${mod}D, to pin it. Pinned tabs never get archived. Drag one to the very top to make it a favorite across all spaces.`,
  },
  {
    target: 'spaces-bar',
    title: 'Spaces separate your worlds',
    text: 'Keep Work, Personal, and projects apart — each space has its own tabs and color. Click + to add one, ⌃1–9 to switch.',
    fallback: 'add-space-btn',
  },
  {
    target: 'library-btn',
    title: 'Library',
    text: `History (${mod}Y), archived tabs, downloads, notes, and highlights — all searchable in one drawer.`,
  },
  {
    target: 'assistant-btn',
    title: 'Ask the assistant',
    text: 'Summarize pages, ask questions, translate, or search the web with AI. Hold Shift over a link for a quick preview. Add your Anthropic API key in Settings to turn it on.',
  },
  {
    target: 'settings-btn',
    title: 'Settings',
    text: `Themes, search engine, passwords, extensions, import from another browser, and the full shortcut list (${mod},). The “Replay intro” button is in there too.`,
  },
  {
    target: null,
    title: 'A few tricks to try',
    text: null,
    tips: [
      ['⇧-click a link', 'Peek at it without leaving the page'],
      [`⇧${mod}D`, 'Split view — two pages side by side'],
      ['Right-drag ← →', 'Mouse gestures for back and forward'],
      [`⇧${mod}R`, 'Reader view for clean articles'],
      [`⌥${mod}C`, 'Compact mode hides everything but the page'],
    ],
  },
];

let state = null;

function isOpen() {
  return !!state;
}

function visibleTarget(step) {
  for (const id of [step.target, step.fallback]) {
    const node = id && document.getElementById(id);
    if (!node || node.hidden) continue;
    const r = node.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return node;
  }
  return null;
}

function position() {
  if (!state) return;
  const { root, hole, card, index } = state;
  const target = visibleTarget(STEPS[index]);
  root.classList.toggle('centered', !target);
  if (!target) {
    hole.style.cssText = '';
    card.style.cssText = '';
    return;
  }
  const pad = 6;
  const r = target.getBoundingClientRect();
  const box = {
    left: Math.max(4, r.left - pad),
    top: Math.max(4, r.top - pad),
    right: Math.min(innerWidth - 4, r.right + pad),
    bottom: Math.min(innerHeight - 4, r.bottom + pad),
  };
  Object.assign(hole.style, {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.right - box.left}px`,
    height: `${box.bottom - box.top}px`,
  });

  // Prefer the right of the target (sidebar items), else below, else above.
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const gap = 14;
  let left;
  let top;
  if (box.right + gap + cw <= innerWidth - 12) {
    left = box.right + gap;
    top = Math.min(Math.max(12, (box.top + box.bottom) / 2 - ch / 2), innerHeight - ch - 12);
  } else if (box.bottom + gap + ch <= innerHeight - 12) {
    left = Math.min(Math.max(12, box.left), innerWidth - cw - 12);
    top = box.bottom + gap;
  } else {
    left = Math.min(Math.max(12, box.left), innerWidth - cw - 12);
    top = Math.max(12, box.top - gap - ch);
  }
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function render() {
  const { card, index } = state;
  const step = STEPS[index];
  card.replaceChildren();

  card.appendChild(U.el('div', 'intro-count', `${index + 1} of ${STEPS.length}`));
  card.appendChild(U.el('h3', null, step.title));
  if (step.text) card.appendChild(U.el('p', null, step.text));
  if (step.tips) {
    const grid = U.el('div', 'shortcut-grid intro-tips');
    for (const [keys, label] of step.tips) grid.append(U.el('kbd', null, keys), U.el('span', null, label));
    card.appendChild(grid);
  }

  const dots = U.el('div', 'intro-dots');
  STEPS.forEach((_, i) => {
    const dot = U.el('button', 'intro-dot' + (i === index ? ' active' : ''));
    dot.type = 'button';
    dot.setAttribute('aria-label', `Step ${i + 1}`);
    dot.addEventListener('click', () => go(i));
    dots.appendChild(dot);
  });

  const actions = U.el('div', 'intro-actions');
  const last = index === STEPS.length - 1;
  if (!last) {
    const skip = U.el('button', 'text-btn intro-skip', 'Skip tour');
    skip.addEventListener('click', finish);
    actions.appendChild(skip);
  }
  actions.appendChild(U.el('div', 'intro-spacer'));
  if (index > 0) {
    const back = U.el('button', 'btn', 'Back');
    back.addEventListener('click', () => go(index - 1));
    actions.appendChild(back);
  }
  const next = U.el('button', 'btn primary', last ? 'Start browsing' : index === 0 ? 'Show me around' : 'Next');
  next.addEventListener('click', () => (last ? finish() : go(index + 1)));
  actions.appendChild(next);

  card.append(dots, actions);
  position();
  next.focus();
}

function go(index) {
  if (!state || index < 0 || index >= STEPS.length) return;
  state.index = index;
  render();
}

function onKey(e) {
  if (!state) return;
  if (e.key === 'ArrowRight') go(state.index + 1);
  else if (e.key === 'ArrowLeft') go(state.index - 1);
  else return;
  e.preventDefault();
}

function finish() {
  if (!state) return;
  const { root, release, wasCollapsed, wasCompact } = state;
  state = null;
  root.remove();
  release();
  window.removeEventListener('resize', position);
  window.removeEventListener('keydown', onKey, true);
  // Put the window back the way it was before the tour opened the sidebar
  if (wasCompact) ctx.sidebar.toggleCompact();
  else if (wasCollapsed) ctx.sidebar.toggleCollapsed();
  U.store.set(SEEN_KEY, true);
}

function start() {
  if (state) return;
  ctx.settings.close();
  ctx.command.close();

  // The tour points at the sidebar, so make sure it's showing
  const wasCompact = document.body.classList.contains('compact');
  const wasCollapsed = !wasCompact && document.body.classList.contains('sidebar-collapsed');
  if (wasCompact) ctx.sidebar.toggleCompact();
  else if (wasCollapsed) ctx.sidebar.toggleCollapsed();

  const root = U.el('div', 'intro-overlay');
  const hole = U.el('div', 'intro-hole');
  const card = U.el('div', 'intro-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Browser tour');
  root.append(hole, card);
  // Swallow clicks so the tour isn't dismissed or the UI underneath triggered by accident
  root.addEventListener('mousedown', (e) => {
    if (!card.contains(e.target)) e.preventDefault();
  });
  document.body.appendChild(root);

  state = { root, hole, card, index: 0, release: U.pushEscape(finish), wasCollapsed, wasCompact };
  window.addEventListener('resize', position);
  window.addEventListener('keydown', onKey, true);
  // Wait for the sidebar to finish sliding in before measuring
  setTimeout(render, wasCollapsed || wasCompact ? 260 : 0);
}

function maybeShowFirstRun() {
  if (U.PRIVATE || U.store.get(SEEN_KEY, false)) return;
  setTimeout(start, 600);
}

ctx.intro = { start, finish, isOpen, maybeShowFirstRun };
