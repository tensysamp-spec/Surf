// Space export / import (.surfspace files): the window builds and validates the JSON,
// the main process only shows the file dialogs, touches the disk, and hands over files
// opened from Finder (double-click, or dropped on the Dock icon).

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const EXT = 'surfspace';
const MAX_BYTES = 2 * 1024 * 1024; // a space of links is a few KB; anything this big isn't one

module.exports = function setupSpaces(M) {
  const isSpaceFile = (file) => typeof file === 'string' && path.extname(file).toLowerCase() === `.${EXT}`;

  async function readSpaceFile(file) {
    try {
      const { size } = await fs.promises.stat(file);
      if (size > MAX_BYTES) return { name: path.basename(file), error: 'That file is too large to be a Surf space.' };
      return { name: path.basename(file), text: await fs.promises.readFile(file, 'utf8') };
    } catch (err) {
      return { name: path.basename(file), error: `Couldn’t read the file: ${err.message}` };
    }
  }

  ipcMain.handle('space-export', async (event, { name, json }) => {
    if (typeof json !== 'string') return { error: 'Nothing to export.' };
    if (json.length > MAX_BYTES) return { error: 'Space is too large to export.' };
    const win = BrowserWindow.fromWebContents(event.sender);
    const safe = String(name || 'Space').replace(/[/\\:*?"<>|]/g, '-').slice(0, 80) || 'Space';
    const result = await dialog.showSaveDialog(win, {
      title: 'Export space',
      defaultPath: path.join(app.getPath('downloads'), `${safe}.${EXT}`),
      filters: [{ name: 'Surf space', extensions: [EXT] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(result.filePath, json, 'utf8');
    return { path: result.filePath };
  });

  ipcMain.handle('space-import-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Import space',
      properties: ['openFile'],
      filters: [{ name: 'Surf space', extensions: [EXT] }],
    });
    const file = !result.canceled && result.filePaths[0];
    return file ? readSpaceFile(file) : null;
  });

  // Files opened from Finder wait until the main window's code has booted and says so
  const pending = [];
  let readyContents = null;

  async function deliver(file) {
    const data = await readSpaceFile(file);
    const win = M.getMainWindow();
    if (readyContents && !readyContents.isDestroyed() && win && win.webContents === readyContents) {
      readyContents.send('space-import-data', data);
      M.focusMain();
    } else {
      pending.push(data);
      if (app.isReady() && !win) M.focusMain(); // reopens the window, which then asks for these
    }
  }

  ipcMain.on('space-import-ready', (event) => {
    const win = M.getMainWindow();
    if (!win || event.sender !== win.webContents) return;
    readyContents = event.sender;
    while (pending.length) event.sender.send('space-import-data', pending.shift());
  });

  // Only .surfspace files are claimed here; anything else keeps its default handling
  app.on('open-file', (event, file) => {
    if (!isSpaceFile(file)) return;
    event.preventDefault();
    deliver(file);
  });

  // Windows / Linux pass the file as an argument (at launch, or to a second instance)
  app.on('second-instance', (_event, argv) => {
    const file = argv.find(isSpaceFile);
    if (file) deliver(file);
  });
  const launchFile = process.argv.slice(1).find(isSpaceFile);
  if (launchFile) deliver(launchFile);

  // File → Import Space… asks the focused browser window to run the import
  return {
    requestImport() {
      const focused = BrowserWindow.getFocusedWindow();
      const win = M.isBrowserWindow(focused) ? focused : M.getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('space-import-request');
    },
  };
};
