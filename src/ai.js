// AI features (Claude): page assistant (summarize / ask), link summaries, tidy tabs & titles.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

const T = () => ctx.tabs;
const PAGE_CHAR_LIMIT = 150000;

const SYSTEM_PROMPT = `You are an assistant built into a web browser. The user is looking at a web page whose text is provided in <page>. Answer their questions about it clearly and concisely — short paragraphs or bullet points, no preamble. Use Markdown for structure (headings, bullets, **bold**). If something isn't covered by the page, say so, then answer from general knowledge if that helps.`;

let session = null; // { url, title, text, truncated, messages: [] }
let release = null;
let streaming = null; // { requestId, node, text }

const isOpen = () => document.body.classList.contains('assistant-open');

/* ------------------------------------------------------------------ */
/* Page text                                                           */
/* ------------------------------------------------------------------ */

async function readActivePage() {
  const tab = T().activeTab();
  if (!tab || tab.kind !== 'web' || !tab.ready || U.isNewTabUrl(tab.url)) return null;
  try {
    const page = await tab.webview.executeJavaScript(`(() => ({
      title: document.title,
      url: location.href,
      text: document.body ? document.body.innerText : '',
    }))()`);
    return page;
  } catch {
    return null;
  }
}

function startWebSession() {
  session = { mode: 'web', url: null, title: 'Web search', text: '', truncated: false, messages: [], extras: [] };
  renderAll();
}

function askWeb(question) {
  startWebSession();
  show();
  ask(question);
}

function startSession({ url, title, text }) {
  const clean = String(text || '').replace(/\n{3,}/g, '\n\n').trim();
  const truncated = clean.length > PAGE_CHAR_LIMIT;
  session = { url, title, text: truncated ? clean.slice(0, PAGE_CHAR_LIMIT) : clean, truncated, messages: [], extras: [] };
  renderAll();
}

/* ------------------------------------------------------------------ */
/* Drawer UI                                                           */
/* ------------------------------------------------------------------ */

function renderAll() {
  renderContext();
  const list = U.$('assistant-messages');
  list.replaceChildren();
  U.$('assistant-page').textContent = session ? session.title || U.compactUrl(session.url) : '';

  if (!session) {
    list.appendChild(U.el('div', 'history-empty', 'Open a web page to ask about it.'));
    return;
  }
  if (session.truncated) {
    list.appendChild(U.el('div', 'assistant-note', `This page is very long — only the first ${PAGE_CHAR_LIMIT.toLocaleString()} characters are included.`));
  }
  if (!session.messages.length && session.mode === 'web') {
    const intro = U.el('div', 'assistant-intro');
    intro.appendChild(U.icon('globe'));
    intro.appendChild(U.el('p', null, 'Ask anything — Claude searches the web and cites its sources.'));
    list.appendChild(intro);
  } else if (!session.messages.length) {
    const intro = U.el('div', 'assistant-intro');
    intro.appendChild(U.icon('sparkles'));
    intro.appendChild(U.el('p', null, 'Ask anything about this page.'));
    const chips = U.el('div', 'boost-row');
    for (const skill of skills.slice(0, 5)) {
      const chip = U.el('button', 'chip', skill.name);
      chip.title = skill.prompt;
      chip.addEventListener('click', () => ask(skill.prompt));
      chips.appendChild(chip);
    }
    intro.appendChild(chips);
    list.appendChild(intro);
  }
  for (const m of session.messages) {
    list.appendChild(messageNode(m.role, m.content));
    if (m.sources && m.sources.length) list.appendChild(sourcesNode(m.sources));
  }
  list.scrollTop = list.scrollHeight;
}

function sourcesNode(sources) {
  const wrap = U.el('div', 'msg-sources');
  wrap.appendChild(U.el('span', 'msg-sources-label', 'Sources'));
  sources.forEach((s, i) => {
    const chip = U.el('button', 'source-chip');
    chip.title = s.url;
    chip.append(U.el('span', 'source-num', String(i + 1)), U.el('span', null, s.title || U.compactUrl(s.url)));
    chip.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey) T().openTab(s.url, { activate: false });
      else ctx.peek.open(s.url);
    });
    wrap.appendChild(chip);
  });
  return wrap;
}

