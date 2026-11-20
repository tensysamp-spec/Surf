// Runs at document start in every http(s) frame of every web page (registered as a session
// preload by main/privacy.js). It runs in an isolated world: page scripts can't see it.
// - Cookie banners: hides the consent dialogs of the big consent platforms and, when
//   allowed, clicks their "reject" / "necessary only" button. Never anything that accepts.
// - Global Privacy Control and fingerprinting protection need the page's own world, so
//   those few lines are run there with contextBridge.executeInMainWorld.

const { ipcRenderer, contextBridge, webFrame } = require('electron');

/* ------------------------------------------------------------------ */
/* Cookie banners                                                      */
/* ------------------------------------------------------------------ */

// hide: the dialog and its backdrop (any of them there = "a banner is showing");
// reject: buttons that refuse non-essential cookies; text: the button's label must say so
const CMPS = [
  { name: 'OneTrust', hide: ['#onetrust-banner-sdk', '.onetrust-pc-dark-filter'], reject: ['#onetrust-reject-all-handler'] },
  { name: 'Cookiebot', hide: ['#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay'], reject: ['#CybotCookiebotDialogBodyButtonDecline', '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll'] },
  { name: 'Quantcast', hide: ['.qc-cmp2-container'], reject: ['.qc-cmp2-summary-buttons button[mode="secondary"]'], text: true },
  { name: 'Didomi', hide: ['#didomi-notice', '#didomi-popup', '.didomi-popup-backdrop'], reject: ['#didomi-notice-disagree-button', '.didomi-continue-without-agreeing'] },
  // Usercentrics draws in a shadow root that also holds its small privacy button, so it is
  // only hidden while its dialog is actually there
  { name: 'Usercentrics', hide: [], host: '#usercentrics-root, #usercentrics-cmp-ui', dialog: '[role="dialog"], [data-testid="uc-default-banner"], #uc-main-dialog', reject: ['[data-testid="uc-deny-all-button"]', 'button#deny', 'button.deny'] },
  { name: 'TrustArc', hide: ['#truste-consent-track', '#consent_blackbar', '.truste_overlay', '.truste_box_overlay'], reject: ['#truste-consent-required'] },
  // Sourcepoint's buttons live in its own iframe; see FRAME_REJECT
  { name: 'Sourcepoint', hide: ['[id^="sp_message_container_"]'], reject: [] },
  { name: 'Google Funding Choices', hide: ['.fc-consent-root'], reject: ['.fc-cta-do-not-consent'] },
];

// Reject buttons inside a consent platform's iframe (Sourcepoint: choice type 13 = reject all)
const FRAME_REJECT = ['button.sp_choice_type_REJECT_ALL', 'button.sp_choice_type_13'];

// Labels: anything that accepts everything is never clicked, whatever its selector says
const ACCEPT_ALL = /\b(accept|allow|agree to) all\b|\bi agree\b|\baccept (cookies|and)\b|alle (akzeptieren|annehmen|zulassen)|tout accepter|accetta tutt|aceptar todo|accepteer alle|akceptuj wszystk/i;
const REJECT = /reject|decline|\bdeny\b|refuse|disagree|do not consent|don.t consent|necessary|essential|required only|only required|without (agreeing|accepting)|ablehnen|nur (notwendige|erforderliche|essenzielle)|nicht einwilligen|refuser|continuer sans|rifiuta|rechazar|rejeitar|recusar|weiger|odrzu|avvisa|afvis|hylkää|odmítn/i;
const ACCEPT = /accept|agree|allow|consent|\bok\b|got it|akzept|zustimm|einverstanden|accetta|aceptar|aceitar|accepteer|akceptuj|godkänn/i;

function safeToClick(el, textRequired) {
  const text = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
  if (ACCEPT_ALL.test(text)) return false;
  if (REJECT.test(text)) return true;
  if (ACCEPT.test(text)) return false;
  return !textRequired;
}

function findIn(root, selector) {
  try { return root.querySelector(selector); } catch { return null; }
}

