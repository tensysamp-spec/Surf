// Read aloud: speaks the article (via Readability) or page text with the
// system's voices. A small player shows progress and controls.

const ctx = require('./ctx');
const U = require('./util');

const synth = window.speechSynthesis;
let queue = [];
let index = 0;
let rate = U.store.get('browser.speechRate', 1);
let playing = false;
let tabId = null;
let title = '';
let release = null;

function pickVoice(lang) {
  const voices = synth.getVoices();
  const base = (lang || navigator.language || 'en').split('-')[0].toLowerCase();
  const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(base));
  // Prefer the nicer macOS voices when present
  const rank = (v) => (/premium|enhanced|siri/i.test(v.name) ? 3 : 0) + (/samantha|ava|alex|daniel|karen|serena|moira/i.test(v.name) ? 2 : 0) + (v.localService ? 1 : 0);
  return matching.sort((a, b) => rank(b) - rank(a))[0] || voices.find((v) => v.default) || voices[0] || null;
}

function chunk(text) {
  // Sentence-sized pieces keep long pages from being cut off and allow skipping
  const sentences = text.replace(/\s+/g, ' ').match(/[^.!?。！？]+[.!?。！？]+["')\]]*\s*|[^.!?。！？]+$/g) || [];
  const out = [];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > 220 && current) {
      out.push(current.trim());
      current = '';
    }
    current += s;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

let voice = null;
let lang = null;

function speakCurrent() {
  synth.cancel();
  if (index >= queue.length) {
    stop();
    U.toast('Finished reading');
    return;
  }
  const utterance = new SpeechSynthesisUtterance(queue[index]);
  utterance.rate = rate;
  if (voice) utterance.voice = voice;
  if (lang) utterance.lang = lang;
  utterance.onend = () => {
    if (!playing) return;
    index++;
    speakCurrent();
  };
  synth.speak(utterance);
  render();
}

function render() {
  const bar = U.$('speech-bar');
  if (!queue.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.replaceChildren();
  bar.appendChild(U.iconButton('chevronRight', 'Back', () => { index = Math.max(0, index - 1); playing = true; speakCurrent(); }, 'icon-btn small flip'));
  bar.appendChild(U.iconButton(playing ? 'pause' : 'play', playing ? 'Pause' : 'Play', togglePause, 'icon-btn small'));
  bar.appendChild(U.iconButton('chevronRight', 'Skip', () => { index++; playing = true; speakCurrent(); }, 'icon-btn small'));
  const info = U.el('div', 'speech-info');
  info.append(U.el('span', 'speech-title', title), U.el('span', 'speech-progress', `${Math.min(index + 1, queue.length)} / ${queue.length}`));
  bar.appendChild(info);
  const speed = U.el('button', 'chip speech-rate', `${rate}×`);
  speed.title = 'Speed';
  speed.addEventListener('click', () => {
    const steps = [0.8, 1, 1.25, 1.5, 1.75, 2];
    rate = steps[(steps.indexOf(rate) + 1) % steps.length] || 1;
    U.store.set('browser.speechRate', rate);
    if (playing) speakCurrent();
    else render();
  });
  bar.appendChild(speed);
  bar.appendChild(U.iconButton('close', 'Stop', stop, 'icon-btn small'));
}

function togglePause() {
  if (playing) {
    playing = false;
    synth.cancel();
  } else {
    playing = true;
    speakCurrent();
  }
  render();
}

function stop() {
  playing = false;
  synth.cancel();
  queue = [];
  index = 0;
  tabId = null;
  if (release) release();
  release = null;
  render();
}

async function readActive() {
  const tab = ctx.tabs.activeTab();
  if (!tab || tab.kind !== 'web' || !tab.ready || U.isNewTabUrl(tab.url)) {
    U.toast('Open a page to read aloud');
    return;
  }
  if (tabId === tab.entryId && queue.length) {
    togglePause();
    return;
  }
  const article = await ctx.reader.extract(tab);
  let text = article && article.textContent;
  if (!text || text.length < 200) {
    try {
      text = await tab.webview.executeJavaScript('document.body ? document.body.innerText : ""');
    } catch {
      text = '';
    }
  }
  if (!text || !text.trim()) {
    U.toast('No readable text on this page');
    return;
  }
  stop();
  title = (article && article.title) || tab.title || U.compactUrl(tab.url);
  lang = article && article.lang;
  voice = pickVoice(lang);
  queue = chunk(`${title}. ${text}`);
  tabId = tab.entryId;
  playing = true;
  release = U.pushEscape(stop);
  speakCurrent();
}

// Voices load asynchronously in Chromium
synth.addEventListener('voiceschanged', () => { voice = pickVoice(lang); });

ctx.speech = { readActive, stop, togglePause };