function messageNode(role, content) {
  const node = U.el('div', `msg msg-${role}`);
  if (role === 'assistant') U.renderMarkdown(node, content);
  else node.textContent = content;
  return node;
}

async function openAssistant() {
  const page = await readActivePage();
  if (!page) {
    if (!session || session.mode !== 'web') startWebSession();
    else renderAll();
    show();
    return;
  }
  if (!session || session.url !== page.url) startSession(page);
  else renderAll();
  show();
}

function show() {
  ctx.library.close();
  ctx.command.close();
  document.body.classList.add('assistant-open');
  if (!release) release = U.pushEscape(closeAssistant);
  U.$('assistant-input').focus();
}

function closeAssistant() {
  document.body.classList.remove('assistant-open');
  if (release) release();
  release = null;
}

async function summarizePage() {
  await openAssistant();
  if (session && !session.messages.length && !streaming) ask('Summarize this page.');
}

// partition: the session of the tab the link was in (an isolated Space has its own logins)
async function summarizeLink(url, partition = T().activePartition()) {
  startSession({ url, title: U.compactUrl(url), text: '' });
  show();
  const list = U.$('assistant-messages');
  list.replaceChildren(U.el('div', 'assistant-note', `Reading ${U.compactUrl(url)}…`));
  const result = await ipcRenderer.invoke('fetch-page-text', url, partition);
  if (result.error || !result.text) {
    list.replaceChildren(U.el('div', 'assistant-note error', `Couldn’t read that page${result.error ? `: ${result.error}` : '.'}`));
    return;
  }
  startSession({ url, title: result.title || U.compactUrl(url), text: result.text });
  ask('Summarize this linked page in a few bullets, then one line on whether it’s worth reading in full.');
}

/* ------------------------------------------------------------------ */
/* Streaming chat                                                      */
/* ------------------------------------------------------------------ */

