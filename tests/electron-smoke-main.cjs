const path = require('node:path');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { app, BrowserWindow, ipcMain } = require('electron');
const { describePaths } = require('../electron/compression.cjs');

ipcMain.handle('paths:describe', (_event, droppedPaths) => {
  return describePaths(Array.isArray(droppedPaths) ? droppedPaths : []);
});

app.whenReady().then(async () => {
  const dropRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pngoo-drop-smoke-'));
  await fsp.mkdir(path.join(dropRoot, 'nested'));
  await fsp.copyFile(path.join(__dirname, '..', 'build', 'icon.png'), path.join(dropRoot, 'nested', 'image.png'));
  const window = new BrowserWindow({
    width: 920,
    height: 650,
    show: true,
    x: -10000,
    y: -10000,
    backgroundColor: '#17191d',
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 350));
    const checks = await window.webContents.executeJavaScript(`(async () => {
      const droppedItems = await window.pngoo.describeDroppedPaths([${JSON.stringify(dropRoot)}]);
      return {
        title: document.title,
        mode: document.querySelector('.lossless')?.textContent.trim(),
        addFilesLabel: document.querySelector('#addFilesButton')?.textContent,
        goLabel: document.querySelector('#goButton')?.textContent,
        bridgeReady: typeof window.pngoo?.pickFiles === 'function',
        dropBridgeReady: typeof window.pngoo?.getPathForFile === 'function' && typeof window.pngoo?.describeDroppedPaths === 'function',
        dropHint: document.querySelector('#emptyState span')?.textContent,
        droppedItemCount: droppedItems.length,
        droppedItemRoot: droppedItems[0]?.root,
        bodyWidth: document.body.scrollWidth,
        bodyHeight: document.body.scrollHeight
      };
    })()`);
    const screenshot = path.join(__dirname, '..', 'ui-smoke.png');
    process.stdout.write(JSON.stringify(checks));
    try {
      const image = await window.webContents.capturePage();
      await fsp.writeFile(screenshot, image.toPNG());
    } catch {
      // Some restricted Windows sessions disable Chromium's Viz capture service.
    }
    if (
      checks.title !== 'PNGoo Desktop' ||
      checks.mode !== 'Lossless (Fixed)' ||
      checks.addFilesLabel !== 'Add Files…' ||
      checks.goLabel !== 'Go!' ||
      !checks.bridgeReady ||
      !checks.dropBridgeReady ||
      !checks.dropHint?.includes('Drop a folder') ||
      checks.droppedItemCount !== 1 ||
      checks.droppedItemRoot !== dropRoot
    ) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    await fsp.rm(dropRoot, { recursive: true, force: true });
    window.destroy();
    app.quit();
  }
});