function handleBanners(mode, isTop) {
  const reported = new Set();
  const clicked = new WeakSet();
  const seen = new Set(); // consent platforms found on this page
  const rejected = new Set();
  const report = (action) => {
    if (reported.has(action)) return;
    reported.add(action);
    ipcRenderer.send('privacy-banner-handled', action);
  };

  if (isTop) {
    // Hidden from the first paint, so the dialog never flashes up
    webFrame.insertCSS(`${CMPS.flatMap((c) => c.hide).join(',\n')} { display: none !important; }`);
  }

  // Some dialogs lock scrolling while they show; unlock it once they're hidden
  let unlockTimer = null;
  const unlockScroll = () => {
    clearTimeout(unlockTimer);
    unlockTimer = setTimeout(() => {
      for (const el of [document.documentElement, document.body]) {
        if (el && getComputedStyle(el).overflowY === 'hidden') el.style.setProperty('overflow', 'auto', 'important');
      }
    }, 1500);
  };

  const tryReject = (root, selectors, textRequired) => {
    for (const selector of selectors) {
      const button = findIn(root, selector);
      if (!button || clicked.has(button) || !safeToClick(button, textRequired)) continue;
      clicked.add(button);
      button.click();
      return true;
    }
    return false;
  };

  const scan = () => {
    if (!isTop) {
      if (mode === 'reject' && tryReject(document, FRAME_REJECT, false)) report('rejected');
      return;
    }
    for (const cmp of CMPS) {
      let root = document;
      if (cmp.host) {
        const host = findIn(document, cmp.host);
        if (!host || !host.shadowRoot || !findIn(host.shadowRoot, cmp.dialog)) continue;
        host.style.setProperty('display', 'none', 'important');
        root = host.shadowRoot;
      } else if (!cmp.hide.some((s) => findIn(document, s))) continue;
      if (!seen.has(cmp.name)) {
        seen.add(cmp.name);
        unlockScroll();
      }
      // The buttons often show up a little after the dialog, so keep trying
      if (mode === 'reject' && !rejected.has(cmp.name) && tryReject(root, cmp.reject, cmp.text)) rejected.add(cmp.name);
      report(rejected.has(cmp.name) ? 'rejected' : 'hidden');
    }
  };

  // Consent dialogs appear late (after their script loads), so keep watching for a while
  let pending = null;
  const schedule = () => {
    if (!pending) pending = setTimeout(() => { pending = null; scan(); }, 250);
  };
  const start = () => {
    scan();
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 30000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

/* ------------------------------------------------------------------ */
/* Page world: Global Privacy Control, fingerprinting                  */
/* ------------------------------------------------------------------ */

// Runs in the page's world, so it must be self-contained (it is serialized)
function protectPage({ gpc, fingerprinting, blockCanvas }) {
  const getter = (proto, name, value) => {
    Object.defineProperty(proto, name, { configurable: true, enumerable: true, get: { [name]() { return value; } }[name] });
  };
  if (gpc) getter(Navigator.prototype, 'globalPrivacyControl', true);
  if (fingerprinting) {
    // Two common values instead of the exact core count and memory size
    getter(Navigator.prototype, 'hardwareConcurrency', navigator.hardwareConcurrency >= 8 ? 8 : 4);
    if ('deviceMemory' in Navigator.prototype) getter(Navigator.prototype, 'deviceMemory', 8);
  }
  if (blockCanvas) {
    // Reading pixels back gives a blank image of the same size
    const blank = (canvas) => {
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      return copy;
    };
    const { toDataURL, toBlob } = HTMLCanvasElement.prototype;
    HTMLCanvasElement.prototype.toDataURL = function (...args) { return toDataURL.apply(blank(this), args); };
    HTMLCanvasElement.prototype.toBlob = function (...args) { return toBlob.apply(blank(this), args); };
    CanvasRenderingContext2D.prototype.getImageData = function (_x, _y, w, h) {
      return new ImageData(Math.max(1, Math.abs(w | 0)), Math.max(1, Math.abs(h | 0)));
    };
  }
}

// Rough "same site": the last two labels, three for names like example.co.uk
function siteOf(host) {
  const parts = host.replace(/^www\./, '').split('.');
  const n = parts.length > 2 && parts[parts.length - 1].length === 2 && /^(co|com|org|net|gov|ac|edu|ne|or)$/.test(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-n).join('.');
}

// Captchas and payment forms use canvas checks against fraud; leave their frames alone
const CANVAS_ALLOWED = /(^|\.)(google\.com|gstatic\.com|recaptcha\.net|hcaptcha\.com|cloudflare\.com|stripe\.com|paypal\.com|arkoselabs\.com|funcaptcha\.com|youtube\.com|youtube-nocookie\.com)$/;

/* ------------------------------------------------------------------ */

(function main() {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  const isTop = window === window.top;
  const ancestors = location.ancestorOrigins;
  const topUrl = isTop ? location.href : ancestors && ancestors.length ? ancestors[ancestors.length - 1] : '';
  let config = null;
  try { config = ipcRenderer.sendSync('privacy-frame-config', topUrl); } catch { /* not a Surf page */ }
  if (!config) return;

  let thirdParty = false;
  try { thirdParty = !isTop && siteOf(new URL(topUrl).hostname) !== siteOf(location.hostname); } catch { /* opaque top */ }
  const blockCanvas = config.fingerprinting && thirdParty && !CANVAS_ALLOWED.test(location.hostname);
  if (config.gpc || config.fingerprinting) {
    try {
      contextBridge.executeInMainWorld({ func: protectPage, args: [{ gpc: config.gpc, fingerprinting: config.fingerprinting, blockCanvas }] });
    } catch { /* older Electron */ }
  }

  // In iframes there's only something to do when a consent dialog's button may be clicked
  if (config.banners === 'reject' || (config.banners === 'hide' && isTop)) handleBanners(config.banners, isTop);
})();
