const test = require('node:test');
const assert = require('node:assert/strict');
const { CARD_TOKENS, ADDRESS_TOKENS, CLASSIFY_SOURCE } = require('../src/autofill-fields');

// CLASSIFY_SOURCE is page-script text; run it against a fake document and fake form fields
const nodesById = {};
const document = { getElementById: (id) => nodesById[id] || null };
const { fieldToken, tokenKind } = new Function('document', `${CLASSIFY_SOURCE}; return { fieldToken, tokenKind };`)(document);

function field({ tag = 'INPUT', type = 'text', attrs = {}, name = '', id = '', labels = [], disabled = false, readOnly = false } = {}) {
  return {
    tagName: tag,
    type,
    name,
    id,
    disabled,
    readOnly,
    labels: labels.map((textContent) => ({ textContent })),
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
  };
}
const token = (opts) => fieldToken(field(opts));

test('token lists: card tokens are cc-*, address tokens are not', () => {
  assert.ok(CARD_TOKENS.every((t) => t.startsWith('cc-')));
  assert.ok(ADDRESS_TOKENS.every((t) => !t.startsWith('cc-')));
  assert.ok(CARD_TOKENS.includes('cc-csc'));
});

test('autocomplete attribute wins', () => {
  assert.equal(token({ attrs: { autocomplete: 'cc-number' }, name: 'email' }), 'cc-number');
  assert.equal(token({ attrs: { autocomplete: 'shipping postal-code' } }), 'postal-code');
  assert.equal(token({ attrs: { autocomplete: 'section-a billing street-address' } }), 'street-address');
  assert.equal(token({ attrs: { autocomplete: 'GIVEN-NAME' } }), 'given-name');
  // Unknown values fall through to guessing
  assert.equal(token({ attrs: { autocomplete: 'off' }, name: 'zip' }), 'postal-code');
  assert.equal(token({ attrs: { autocomplete: 'new-password' }, name: 'city' }), 'address-level2');
});

test('input types: email and tel', () => {
  assert.equal(token({ type: 'email', name: 'x' }), 'email');
  assert.equal(token({ type: 'tel', name: 'x' }), 'tel');
});

test('fields that are never filled', () => {
  for (const type of ['hidden', 'password', 'submit', 'button', 'checkbox', 'radio', 'file', 'search']) {
    assert.equal(token({ type, name: 'email' }), null, type);
  }
  assert.equal(token({ name: 'email', disabled: true }), null);
  assert.equal(token({ name: 'email', readOnly: true }), null);
  assert.equal(token({ tag: 'BUTTON', name: 'email' }), null);
  assert.equal(fieldToken(null), null);
  assert.equal(token({ name: 'favorite_color' }), null);
});

test('select and textarea are recognized', () => {
  assert.equal(token({ tag: 'SELECT', type: 'select-one', name: 'country' }), 'country');
  assert.equal(token({ tag: 'SELECT', type: 'select-one', name: 'exp_month' }), 'cc-exp-month');
  assert.equal(token({ tag: 'TEXTAREA', type: 'textarea', name: 'street' }), 'address-line1');
});

test('guesses from name and id', () => {
  const cases = {
    first_name: 'given-name', lastName: 'family-name', surname: 'family-name', fullname: 'name', name: 'name',
    'e-mail': 'email', phone_number: 'tel', zip: 'postal-code', postcode: 'postal-code', plz: 'postal-code',
    city: 'address-level2', state: 'address-level1', province: 'address-level1', country: 'country',
    company: 'organization', address1: 'address-line1', 'address[line2]': 'address-line2', apt: 'address-line2',
    street: 'address-line1', address: 'address-line1', billing_address: 'address-line1',
    cardnumber: 'cc-number', 'card-number': 'cc-number', cc_num: 'cc-number', cvv: 'cc-csc', cvc: 'cc-csc',
    security_code: 'cc-csc', 'name-on-card': 'cc-name', cardholder: 'cc-name', exp_month: 'cc-exp-month',
    'expiry-year': 'cc-exp-year', mm: 'cc-exp-month', yy: 'cc-exp-year', yyyy: 'cc-exp-year', expiry: 'cc-exp',
    exp: 'cc-exp', 'mm/yy': 'cc-exp', vorname: 'given-name', nachname: 'family-name',
  };
  for (const [name, expected] of Object.entries(cases)) {
    assert.equal(token({ name }), expected, `name=${name}`);
    assert.equal(token({ id: name }), expected, `id=${name}`);
  }
});

test('guesses from placeholder, aria-label and labels', () => {
  assert.equal(token({ attrs: { placeholder: 'Email address' } }), 'email');
  assert.equal(token({ attrs: { 'aria-label': 'Card number' } }), 'cc-number');
  assert.equal(token({ labels: ['  ZIP / Postal code '] }), 'postal-code');
  nodesById.lbl = { textContent: 'Name on card' };
  assert.equal(token({ attrs: { 'aria-labelledby': 'missing lbl' } }), 'cc-name');
});

test('ordering: card fields before names, email before address', () => {
  // "name on card" contains "name" but is the card holder
  assert.equal(token({ labels: ['Name on card'] }), 'cc-name');
  // "email address" contains "address"
  assert.equal(token({ name: 'email_address' }), 'email');
  // Expiry month before the general expiry
  assert.equal(token({ name: 'card_exp_month' }), 'cc-exp-month');
});

test('anchored patterns only match whole keys', () => {
  assert.equal(token({ name: 'mmx' }), null);
  assert.equal(token({ name: 'username' }), null, 'not a name field');
  assert.equal(token({ name: 'plzx' }), null);
});

test('tokenKind', () => {
  assert.equal(tokenKind('cc-number'), 'card');
  assert.equal(tokenKind('cc-csc'), 'card');
  assert.equal(tokenKind('email'), 'address');
  assert.equal(tokenKind(null), null);
});
