const test = require('node:test');
const assert = require('node:assert/strict');
const csv = require('../main/csv');

test('parse: plain rows, LF, CRLF and lone CR', () => {
  assert.deepEqual(csv.parse('a,b,c\n1,2,3\n'), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepEqual(csv.parse('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(csv.parse('a,b\r1,2'), [['a', 'b'], ['1', '2']]);
});

test('parse: last row without a trailing newline', () => {
  assert.deepEqual(csv.parse('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
});

test('parse: empty fields are kept', () => {
  assert.deepEqual(csv.parse('a,,c\n,,\n'), [['a', '', 'c'], ['', '', '']]);
  assert.deepEqual(csv.parse('a,b,\n'), [['a', 'b', '']]);
  assert.deepEqual(csv.parse('"",x\n'), [['', 'x']]);
});

test('parse: quoted fields with commas and doubled quotes', () => {
  assert.deepEqual(csv.parse('"a,b","say ""hi""",c\n'), [['a,b', 'say "hi"', 'c']]);
  assert.deepEqual(csv.parse('"""quoted"""\n'), [['"quoted"']]);
});

test('parse: line breaks inside quotes stay in the field', () => {
  assert.deepEqual(csv.parse('note,x\n"line 1\nline 2",y\n'), [['note', 'x'], ['line 1\nline 2', 'y']]);
  assert.deepEqual(csv.parse('"a\r\nb",c'), [['a\r\nb', 'c']]);
  assert.deepEqual(csv.parse('"a,\n\n,b"\n'), [['a,\n\n,b']]);
});

test('parse: a leading BOM is dropped', () => {
  assert.deepEqual(csv.parse('﻿url,username\nhttps://a.com,me\n'), [['url', 'username'], ['https://a.com', 'me']]);
  // Only at the start: elsewhere it's data
  assert.deepEqual(csv.parse('a,﻿b'), [['a', '﻿b']]);
});

test('parse: blank lines are not records', () => {
  assert.deepEqual(csv.parse('a,b\n\n1,2\n\r\n\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(csv.parse(''), []);
  assert.deepEqual(csv.parse('\n\n'), []);
  assert.deepEqual(csv.parse('﻿'), []);
});

test('parse: single-column rows are kept when not empty', () => {
  assert.deepEqual(csv.parse('x\ny\n'), [['x'], ['y']]);
});

test('parseRecords: keys are trimmed and lower-cased, missing cells are empty', () => {
  assert.deepEqual(csv.parseRecords(' Name ,URL\nOne,https://one.com\nTwo\n'), [
    { name: 'One', url: 'https://one.com' },
    { name: 'Two', url: '' },
  ]);
  assert.deepEqual(csv.parseRecords(''), []);
  assert.deepEqual(csv.parseRecords('url,password\n'), []);
});

test('parseRecords: Chrome export columns', () => {
  const text = 'name,url,username,password,note\r\n' +
    'example.com,https://example.com/login,alice,"p,a""ss",\r\n' +
    'site.org,https://site.org/,bob,secret,"multi\r\nline"\r\n';
  const [a, b] = csv.parseRecords(text);
  assert.deepEqual(a, { name: 'example.com', url: 'https://example.com/login', username: 'alice', password: 'p,a"ss', note: '' });
  assert.deepEqual(b, { name: 'site.org', url: 'https://site.org/', username: 'bob', password: 'secret', note: 'multi\r\nline' });
});

test('parseRecords: Safari export columns (with BOM)', () => {
  const text = '﻿Title,URL,Username,Password,Notes,OTPAuth\n' +
    'example.com (alice),https://example.com/,alice,hunter2,,\n';
  const [r] = csv.parseRecords(text);
  assert.deepEqual(Object.keys(r), ['title', 'url', 'username', 'password', 'notes', 'otpauth']);
  assert.equal(r.url, 'https://example.com/');
  assert.equal(r.username, 'alice');
  assert.equal(r.password, 'hunter2');
  assert.equal(r.otpauth, '');
});

test('parseRecords: Firefox export columns (everything quoted)', () => {
  const text = '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\r\n' +
    '"https://www.mozilla.org","carol","pa ss","","https://www.mozilla.org","{1-2-3}","1700000000000","1700000000000","1700000000000"\r\n';
  const [r] = csv.parseRecords(text);
  assert.equal(r.url, 'https://www.mozilla.org');
  assert.equal(r.username, 'carol');
  assert.equal(r.password, 'pa ss');
  assert.equal(r.httprealm, '');
  assert.equal(r.formactionorigin, 'https://www.mozilla.org');
  assert.equal(r.guid, '{1-2-3}');
  assert.equal(r.timecreated, '1700000000000');
});

test('stringify: quotes only when needed, ends with a newline', () => {
  assert.equal(csv.stringify([['a', 'b'], ['1', '2']]), 'a,b\n1,2\n');
  assert.equal(csv.stringify([['a,b', 'say "hi"', 'x\ny', 'r\r']]), '"a,b","say ""hi""","x\ny","r\r"\n');
  assert.equal(csv.stringify([[null, undefined, 0, 'x']]), ',,0,x\n');
});

test('stringify then parse gives the same rows', () => {
  const rows = [
    ['name', 'url', 'username', 'password', 'note'],
    ['a.com', 'https://a.com', 'me', 'p"w,1', 'two\nlines'],
    ['b.com', 'https://b.com', '', ' spaced ', ''],
  ];
  assert.deepEqual(csv.parse(csv.stringify(rows)), rows);
});
