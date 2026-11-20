// PDFs: hands a tab's PDF to the Annotate PDF view, saves annotated copies, and makes
// Chromium's built-in viewer save through Surf's downloads.

const { app, BrowserWindow, dialog, ipcMain, webContents, webFrameMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

// Chromium's built-in PDF viewer runs as this extension inside the tab
const VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai';
const MAX_BYTES = 200 * 1024 * 1024;

// The viewer saves a form you filled in ("Download → With your changes") through the
// File System Access save picker, which writes straight to disk behind Surf's back. Swap the
// picker for a plain download so the copy lands in Surf's downloads (list, shelf, naming)
// like every other file. "Without your changes" is already a normal download.
const SAVE_THROUGH_DOWNLOADS = `(() => {
  if (window.__surfPdfSave) return;
  window.__surfPdfSave = true;
  window.showSaveFilePicker = async (options = {}) => ({
    kind: 'file',
    name: options.suggestedName || 'document.pdf',
    createWritable: async () => {
      const parts = [];
      return {
        write: async (data) => { parts.push(data && data.data !== undefined ? data.data : data); },
        close: async () => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob(parts, { type: 'application/pdf' }));
          a.download = options.suggestedName || 'document.pdf';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        },
      };
    },
  });
})()`;

const isPdfBytes = (buf) => buf.length > 4 && buf.subarray(0, 1024).includes('%PDF-');

module.exports = function setup(M) {
  // The Annotate view reads the PDF again itself (through the tab's own session, so logins
  // and private windows keep working); the built-in viewer has no API to hand its bytes over
  ipcMain.handle('pdf-fetch', async (_event, { url, webContentsId }) => {
    try {
      let buf;
      if (/^file:/i.test(url)) {
        const file = fileURLToPath(url);
        const { size } = await fs.promises.stat(file);
        if (size > MAX_BYTES) return { error: 'This PDF is too large to annotate.' };
        buf = await fs.promises.readFile(file);
      } else if (/^https?:/i.test(url)) {
        const contents = webContents.fromId(webContentsId);
        const ses = contents && !contents.isDestroyed() ? contents.session : null;
        const res = await (ses ? ses.fetch(url) : fetch(url));
        if (!res.ok) return { error: `The PDF couldn’t be downloaded (HTTP ${res.status}).` };
        if (Number(res.headers.get('content-length')) > MAX_BYTES) return { error: 'This PDF is too large to annotate.' };
        buf = Buffer.from(await res.arrayBuffer());
      } else {
        return { error: 'This PDF can’t be opened for annotation.' };
      }
      if (!isPdfBytes(buf)) return { error: 'This page isn’t a PDF file.' };
      return { bytes: new Uint8Array(buf) };
    } catch (err) {
      return { error: `The PDF couldn’t be loaded: ${err.message || err}` };
    }
  });

  // Always a new file: the dialog never offers the original's path by default
  ipcMain.handle('pdf-save-copy', async (event, { bytes, name }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const safe = String(name || 'document').replace(/[/\\:*?"<>|]/g, '-').replace(/\.pdf$/i, '').slice(0, 120);
    const result = await dialog.showSaveDialog(win, {
      title: 'Save a copy',
      defaultPath: path.join(app.getPath('downloads'), `${safe} (annotated).pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(result.filePath, Buffer.from(bytes));
    return result.filePath;
  });

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.on('did-frame-finish-load', (_e, isMainFrame, processId, routingId) => {
      if (isMainFrame) return;
      const frame = webFrameMain.fromId(processId, routingId);
      if (!frame || !frame.url.startsWith(VIEWER_ORIGIN)) return;
      frame.executeJavaScript(SAVE_THROUGH_DOWNLOADS).catch(() => {});
      // Lets the window offer "Annotate PDF" for PDFs whose address doesn't end in .pdf
      M.sendToOwner(contents, 'pdf-viewer-shown', { webContentsId: contents.id, url: contents.getURL() });
    });
  });
};
