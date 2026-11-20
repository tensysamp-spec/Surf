// Command bar (⌘T): open URLs, search, jump to open tabs, run quick actions.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const T = () => ctx.tabs;
let items = [];
let index = 0;
let release = null;
let mode = 'new'; // 'new' -> open in a new tab, 'split' -> open beside the current tab

const isOpen = () => document.body.classList.contains('command-open');

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function actions() {
  const tab = T().activeTab();
  const isWeb = !!tab && tab.kind === 'web' && !U.isNewTabUrl(tab.url);
  const entryId = T().activeEntryId;
  const loc = entryId ? T().locate(entryId) : null;
  const K = (action) => ctx.shortcuts.label(action) || undefined; // the user's current shortcut
  const list = [
    { title: 'Copy URL', keywords: 'copy link url share', icon: 'link', hint: K('copy-url'), when: isWeb, run: () => ctx.nav.copyUrl() },
    { title: 'Split view', keywords: 'split side by side two tabs', icon: 'split', hint: K('split-view'), run: () => T().splitActiveWithNewTab() },
    { title: loc && loc.section === 'pinned' ? 'Unpin tab' : 'Pin tab', keywords: 'pin unpin keep', icon: 'pin', hint: K('toggle-pin'), when: loc && loc.section !== 'fav', run: () => T().togglePin() },
    { title: T().isFavorite(entryId) ? 'Remove from favorites' : 'Add to favorites', keywords: 'favorite bookmark star', icon: 'star', when: isWeb, run: () => T().toggleFavorite() },
    { title: ctx.bookmarks.isBookmarked(tab && tab.url) ? 'Edit bookmark' : 'Bookmark this page', keywords: 'bookmark save page star add', icon: 'folder', hint: K('bookmark-page'), when: isWeb, run: () => ctx.bookmarks.addCurrent() },
    { title: 'Show bookmarks', keywords: 'bookmarks manager library saved pages', icon: 'folder', hint: K('bookmarks'), run: () => ctx.library.open('bookmarks') },
    { title: 'Export bookmarks', keywords: 'bookmarks export html netscape backup', icon: 'share', run: () => ctx.bookmarks.exportFile() },
    { title: 'Import bookmarks file', keywords: 'bookmarks import html netscape file', icon: 'download', run: () => ctx.bookmarks.importFile() },
    { title: 'Import space…', keywords: 'space import surfspace file open', icon: 'download', run: () => ctx.spaceShare.importFile() },
    { title: 'Export this space…', keywords: 'space export surfspace file share backup', icon: 'file', run: () => ctx.spaceShare.exportSpace() },
    { title: 'New space from template…', keywords: 'space template new work study watch build', icon: 'layers', run: () => ctx.spaceShare.templateMenu() },
    { title: 'Save space as template…', keywords: 'space template save', icon: 'layers', run: () => ctx.spaceShare.saveAsTemplate() },
    { title: 'Profiles', keywords: 'profiles profile separate work personal open switch', icon: 'user', run: () => ctx.settings.open('profiles') },
    { title: 'Keyboard shortcuts', keywords: 'keyboard shortcuts keys hotkeys customize remap', icon: 'keyboard', run: () => ctx.settings.open('shortcuts') },
    { title: 'Summarize this page', keywords: 'ai summary summarize tldr claude', icon: 'sparkles', when: isWeb, run: () => ctx.ai.summarizePage() },
    { title: 'Ask about this page', keywords: 'ai ask question chat claude assistant', icon: 'sparkles', when: isWeb, run: () => ctx.ai.openAssistant() },
    { title: 'Annotate PDF', keywords: 'pdf annotate highlight sign signature draw ink note form fill edit', icon: 'edit', when: ctx.pdfAnnotate.isPdf(tab), run: () => ctx.pdfAnnotate.open() },
    { title: 'Reader view', keywords: 'reader read article clean distraction', icon: 'note', hint: K('reader'), when: isWeb, run: () => ctx.reader.toggle() },
    { title: 'Translate page', keywords: 'translate language ai', icon: 'globe', when: isWeb, run: () => ctx.ai.translatePage() },
    { title: 'Ask Claude (web search)', keywords: 'ask ai question web search claude', icon: 'sparkles', run: () => ctx.ai.openAssistant() },
    { title: 'Extensions', keywords: 'extensions addons plugins chrome', icon: 'layers', run: () => ctx.extensions.openPopover() },
    { title: 'Chrome Web Store', keywords: 'extensions store install add chrome web store addons', icon: 'layers', run: () => ctx.extensions.openStore() },
    { title: 'Replay intro tour', keywords: 'intro tour welcome help tutorial onboarding guide', icon: 'sparkles', run: () => ctx.intro.start() },
    { title: 'Import from another browser', keywords: 'import chrome safari bookmarks history arc brave edge', icon: 'download', run: () => ctx.settings.open('import') },
    { title: 'New private window', keywords: 'private incognito window', icon: 'mask', hint: K('private-window'), when: !U.PRIVATE, run: () => ipcRenderer.send('open-private-window') },
    { title: 'Compact mode', keywords: 'compact focus hide sidebar fullscreen zen', icon: 'maximize', hint: K('compact'), run: () => ctx.sidebar.toggleCompact() },
    { title: 'Screenshot…', keywords: 'screenshot capture image full page area', icon: 'camera', hint: K('screenshot'), when: isWeb, run: () => ctx.screenshot.menu() },
    { title: 'Full-page screenshot', keywords: 'screenshot full page', icon: 'camera', when: isWeb, run: () => ctx.screenshot.capture('full') },
    { title: 'Read aloud', keywords: 'read aloud speak voice listen tts', icon: 'volume', when: isWeb, run: () => ctx.speech.readActive() },
    { title: 'Add page as web panel', keywords: 'panel sidebar web app dock', icon: 'panel', when: isWeb, run: () => ctx.panels.addCurrent() },
    { title: 'New live folder', keywords: 'live folder rss feed github pull requests', icon: 'rss', run: () => ctx.liveFolders.create() },
    { title: 'Privacy report', keywords: 'privacy report trackers blocked shields', icon: 'shield', run: () => ctx.privacy.openReport() },
    { title: 'Page developer tools', keywords: 'devtools inspect console developer', icon: 'code', hint: K('devtools'), when: isWeb, run: () => ctx.page.openDevTools() },
    { title: 'Add to reading list', keywords: 'reading list read later save bookmark', icon: 'bookmark', hint: K('reading-list'), when: isWeb, run: () => ctx.readingList.addActive() },
    { title: 'Show reading list', keywords: 'reading list read later saved unread', icon: 'bookmark', run: () => ctx.library.open('reading') },
    { title: 'Show highlights', keywords: 'highlights saved quotes', icon: 'highlighter', run: () => ctx.library.open('highlights') },
    { title: 'New skill', keywords: 'skill prompt ai saved', icon: 'zap', run: () => ctx.ai.newSkill() },
    ...ctx.ai.skills().map((sk) => ({ title: `Skill: ${sk.name}`, keywords: `skill ai ${sk.name} ${sk.prompt}`, icon: 'zap', run: () => ctx.ai.runSkill(sk) })),
    { title: 'Tidy tabs into folders', keywords: 'ai tidy organize group folders clean', icon: 'wand', run: () => ctx.ai.tidyTabs() },
    { title: 'Tidy tab titles', keywords: 'ai tidy rename titles shorten', icon: 'wand', run: () => ctx.ai.tidyTitles() },
    { title: 'Boost this site', keywords: 'boost customize style css dark mode font zap', icon: 'wand', when: isWeb, run: () => ctx.boosts.openPanel() },
    { title: 'Capture to easel', keywords: 'screenshot capture clip easel', icon: 'crop', hint: K('capture'), when: isWeb, run: () => ctx.internal.startCapture() },
    { title: 'New note', keywords: 'note write notes text', icon: 'note', run: () => ctx.internal.newNote() },
    { title: 'New easel', keywords: 'easel board canvas collage', icon: 'easel', run: () => ctx.internal.newEasel() },
    { title: 'New little window', keywords: 'little mini window popup quick', icon: 'window', hint: K('little-window'), run: () => ipcRenderer.send('open-little-window') },
    { title: 'Search tabs', keywords: 'search find tabs all spaces archived history switch', icon: 'search', hint: K('tab-search'), run: () => ctx.tabSearch.open() },
    { title: 'New space', keywords: 'space workspace profile', icon: 'layers', run: () => T().addSpace() },
    ...T().spaces.filter((s) => s.id !== T().activeSpaceId).map((s) => ({ title: `Switch to ${s.name}`, keywords: `space switch ${s.name}`, icon: 'layers', run: () => T().switchSpace(s.id) })),
    { title: 'New folder', keywords: 'folder group', icon: 'folder', run: () => T().createFolder('today') },
    { title: 'Collapse all folders', keywords: 'folders collapse close fold all', icon: 'chevronRight', run: () => ctx.folders.setAllOpen(false) },
    { title: 'Expand all folders', keywords: 'folders expand open unfold all', icon: 'chevronDown', run: () => ctx.folders.setAllOpen(true) },
    { title: 'Sort Today by site', keywords: 'sort today tabs site domain order', icon: 'globe', run: () => ctx.folders.sortToday('site') },
    { title: 'Sort Today by title', keywords: 'sort today tabs title name alphabetical order', icon: 'type', run: () => ctx.folders.sortToday('title') },
    { title: 'Sort Today by last used', keywords: 'sort today tabs recent last used order', icon: 'clock', run: () => ctx.folders.sortToday('lastUsed') },
    { title: 'Group tabs from this site', keywords: 'group folder site domain tabs', icon: 'folder', when: loc && loc.section === 'today' && !T().splitOf(entryId) && ctx.folders.siteOfEntry(entryId), run: () => ctx.folders.groupBySite(entryId) },
    { title: 'Show shelf', keywords: 'shelf tray downloads screenshots drop', icon: 'download', run: () => ctx.shelf.toggle() },
    { title: 'Reopen closed tab', keywords: 'reopen undo closed restore', icon: 'undo', hint: K('reopen-closed'), run: () => T().reopenClosed() },
    { title: 'Archive today’s tabs', keywords: 'clear archive close all today', icon: 'archive', run: () => T().clearToday() },
    { title: 'Toggle sidebar', keywords: 'sidebar hide show collapse', icon: 'sidebar', hint: K('toggle-sidebar'), run: () => ctx.sidebar.toggleCollapsed() },
    { title: ctx.settings.get('shields') ? 'Turn shields off' : 'Turn shields on', keywords: 'shields ad block tracker', icon: 'shield', run: () => ctx.nav.toggleShields() },
    { title: 'Show history', keywords: 'history visited', icon: 'clock', hint: K('history'), run: () => ctx.library.open('history') },
    { title: 'Show archive', keywords: 'archive closed tabs', icon: 'archive', run: () => ctx.library.open('archive') },
    { title: 'Show downloads', keywords: 'downloads files', icon: 'download', hint: K('downloads'), run: () => ctx.library.open('downloads') },
    { title: 'Show notes & easels', keywords: 'notes easels library', icon: 'note', run: () => ctx.library.open('notes') },
    { title: 'Clear history', keywords: 'clear delete history', icon: 'trash', run: () => ctx.library.clearHistory() },
    { title: 'Mute tab', keywords: 'mute sound audio', icon: 'mute', when: isWeb && !tab.muted, run: () => ctx.media.toggleMute(tab) },
    { title: 'Unmute tab', keywords: 'unmute sound audio', icon: 'volume', when: isWeb && tab.muted, run: () => ctx.media.toggleMute(tab) },
    { title: 'Mute all other tabs', keywords: 'mute others other tabs silence quiet sound audio media', icon: 'mute', when: ctx.media.othersToMute(tab).length > 0, run: () => ctx.media.muteOthers(tab) },
    { title: 'Settings', keywords: 'settings preferences options api key', icon: 'settings', hint: K('settings'), run: () => ctx.settings.open() },
  ];
  return list.filter((a) => !('when' in a) || !!a.when);
}

