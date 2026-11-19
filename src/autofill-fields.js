// Recognizes address and card fields in a form. Shared as source text: the page script
// uses it to notice an address/card field got focus, the main process to fill the fields.

// autocomplete tokens Surf fills (cc-csc is recognized only so it's never filled)
const CARD_TOKENS = ['cc-name', 'cc-given-name', 'cc-family-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc'];
const ADDRESS_TOKENS = ['name', 'given-name', 'family-name', 'organization', 'street-address', 'address-line1', 'address-line2', 'address-line3',
  'address-level1', 'address-level2', 'postal-code', 'country', 'country-name', 'email', 'tel', 'tel-national'];

// Guesses from name/id/placeholder/label when there's no autocomplete attribute, in order
// (card fields first, so "name on card" isn't taken for a name, and email before address)
const GUESSES = [
  ['cc-csc', 'cvc|cvv|csc|cvn|security.?code|card.?code|card.?verif|ccv'],
  ['cc-number', 'card.?num|cc.?num|card.?no|cardnumber|credit.?card|acct.?num|kartennummer'],
  ['cc-name', 'name.?on.?card|card.?holder|cc.?name|card.?name|holder.?name|nameoncard'],
  ['cc-exp-month', 'exp.{0,12}month|cc.?month|card.?month|^mm$|expmonth'],
  ['cc-exp-year', 'exp.{0,12}year|cc.?year|card.?year|^yy(yy)?$|expyear'],
  ['cc-exp', 'expir|exp.?date|^exp$|cc.?exp|mm.?.?yy'],
  ['email', 'e.?mail'],
  ['tel', 'phone|^tel|telephone|mobile'],
  ['postal-code', 'zip|postal|post.?code|postcode|^plz$'],
  ['country', 'country'],
  ['address-level2', 'city|town|locality|suburb'],
  ['address-level1', 'state|province|region|county|prefecture'],
  ['organization', 'company|organi[sz]ation|business.?name'],
  ['address-line2', 'address.?2|address.?line.?2|addr.?2|line.?2|apartment|^apt|suite|unit'],
  ['address-line1', 'address.?1|address.?line.?1|addr.?1|line.?1|street|^address$|^addr$|billing.?address|shipping.?address|delivery.?address'],
  ['given-name', 'first.?name|given.?name|^fname|forename|vorname'],
  ['family-name', 'last.?name|family.?name|surname|^lname|nachname'],
  ['name', 'full.?name|^name$|your.?name|recipient|^shipping.?name|^billing.?name'],
];

// Runs in the page (or an isolated world): fieldToken(el) -> one of the tokens above, or null
const CLASSIFY_SOURCE = `
  const AF_KNOWN = new Set(${JSON.stringify([...CARD_TOKENS, ...ADDRESS_TOKENS])});
  const AF_GUESSES = ${JSON.stringify(GUESSES)}.map(([t, re]) => [t, new RegExp(re, 'i')]);
  const AF_SKIP_TYPES = new Set(['hidden', 'password', 'submit', 'button', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'search']);
  const fieldLabel = (el) => {
    const parts = [];
    if (el.labels) for (const l of el.labels) parts.push(l.textContent);
    const by = el.getAttribute('aria-labelledby');
    if (by) for (const id of by.split(/\\s+/)) { const n = document.getElementById(id); if (n) parts.push(n.textContent); }
    return parts.join(' ').replace(/\\s+/g, ' ').trim().slice(0, 80);
  };
  const fieldToken = (el) => {
    if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.disabled || el.readOnly) return null;
    if (el.tagName === 'INPUT' && AF_SKIP_TYPES.has((el.type || '').toLowerCase())) return null;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/).filter((t) => AF_KNOWN.has(t)).pop();
    if (ac) return ac;
    if (el.type === 'email') return 'email';
    if (el.type === 'tel') return 'tel';
    const keys = [el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), fieldLabel(el)]
      .filter(Boolean).map((s) => s.toLowerCase().replace(/[\\s_\\-[\\]]+/g, ' ').trim());
    for (const [token, re] of AF_GUESSES) {
      // Anchored patterns (^…$) only compare against a whole key
      if (keys.some((k) => re.test(k) || re.test(k.replace(/ /g, '')))) return token;
    }
    return null;
  };
  const tokenKind = (t) => (!t ? null : t.startsWith('cc-') ? 'card' : 'address');
`;

module.exports = { CARD_TOKENS, ADDRESS_TOKENS, CLASSIFY_SOURCE };