async function ask(question) {
  if (!session || streaming || !question.trim()) return;
  session.messages.push({ role: 'user', content: question.trim() });
  renderAll();
  maybeRemember(question);

  const node = messageNode('assistant', '');
  node.classList.add('streaming');
  U.$('assistant-messages').appendChild(node);
  const requestId = U.uid();
  streaming = { requestId, node, text: '' };
  U.$('assistant-send').disabled = true;

  const memory = memoryBlock();
  if (session.mode === 'web' && !session.extras.length) {
    ipcRenderer.send('ai-ask-web', {
      requestId,
      system: memory ? `You answer questions for someone using a web browser. Search the web when the answer depends on current or specific facts. Be concise: lead with the answer, then short supporting points. Use Markdown. Do not paste URLs into the text; sources are listed separately.\n\n${memory}` : undefined,
      messages: session.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    return;
  }

  // Pages in context: the current page plus any tabs the user added
  const pages = [];
  if (session.mode !== 'web' && session.text) pages.push({ url: session.url, title: session.title, text: session.text });
  for (const extra of await extraPages()) pages.push(extra);
  const pageBlocks = pages.map((p) => `<page url="${p.url}" title="${String(p.title || '').replace(/"/g, '&quot;')}">\n${p.text}\n</page>`).join('\n\n');
  const intro = pages.length > 1
    ? `You are an assistant built into a web browser. The user has shared ${pages.length} web pages, each in a <page> tag. Answer using them — compare, combine and cite which page (by title) each point comes from. Be clear and concise; use Markdown. If something isn't covered, say so, then answer from general knowledge if helpful.`
    : SYSTEM_PROMPT;
  ipcRenderer.send('ai-stream', {
    requestId,
    effort: 'medium',
    system: [
      { type: 'text', text: memory ? `${intro}\n\n${memory}` : intro },
      // Pages are the stable, large part of every request: cache them across follow-ups
      { type: 'text', text: pageBlocks || '(no page)', cache_control: { type: 'ephemeral' } },
    ],
    messages: session.messages.map((m) => ({ role: m.role, content: m.content })),
  });
}

/* ------------------------------------------------------------------ */
/* Chat with several tabs                                              */
/* ------------------------------------------------------------------ */

const extraCache = new Map(); // entryId -> { url, title, text }

async function extraPages() {
  const out = [];
  for (const id of session.extras) {
    const entry = T().findEntry(id);
    if (!entry) continue;
    const tab = T().live.get(id);
    const url = (tab && tab.url) || entry.url;
    const cached = extraCache.get(id);
    if (cached && cached.url === url) {
      out.push(cached);
      continue;
    }
    let text = '';
    let title = T().entryTitle(entry);
    if (tab && tab.kind === 'web' && tab.ready) {
      try {
        text = await tab.webview.executeJavaScript('document.body ? document.body.innerText : ""');
      } catch { /* fall back to fetching */ }
    } else if (entry.kind === 'note') {
      text = (ctx.internal.noteText && ctx.internal.noteText(entry.refId)) || '';
    }
    if (!text && /^https?:/i.test(url)) {
      const fetched = await ipcRenderer.invoke('fetch-page-text', url, T().partitionFor(id));
      text = fetched.text || '';
      title = fetched.title || title;
    }
    const page = { url, title, text: text.replace(/\n{3,}/g, '\n\n').slice(0, Math.floor(PAGE_CHAR_LIMIT / 2)) };
    extraCache.set(id, page);
    out.push(page);
  }
  return out;
}

function addTabMenu(x, y) {
  if (!session) return;
  const taken = new Set(session.extras);
  const active = T().activeEntryId;
  const candidates = [...T().favorites, ...T().entriesIn([...T().activeSpace().pinned, ...T().activeSpace().today])]
    .filter((e) => !taken.has(e.id) && !(e.id === active && session.mode !== 'web') && (e.kind === 'note' || /^https?:/i.test(e.url)));
  if (!candidates.length) {
    U.toast('No other tabs to add');
    return;
  }
  U.contextMenu([
    { header: 'Add a tab to this chat' },
    ...candidates.slice(0, 14).map((e) => ({
      label: T().entryTitle(e),
      icon: e.kind === 'web' ? 'globe' : e.kind,
      action: () => {
        session.extras.push(e.id);
        renderContext();
        U.$('assistant-input').focus();
      },
    })),
  ], x, y);
}

function renderContext() {
  const row = U.$('assistant-context');
  row.replaceChildren();
  if (!session) return;
  if (session.mode !== 'web' && session.url) {
    row.appendChild(U.el('span', 'ctx-chip current', session.title || U.compactUrl(session.url)));
  }
  for (const id of session.extras) {
    const entry = T().findEntry(id);
    if (!entry) continue;
    const chip = U.el('span', 'ctx-chip');
    chip.appendChild(U.el('span', null, T().entryTitle(entry)));
    chip.appendChild(U.iconButton('close', 'Remove', () => {
      session.extras = session.extras.filter((x) => x !== id);
      renderContext();
    }, 'ctx-chip-x'));
    row.appendChild(chip);
  }
  const add = U.el('button', 'ctx-chip add', '+ Add tab');
  add.title = 'Chat with several tabs (or type @)';
  add.addEventListener('click', (e) => addTabMenu(e.clientX, e.clientY - 10));
  row.appendChild(add);
  const skillsBtn = U.el('button', 'ctx-chip add');
  skillsBtn.append(U.icon('zap'), document.createTextNode(' Skills'));
  skillsBtn.addEventListener('click', (e) => skillsMenu(e.clientX, e.clientY - 10));
  row.appendChild(skillsBtn);
}

/* ------------------------------------------------------------------ */
/* Skills: saved prompts you reuse                                     */
/* ------------------------------------------------------------------ */

const SKILLS_KEY = 'browser.skills';
const DEFAULT_SKILLS = [
  { id: 's-sum', name: 'Summarize', prompt: 'Summarize this in 5 bullet points, then one sentence on why it matters.' },
  { id: 's-flash', name: 'Make flashcards', prompt: 'Make 8 study flashcards from this. Format each as **Q:** … then **A:** … on the next line.' },
  { id: 's-eli5', name: 'Explain simply', prompt: 'Explain this like I’m new to the topic, with one everyday analogy.' },
  { id: 's-actions', name: 'Action items', prompt: 'Extract every action item, decision and deadline as a checklist.' },
  { id: 's-email', name: 'Draft an email', prompt: 'Draft a short, friendly email sharing the key points of this with a colleague.' },
  { id: 's-compare', name: 'Compare', prompt: 'Compare these in a table (key features, pros, cons, price if available), then give a one-line recommendation.' },
];
let skills = U.store.get(SKILLS_KEY, null) || DEFAULT_SKILLS;
const saveSkills = () => U.store.set(SKILLS_KEY, skills);

async function runSkill(skill) {
  if (!session || !document.body.classList.contains('assistant-open')) await openAssistant();
  if (session) ask(skill.prompt);
}

function skillsMenu(x, y) {
  U.contextMenu([
    { header: 'Skills' },
    ...skills.map((s) => ({ label: s.name, icon: 'zap', action: () => runSkill(s) })),
    { separator: true },
    { label: 'New skill…', icon: 'plus', action: newSkill },
    { label: 'Manage skills…', icon: 'settings', action: () => ctx.settings.open('skills') },
  ], x, y);
}

async function newSkill() {
  const name = await U.dialog({ title: 'New skill', placeholder: 'Name, e.g. “Tweet thread”', confirmLabel: 'Next' });
  if (!name) return;
  const prompt = await U.dialog({ title: `What should “${name}” do?`, placeholder: 'e.g. Turn this into a 5-tweet thread', confirmLabel: 'Save skill' });
  if (!prompt) return;
  skills.push({ id: U.uid(), name, prompt });
  saveSkills();
  U.toast(`Skill “${name}” saved`);
}

function deleteSkill(id) {
  skills = skills.filter((s) => s.id !== id);
  saveSkills();
}

/* ------------------------------------------------------------------ */
/* Memory: things the assistant remembers about you                    */
/* ------------------------------------------------------------------ */

const MEMORY_KEY = 'browser.memory';
let memories = U.store.get(MEMORY_KEY, []); // { id, text, created }
const saveMemories = () => U.store.set(MEMORY_KEY, memories);

function memoryBlock() {
  if (!ctx.settings.get('aiMemory') || !memories.length) return '';
  return `Things the user has asked you to remember about them (use when relevant, don't mention this list):\n<memory>\n${memories.map((m) => `- ${m.text}`).join('\n')}\n</memory>`;
}

const REMEMBER_HINT = /\b(remember|my name is|call me|i prefer|i like|i love|i hate|i'?m (a|an|based|from|vegetarian|vegan)|i live|i work|i am (a|an))\b/i;

async function maybeRemember(text) {
  if (!ctx.settings.get('aiMemory') || U.PRIVATE || !REMEMBER_HINT.test(text)) return;
  const result = await ipcRenderer.invoke('ai-json', {
    effort: 'low',
    system: 'Extract durable personal facts or preferences the user wants an assistant to remember (name, location, job, tastes, how they like answers). Ignore questions and one-off requests. Write each fact in third person, short. Return an empty list if there are none.',
    prompt: text,
    schema: { type: 'object', properties: { facts: { type: 'array', items: { type: 'string' } } }, required: ['facts'], additionalProperties: false },
  });
  if (result.error || !result.data.facts.length) return;
  const known = new Set(memories.map((m) => m.text.toLowerCase()));
  const fresh = result.data.facts.filter((f) => f.trim() && !known.has(f.toLowerCase()));
  if (!fresh.length) return;
  memories.push(...fresh.map((f) => ({ id: U.uid(), text: f.trim(), created: Date.now() })));
  saveMemories();
  U.toast(`Remembered: ${fresh.join('; ')}`, { actionLabel: 'Manage', action: () => ctx.settings.open('memory'), duration: 5000 });
}

function deleteMemory(id) {
  memories = memories.filter((m) => m.id !== id);
  saveMemories();
}

// Other features (link previews) stream through here too
const requests = new Map(); // requestId -> { onDelta, onDone }

let paintQueued = false;
ipcRenderer.on('ai-delta', (_e, { requestId, text }) => {
  if (requests.has(requestId)) return requests.get(requestId).onDelta(text);
  if (!streaming || streaming.requestId !== requestId) return;
  streaming.text += text;
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    if (!streaming) return;
    U.renderMarkdown(streaming.node, streaming.text);
    const list = U.$('assistant-messages');
    list.scrollTop = list.scrollHeight;
  });
});

ipcRenderer.on('ai-done', (_e, { requestId, error, sources }) => {
  if (requests.has(requestId)) {
    const handler = requests.get(requestId);
    requests.delete(requestId);
    return handler.onDone(error);
  }
  if (!streaming || streaming.requestId !== requestId) return;
  const { node, text } = streaming;
  streaming = null;
  node.classList.remove('streaming');
  U.$('assistant-send').disabled = false;
  if (error) {
    node.classList.add('error');
    node.replaceChildren(U.el('p', null, error));
    if (/Settings/.test(error)) {
      const btn = U.el('button', 'chip', 'Open Settings');
      btn.addEventListener('click', () => ctx.settings.open());
      node.appendChild(btn);
    }
    session.messages.pop(); // let them retry the question
    return;
  }
  U.renderMarkdown(node, text);
  session.messages.push({ role: 'assistant', content: text, sources: sources || [] });
  if (sources && sources.length) node.after(sourcesNode(sources));
});

/* ------------------------------------------------------------------ */
/* Tidy tabs                                                           */
/* ------------------------------------------------------------------ */

async function tidyTabs() {
  const space = T().activeSpace();
  const loose = space.today.filter((n) => n.type === 'entry' && n.kind === 'web' && !U.isNewTabUrl(n.url));
  if (loose.length < 4) {
    U.toast('Open a few more tabs first — nothing to tidy yet');
    return;
  }
  U.toast('Tidying tabs…');
  const listing = loose.map((e) => `${e.id} | ${T().entryTitle(e)} | ${U.hostOf(e.url)}`).join('\n');
  const result = await ipcRenderer.invoke('ai-json', {
    effort: 'low',
    system: 'You organize browser tabs into folders. Group tabs that clearly belong together by topic or task. Use short, specific folder names (1–3 words). Only make a group when it has at least 2 tabs; leave unrelated tabs out of every group. Use each tab id at most once.',
    prompt: `Tabs (id | title | site):\n${listing}`,
    schema: {
      type: 'object',
      properties: {
        groups: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, tab_ids: { type: 'array', items: { type: 'string' } } },
            required: ['name', 'tab_ids'],
            additionalProperties: false,
          },
        },
      },
      required: ['groups'],
      additionalProperties: false,
    },
  });
  if (result.error) return aiError(result.error);

  const snapshot = JSON.parse(JSON.stringify(space.today));
  const used = new Set();
  let made = 0;
  for (const group of result.data.groups || []) {
    const members = group.tab_ids
      .filter((id) => !used.has(id))
      .map((id) => space.today.find((n) => n.id === id && n.type === 'entry'))
      .filter(Boolean);
    if (members.length < 2) continue;
    members.forEach((m) => used.add(m.id));
    space.today = space.today.filter((n) => !members.includes(n));
    space.today.unshift({ type: 'folder', id: U.uid(), name: group.name.slice(0, 40), open: true, children: members });
    made++;
  }
  if (!made) {
    U.toast('Your tabs are already tidy');
    return;
  }
  ctx.sidebar.render();
  T().save();
  U.toast(`Grouped tabs into ${made} folder${made > 1 ? 's' : ''}`, {
    actionLabel: 'Undo',
    action: () => {
      space.today = snapshot;
      ctx.sidebar.render();
      T().save();
    },
    duration: 6000,
  });
}