/* ------------------------------------------------------------------ */
/* Suggestions                                                         */
/* ------------------------------------------------------------------ */

function score(text, needle) {
  const hay = text.toLowerCase();
  if (hay.startsWith(needle)) return 3;
  if (hay.includes(` ${needle}`)) return 2;
  if (hay.includes(needle)) return 1;
  return 0;
}

function suggestions(query) {
  const q = query.trim();
  const needle = q.toLowerCase();
  const out = [];

  if (q) {
    if (U.looksLikeUrl(q)) out.push({ kind: 'open', title: q, sub: 'Open address', url: U.resolveInput(q), iconName: 'arrow' });
    out.push({ kind: 'search', title: q, sub: `Search ${U.searchEngine().name}`, url: U.searchUrl(q), iconName: 'search' });
    // Questions can go straight to Claude with web search
    if (mode === 'new' && (/\s/.test(q) || q.endsWith('?')) && !U.looksLikeUrl(q)) {
      out.push({ kind: 'ask', title: q, sub: 'Ask Claude — searches the web', iconName: 'sparkles' });
    }
  }

  if (mode === 'new' && q) {
    // Matching actions first — they're what makes the bar fast
    const matched = actions()
      .map((a) => ({ a, s: Math.max(score(a.title, needle), score(a.keywords, needle)) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, 4);
    for (const { a } of matched) out.push({ kind: 'action', title: a.title, sub: 'Action', iconName: a.icon, hint: a.hint, run: a.run });
  }

  // Open tabs ("switch to tab")
  if (mode === 'new') {
    const seen = new Set();
    const candidates = [...T().favorites, ...T().spaces.flatMap((s) => T().entriesIn([...s.pinned, ...s.today]))];
    for (const entry of candidates) {
      if (out.filter((o) => o.kind === 'tab').length >= 3) break;
      const title = T().entryTitle(entry);
      if (!q || seen.has(entry.id) || entry.id === T().activeEntryId) continue;
      if (!(score(title, needle) || entry.url.toLowerCase().includes(needle))) continue;
      seen.add(entry.id);
      out.push({ kind: 'tab', title, sub: 'Switch to tab', entryId: entry.id, favicon: T().entryFavicon(entry), iconName: entry.kind === 'web' ? null : entry.kind });
    }
  }

  // History
  const seenUrls = new Set(out.map((o) => o.url).filter(Boolean));
  for (const h of ctx.library.history()) {
    if (out.length >= 9) break;
    if (seenUrls.has(h.url)) continue;
    if (needle && !(h.title.toLowerCase().includes(needle) || h.url.toLowerCase().includes(needle))) continue;
    seenUrls.add(h.url);
    out.push({ kind: 'page', title: h.title, sub: U.compactUrl(h.url), url: h.url, favicon: h.favicon });
    if (!needle && out.length >= 6) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

function paint() {
  const results = U.$('command-results');
  results.replaceChildren();
  items.forEach((item, i) => {
    const row = U.el('div', 'command-item' + (i === index ? ' selected' : ''));
    const iconWrap = U.el('span', 'c-icon');
    iconWrap.appendChild(item.iconName ? U.icon(item.iconName) : U.iconElement(item.favicon, U.ICONS.globe));
    const hint = item.kind === 'action' ? (item.hint || '↵ Run') : item.kind === 'tab' ? '↵ Switch' : item.kind === 'ask' ? '↵ Ask' : '↵ Open';
    row.append(iconWrap, U.el('span', 'c-title', item.title), U.el('span', 'c-sub', `— ${item.sub}`), U.el('span', 'c-hint', hint));
    row.addEventListener('mousemove', () => {
      if (index !== i) {
        index = i;
        paint();
      }
    });
    row.addEventListener('click', () => run(item));
    results.appendChild(row);
  });
}

function refresh() {
  items = suggestions(U.$('command-input').value);
  index = 0;
  paint();
}

function run(item) {
  if (!item) return;
  close();
  if (item.kind === 'action') item.run();
  else if (item.kind === 'ask') ctx.ai.askWeb(item.title);
  else if (item.kind === 'tab') T().showEntry(item.entryId);
  else if (mode === 'split') T().splitWithUrl(item.url);
  else T().openTab(item.url);
}

function open(openMode = 'new') {
  mode = openMode;
  ctx.library.close();
  const input = U.$('command-input');
  input.value = '';
  input.placeholder = mode === 'split' ? 'Open in split view…' : 'Search, enter a URL, or type a command…';
  refresh();
  document.body.classList.add('command-open');
  if (!release) release = U.pushEscape(close);
  input.focus();
}

function close() {
  document.body.classList.remove('command-open');
  U.$('command-input').blur();
  if (release) release();
  release = null;
}

function toggle() {
  if (isOpen()) close();
  else open();
}

function setup() {
  const input = U.$('command-input');
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      index = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(items[index]);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  U.$('command-overlay').addEventListener('mousedown', (e) => {
    if (e.target === U.$('command-overlay')) close();
  });
}

ctx.command = { setup, open, close, toggle, isOpen };
