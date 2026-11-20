// bookmarks.html export. Reading a file back (fromNetscape) needs a real HTML parser, so it's
// checked in the running app by test/smoke.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, toNetscape } = require('../src/bookmarks-html');

const T = 1700000000000; // ms; the file stores seconds
const tree = {
  type: 'folder', id: 'root', title: 'Bookmarks', children: [
    { type: 'bookmark', id: 'b1', title: 'Example', url: 'https://example.com/', added: T },
    {
      type: 'folder', id: 'f1', title: 'Work & "Stuff"', added: T + 1000, children: [
        { type: 'bookmark', id: 'b2', title: '<Docs>', url: 'https://docs.example.com/?a=1&b="2"', added: T + 2000 },
        { type: 'folder', id: 'f2', title: 'Empty', added: T, children: [] },
      ],
    },
  ],
};

test('escapeHtml', () => {
  assert.equal(escapeHtml('a & b < c > d "e"'), 'a &amp; b &lt; c &gt; d &quot;e&quot;');
  assert.equal(escapeHtml("it's"), "it's");
  assert.equal(escapeHtml(42), '42');
});

test('toNetscape: header every browser recognizes', () => {
  const lines = toNetscape(tree).split('\n');
  assert.equal(lines[0], '<!DOCTYPE NETSCAPE-Bookmark-file-1>');
  assert.ok(lines.includes('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">'));
  assert.ok(lines.includes('<TITLE>Bookmarks</TITLE>'));
  assert.ok(lines.includes('<H1>Bookmarks</H1>'));
});

test('toNetscape: nested folders, escaping and dates in seconds', () => {
  const html = toNetscape(tree);
  assert.equal(html, [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    '    <DT><A HREF="https://example.com/" ADD_DATE="1700000000">Example</A>',
    '    <DT><H3 ADD_DATE="1700000001">Work &amp; &quot;Stuff&quot;</H3>',
    '    <DL><p>',
    '        <DT><A HREF="https://docs.example.com/?a=1&amp;b=&quot;2&quot;" ADD_DATE="1700000002">&lt;Docs&gt;</A>',
    '        <DT><H3 ADD_DATE="1700000000">Empty</H3>',
    '        <DL><p>',
    '        </DL><p>',
    '    </DL><p>',
    '</DL><p>',
    '',
  ].join('\n'));
});

test('toNetscape: an empty tree is still a valid file', () => {
  const html = toNetscape({ type: 'folder', id: 'root', title: 'Bookmarks', children: [] });
  assert.match(html, /<DL><p>\n<\/DL><p>\n$/);
});

test('toNetscape: a missing date becomes "now"', () => {
  const before = Math.round(Date.now() / 1000);
  const html = toNetscape({ type: 'folder', id: 'root', children: [{ type: 'bookmark', title: 'x', url: 'https://x.com' }] });
  const added = Number(html.match(/ADD_DATE="(\d+)"/)[1]);
  assert.ok(added >= before && added <= before + 2);
});
