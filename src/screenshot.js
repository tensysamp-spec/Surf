// Screenshots: visible area, full page, or a selected area. Saved to Downloads
// and copied to the clipboard.

const { ipcRenderer } = require('electron');
const ctx = require('./ctx');
const U = require('./util');

function activeWebTab() {
  const tab = ctx.tabs.activeTab();
  if (!tab || tab.kind !== 'web' || !tab.ready || U.isNewTabUrl(tab.url)) {
    U.toast('Open a web page to take a screenshot');
    return null;
  }
  return tab;
}

function done(result) {
  if (result.error) {
    U.toast(`Screenshot failed: ${result.error}`);
    return;
  }
  ctx.shelf.addFile(result.path);
  U.toast('Screenshot copied and saved to Downloads', {
    actionLabel: 'Show',
    action: () => ipcRenderer.send('download-action', { action: 'show', savePath: result.path }),
  });
}

async function capture(mode) {
  const tab = activeWebTab();
  if (!tab) return;
  const label = U.hostOf(tab.url).replace(/^www\./, '');
  if (mode === 'area') {
    ctx.internal.startCapture({
      onImage: async (image) => done(await ipcRenderer.invoke('save-image', { png: image.toPNG(), label })),
    });
    return;
  }
  if (mode === 'full') U.toast('Capturing the full page…', { duration: 1500 });
  done(await ipcRenderer.invoke('screenshot', { webContentsId: tab.webContentsId, mode, label }));
}

function menu(x, y) {
  U.contextMenu([
    { header: 'Screenshot' },
    { label: 'Select an area', icon: 'crop', action: () => capture('area') },
    { label: 'Visible part of page', icon: 'camera', action: () => capture('visible') },
    { label: 'Full page', icon: 'maximize', action: () => capture('full') },
  ], x ?? window.innerWidth / 2 - 110, y ?? 120);
}

ctx.screenshot = { capture, menu };