async function tidyTitles() {
  const space = T().activeSpace();
  const entries = T().entriesIn([...space.pinned, ...space.today]).filter((e) => e.kind === 'web' && !U.isNewTabUrl(e.url));
  if (!entries.length) {
    U.toast('No tabs to tidy');
    return;
  }
  U.toast('Tidying titles…');
  const listing = entries.map((e) => `${e.id} | ${T().live.get(e.id)?.title || e.title} | ${U.hostOf(e.url)}`).join('\n');
  const result = await ipcRenderer.invoke('ai-json', {
    effort: 'low',
    system: 'You rewrite browser tab titles so they are short and scannable in a narrow sidebar: 2–5 words, keep the distinctive part (article topic, product, repo name), drop site names, separators and boilerplate like "Home" or "| Site". Keep proper nouns. Return one title per tab id.',
    prompt: `Tabs (id | current title | site):\n${listing}`,
    schema: {
      type: 'object',
      properties: {
        titles: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, title: { type: 'string' } },
            required: ['id', 'title'],
            additionalProperties: false,
          },
        },
      },
      required: ['titles'],
      additionalProperties: false,
    },
  });
  if (result.error) return aiError(result.error);

  const previous = new Map(entries.map((e) => [e.id, e.customTitle]));
  let changed = 0;
  for (const { id, title } of result.data.titles || []) {
    const entry = entries.find((e) => e.id === id);
    if (entry && title.trim()) {
      entry.customTitle = title.trim().slice(0, 60);
      changed++;
    }
  }
  ctx.sidebar.render();
  T().save();
  U.toast(`Renamed ${changed} tab${changed === 1 ? '' : 's'}`, {
    actionLabel: 'Undo',
    action: () => {
      for (const e of entries) e.customTitle = previous.get(e.id) || null;
      ctx.sidebar.render();
      T().save();
    },
    duration: 6000,
  });
}

