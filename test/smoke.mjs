// Smoke test: launches Surf with a throwaway profile, drives it over the Chrome DevTools
// Protocol and checks that the window comes up without exceptions, the command bar and
// Settings open and close, and a bookmarks.html file reads back in the real HTML parser.
// Not part of `npm test` (it needs a display). Run with:  node test/smoke.mjs
//   SMOKE_PORT=9450   debugging port to use (default 9450)
//   SMOKE_PROFILE=dir profile folder to use (default: a new temp folder; must not be a real profile)
//   SMOKE_KEEP=1      keep the profile folder afterwards
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const port = Number(process.env.SMOKE_PORT || 9450);
const profile = process.env.SMOKE_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'surf-smoke-'));
fs.mkdirSync(profile, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = spawn(require('electron'), ['.', `--remote-debugging-port=${port}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], {
  cwd: root,
  env: { ...process.env, SURF_PROFILE_DIR: profile },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let appLog = '';
app.stderr.on('data', (d) => { appLog += d; });

async function until(what, fn, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

const targets = () => fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      exceptions.push(d.exception?.description || d.text);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  // Runs in the browser window, where require() reaches the app's modules
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ send, evaluate, exceptions, close: () => ws.close() });
    ws.onerror = () => reject(new Error('Could not connect to the window'));
  });
}

const steps = [];
async function step(name, fn) {
  await fn();
  steps.push(name);
  console.log(`ok - ${name}`);
}

let failed = false;
try {
  const page = await until('the browser window', async () => (await targets()).find((t) => t.type === 'page' && t.url.includes('index.html')));
  const win = await connect(page.webSocketDebuggerUrl);
  await win.send('Runtime.enable');

  await step('window loads', async () => {
    // Exceptions thrown before Runtime.enable aren't reported, so start the window over once
    await until('the first load', () => win.evaluate(`document.readyState === 'complete'`));
    await win.send('Page.reload', { ignoreCache: true });
    await sleep(300);
    await until('the app to start', () => win.evaluate(`document.readyState === 'complete' && !!require('./src/ctx').tabs && !!document.querySelector('#sidebar')`));
    await sleep(1500); // let startup work (session restore, sidebar render) finish
  });

  await step('command bar opens and closes', async () => {
    assert.equal(await win.evaluate(`require('./src/ctx').command.open(), require('./src/ctx').command.isOpen()`), true);
    await sleep(300);
    assert.equal(await win.evaluate(`require('./src/ctx').command.close(), require('./src/ctx').command.isOpen()`), false);
  });

  await step('Settings opens and closes', async () => {
    await win.evaluate(`require('./src/ctx').settings.open()`);
    await until('the Settings window', async () => (await targets()).some((t) => t.type === 'page' && t.title === 'Settings'));
    await sleep(500);
    await win.evaluate(`require('./src/ctx').settings.close()`);
    await until('Settings to close', async () => !(await targets()).some((t) => t.type === 'page' && t.title === 'Settings'));
  });

  await step('bookmarks.html export reads back', async () => {
    const result = await win.evaluate(`(() => {
      const B = require('./src/bookmarks-html');
      let n = 0;
      const make = {
        newFolder: (title) => ({ type: 'folder', id: 'f' + ++n, title, added: 1, open: true, children: [] }),
        newBookmark: ({ title, url, added }) => ({ type: 'bookmark', id: 'b' + ++n, title, url, added }),
      };
      const strip = (list) => list.map((x) => x.type === 'folder' ? { folder: x.title, added: x.added, children: strip(x.children) } : { title: x.title, url: x.url, added: x.added });
      const tree = { type: 'folder', id: 'root', children: [
        { type: 'bookmark', title: 'A & <b>', url: 'https://a.com/?x=1&y="2"', added: 1700000000000 },
        { type: 'folder', title: 'Work', added: 1700000001000, children: [
          { type: 'bookmark', title: 'Docs', url: 'https://docs.example.com/', added: 1700000002000 },
          { type: 'folder', title: 'Empty', added: 1700000000000, children: [] },
        ] },
      ] };
      const ours = B.fromNetscape(B.toNetscape(tree), make);
      // Firefox: a folder with a description puts its list inside a <DD>; non-web links are skipped
      const firefox = B.fromNetscape(\`<!DOCTYPE NETSCAPE-Bookmark-file-1>
        <DL><p>
          <DT><H3 ADD_DATE="1600000000">Toolbar</H3>
          <DD>Things on the toolbar
            <DL><p>
              <DT><A HREF="https://mozilla.org/" ADD_DATE="1600000001">Mozilla</A>
              <DT><A HREF="place:sort=8">Recent</A>
              <DT><A HREF="javascript:alert(1)">Bad</A>
            </DL><p>
          <DT><A HREF="http://example.com/">  Example  </A>
          <script>document.title = 'x'</script>
        </DL>\`, make);
      return { ours: { count: ours.count, tree: strip(ours.children) }, firefox: { count: firefox.count, tree: strip(firefox.children) } };
    })()`);
    assert.deepEqual(result.ours, {
      count: 2,
      tree: [
        { title: 'A & <b>', url: 'https://a.com/?x=1&y="2"', added: 1700000000000 },
        { folder: 'Work', added: 1700000001000, children: [
          { title: 'Docs', url: 'https://docs.example.com/', added: 1700000002000 },
          { folder: 'Empty', added: 1700000000000, children: [] },
        ] },
      ],
    });
    assert.deepEqual(result.firefox, {
      count: 2,
      tree: [
        { folder: 'Toolbar', added: 1600000000000, children: [{ title: 'Mozilla', url: 'https://mozilla.org/', added: 1600000001000 }] },
        { title: 'Example', url: 'http://example.com/', added: null },
      ],
    });
  });

  await step('no exceptions', async () => {
    await sleep(500);
    assert.deepEqual(win.exceptions, []);
  });
  win.close();
} catch (err) {
  failed = true;
  console.error(`not ok - ${err.stack || err.message}`);
  if (appLog.trim()) console.error('--- app stderr ---\n' + appLog.trim().split('\n').slice(-30).join('\n'));
} finally {
  app.kill();
  await new Promise((r) => (app.exitCode !== null ? r() : app.once('exit', r)));
  if (!process.env.SMOKE_KEEP) fs.rmSync(profile, { recursive: true, force: true });
}

console.log(failed ? 'Smoke test FAILED' : `Smoke test passed (${steps.length} checks)`);
process.exit(failed ? 1 : 0);
