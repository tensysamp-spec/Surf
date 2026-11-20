// Lets window modules that `require('electron')` at load (like src/util.js) load under plain
// Node: 'electron' resolves to a tiny stand-in whose ipcRenderer records what was sent.
const Module = require('module');

const sent = [];
const fake = {
  ipcRenderer: {
    send: (...args) => sent.push(args),
    invoke: async () => null,
    on() {},
    once() {},
    removeListener() {},
  },
};

const FAKE_ID = require.resolve('./fake-electron') + '#electron';
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return FAKE_ID;
  return resolve.call(this, request, ...rest);
};
const mod = new Module(FAKE_ID);
mod.exports = fake;
mod.loaded = true;
require.cache[FAKE_ID] = mod;

module.exports = { fake, sent };