function aiError(message) {
  U.toast(message, /Settings/.test(message) ? { action: () => ctx.settings.open(), actionLabel: 'Settings', duration: 6000 } : { duration: 6000 });
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

function setup() {
  U.$('assistant-btn').addEventListener('click', () => (isOpen() ? closeAssistant() : openAssistant()));
  U.$('close-assistant-btn').addEventListener('click', closeAssistant);
  U.$('reset-assistant-btn').addEventListener('click', async () => {
    if (streaming) return;
    const page = await readActivePage();
    if (page) startSession(page);
  });
  const input = U.$('assistant-input');
  U.$('assistant-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value;
    input.value = '';
    ask(q);
  });
  input.addEventListener('input', (e) => {
    // Typing @ opens the tab picker
    if (e.data === '@') {
      input.value = input.value.replace(/@$/, '');
      const r = input.getBoundingClientRect();
      addTabMenu(r.left, r.top - 10);
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      U.$('assistant-form').requestSubmit();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Link previews: hover a link, press Shift                            */
/* ------------------------------------------------------------------ */

const previewCache = new Map(); // url -> { title, summary }
let previewRelease = null;

function closePreview() {
  const card = U.$('link-preview');
  if (card) card.remove();
  if (previewRelease) previewRelease();
  previewRelease = null;
  document.removeEventListener('mousedown', outsidePreview, true);
}

function outsidePreview(e) {
  const card = U.$('link-preview');
  if (card && !card.contains(e.target)) closePreview();
}

async function linkPreview() {
  const url = ctx.page.hoveredLink();
  if (!url || !/^https?:/i.test(url)) return;
  closePreview();

  const card = U.el('div', 'link-preview');
  card.id = 'link-preview';
  const head = U.el('div', 'lp-head');
  const iconWrap = U.el('span', 'row-icon');
  iconWrap.appendChild(U.iconElement(`https://icons.duckduckgo.com/ip3/${U.hostOf(url)}.ico`, U.ICONS.globe));
  const titles = U.el('div', 'lp-titles');
  const title = U.el('div', 'lp-title', U.compactUrl(url));
  titles.append(title, U.el('div', 'lp-host', U.hostOf(url)));
  head.append(iconWrap, titles);
  const body = U.el('div', 'lp-body streaming');
  const actions = U.el('div', 'lp-actions');
  const open = U.el('button', 'chip', 'Open');
  open.addEventListener('click', () => { closePreview(); T().openTab(url); });
  const peekBtn = U.el('button', 'chip', 'Peek');
  peekBtn.addEventListener('click', () => { closePreview(); ctx.peek.open(url); });
  actions.append(open, peekBtn);
  card.append(head, body, actions);
  U.$('content').appendChild(card);
  previewRelease = U.pushEscape(closePreview);
  setTimeout(() => document.addEventListener('mousedown', outsidePreview, true), 0);

  const cached = previewCache.get(url);
  if (cached) {
    title.textContent = cached.title;
    U.renderMarkdown(body, cached.summary);
    body.classList.remove('streaming');
    return;
  }

  const page = await ipcRenderer.invoke('fetch-page-text', url, T().activePartition());
  if (!U.$('link-preview')) return;
  if (page.error || !page.text) {
    body.classList.remove('streaming');
    body.textContent = 'Couldn’t load a preview for this link.';
    return;
  }
  title.textContent = page.title || U.compactUrl(url);

  const requestId = U.uid();
  let text = '';
  requests.set(requestId, {
    onDelta: (delta) => {
      text += delta;
      U.renderMarkdown(body, text);
    },
    onDone: (error) => {
      body.classList.remove('streaming');
      if (error) {
        // Without AI, fall back to the start of the page text
        body.textContent = `${page.text.slice(0, 280)}…`;
        return;
      }
      previewCache.set(url, { title: title.textContent, summary: text });
    },
  });
  ipcRenderer.send('ai-stream', {
    requestId,
    effort: 'low',
    system: 'You preview links for a browser user before they click. In 2–3 short sentences say what the page is and its key point or takeaway. No preamble, no headings.',
    messages: [{ role: 'user', content: `<page url="${url}" title="${(page.title || '').replace(/"/g, '&quot;')}">\n${page.text.slice(0, 60000)}\n</page>` }],
  });
}

/* ------------------------------------------------------------------ */
/* Translate page                                                      */
/* ------------------------------------------------------------------ */

const COLLECT_TEXT = `(() => {
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'SVG', 'MATH', 'KBD', 'SAMP', 'TEMPLATE']);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const t = n.nodeValue.trim();
      if (t.length < 2 || !/\\p{L}/u.test(t)) return NodeFilter.FILTER_REJECT;
      for (let p = n.parentElement; p; p = p.parentElement) {
        if (skip.has(p.tagName) || p.isContentEditable) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode() && nodes.length < 1500) nodes.push(walker.currentNode);
  window.__btNodes = nodes;
  window.__btOriginal = nodes.map((n) => n.nodeValue);
  window.__btApply = (start, list) => list.forEach((t, i) => {
    const n = nodes[start + i];
    if (n && t) n.nodeValue = n.nodeValue.replace(n.nodeValue.trim(), t);
  });
  window.__btRestore = () => nodes.forEach((n, i) => { n.nodeValue = window.__btOriginal[i]; });
  return nodes.map((n) => n.nodeValue.trim());
})()`;

function targetLanguage() {
  const chosen = ctx.settings.get('translateTo');
  if (chosen) return chosen;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(navigator.language.split('-')[0]);
  } catch {
    return 'English';
  }
}

async function translatePage() {
  const tab = T().activeTab();
  if (!tab || tab.kind !== 'web' || !tab.ready || U.isNewTabUrl(tab.url)) {
    U.toast('Open a web page to translate');
    return;
  }
  const lang = targetLanguage();
  let strings;
  try {
    strings = await tab.webview.executeJavaScript(COLLECT_TEXT);
  } catch {
    U.toast('This page can’t be translated');
    return;
  }
  if (!strings.length) {
    U.toast('No text to translate');
    return;
  }

  // Chunk by count and size; first chunk (top of page) goes first so it updates quickly
  const chunks = [];
  let current = { start: 0, items: [], size: 0 };
  strings.forEach((s, i) => {
    if (current.items.length >= 80 || current.size + s.length > 6000) {
      chunks.push(current);
      current = { start: i, items: [], size: 0 };
    }
    current.items.push(s);
    current.size += s.length;
  });
  if (current.items.length) chunks.push(current);

  U.toast(`Translating to ${lang}…`, { duration: 4000 });
  const schema = { type: 'object', properties: { translations: { type: 'array', items: { type: 'string' } } }, required: ['translations'], additionalProperties: false };
  let failed = null;
  const translateChunk = async (chunk) => {
    const result = await ipcRenderer.invoke('ai-json', {
      effort: 'low',
      system: `You translate web page text into ${lang}. You receive a JSON array of strings in page order; return exactly the same number of strings, translated, in the same order. Keep names, numbers, URLs and punctuation. Return strings already in ${lang} unchanged.`,
      prompt: JSON.stringify(chunk.items),
      schema,
    });
    if (result.error) {
      failed = result.error;
      return;
    }
    const translations = (result.data.translations || []).slice(0, chunk.items.length);
    try {
      await tab.webview.executeJavaScript(`window.__btApply && window.__btApply(${chunk.start}, ${JSON.stringify(translations)})`);
    } catch { /* page navigated */ }
  };

  await translateChunk(chunks[0]);
  for (let i = 1; i < chunks.length && !failed; i += 3) {
    await Promise.all(chunks.slice(i, i + 3).map(translateChunk));
  }
  if (failed) return aiError(failed);
  U.toast(`Translated to ${lang}`, {
    actionLabel: 'Show original',
    action: () => tab.webview.executeJavaScript('window.__btRestore && window.__btRestore()').catch(() => {}),
    duration: 8000,
  });
}

/* ------------------------------------------------------------------ */
/* Auto-name downloads with generic file names                         */
/* ------------------------------------------------------------------ */

const GENERIC_NAME = /^(download|file|document|untitled|unnamed|image|img|export|attachment|output|data|report|invoice|scan|print|view|getfile|content)([\s_-]*\(?\d*\)?)$|^[a-f0-9-]{12,}$|^[a-z0-9]{24,}$|^\d+$|^[^a-z]*$/i;

function isGenericName(filename) {
  const base = filename.replace(/\.[a-z0-9]{1,6}$/i, '');
  return GENERIC_NAME.test(base);
}

async function renameDownload(d) {
  if (!ctx.settings.get('aiRenameDownloads') || !isGenericName(d.filename)) return null;
  const ext = (d.filename.match(/\.[a-z0-9]{1,6}$/i) || [''])[0];
  const result = await ipcRenderer.invoke('ai-json', {
    effort: 'low',
    system: 'You name downloaded files. Given the original file name, the download URL and the page it came from, propose a short, descriptive file name (2–6 words, Title Case or natural words separated by spaces, no extension, no dates unless meaningful, no special characters). If nothing meaningful can be inferred, return the original name without extension.',
    prompt: JSON.stringify({ original: d.filename, url: d.url, page_title: d.pageTitle || '', page_url: d.pageUrl || '' }),
    schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  });
  if (result.error || !result.data.name) return null;
  const name = result.data.name.replace(/\.[a-z0-9]{1,6}$/i, '').trim();
  if (!name || name + ext === d.filename) return null;
  const renamed = await ipcRenderer.invoke('rename-file', { from: d.savePath, name: name + ext });
  return renamed.error ? null : renamed;
}

ctx.ai = {
  setup, openAssistant, closeAssistant, summarizePage, summarizeLink, tidyTabs, tidyTitles, askWeb, linkPreview, closePreview, translatePage, renameDownload,
  skills: () => skills, runSkill, newSkill, deleteSkill, memories: () => memories, deleteMemory, addTabMenu,
  askAbout: async (text) => { await openAssistant(); if (session) ask(`About this part: “${text}”\n\nExplain it and add useful context.`); },
};
