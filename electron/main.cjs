const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require('electron');
const { compressFiles, describeFiles, describePaths, listPngFiles } = require('./compression.cjs');

let mainWindow;
let activeState = null;

function enginePath() {
  const resources = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', 'resources');
  return path.join(resources, 'bin', 'oxipng', 'oxipng.exe');
}

function createWindow() {
  const smokeOutput = process.env.PNGOO_SMOKE_OUTPUT;
  mainWindow = new BrowserWindow({
    width: 920,
    height: 650,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#17191d',
    title: 'PNGoo Desktop',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (!smokeOutput) mainWindow.show();
  });
  if (smokeOutput) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const renderer = await mainWindow.webContents.executeJavaScript(`({
          title: document.title,
          mode: document.querySelector('.lossless')?.textContent.trim(),
          addFilesLabel: document.querySelector('#addFilesButton')?.textContent,
          bridgeReady: typeof window.pngoo?.startCompression === 'function',
          dropBridgeReady: typeof window.pngoo?.getPathForFile === 'function' && typeof window.pngoo?.describeDroppedPaths === 'function',
          dropHintReady: document.querySelector('#emptyState span')?.textContent.includes('Drop a folder') === true
        })`);
        fs.writeFileSync(smokeOutput, JSON.stringify({
          ...renderer,
          engineExists: fs.existsSync(enginePath()),
          packaged: app.isPackaged,
          version: app.getVersion()
        }));
      } catch (error) {
        fs.writeFileSync(smokeOutput, JSON.stringify({ error: error.message }));
        process.exitCode = 1;
      } finally {
        app.quit();
      }
    });
  }
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('files:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Add PNG files',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PNG images', extensions: ['png'] }]
  });
  return result.canceled ? [] : describeFiles(result.filePaths);
});

ipcMain.handle('folder:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder of PNG images',
    properties: ['openDirectory']
  });
  if (result.canceled) return [];
  const root = result.filePaths[0];
  return describeFiles(await listPngFiles(root), root);
});

ipcMain.handle('paths:describe', async (_event, droppedPaths) => {
  return describePaths(Array.isArray(droppedPaths) ? droppedPaths : []);
});

ipcMain.handle('output:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose output directory',
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('compression:start', async (event, payload) => {
  if (activeState) throw new Error('Another compression run is already active.');
  activeState = { cancelled: false, child: null };
  try {
    return await compressFiles(payload, enginePath(), activeState, progress => {
      if (!event.sender.isDestroyed()) event.sender.send('compression:progress', progress);
    });
  } finally {
    activeState = null;
  }
});

ipcMain.on('compression:cancel', () => {
  if (!activeState) return;
  activeState.cancelled = true;
  if (activeState.child) activeState.child.kill();
});

ipcMain.handle('path:open', async (_event, targetPath) => {
  if (!targetPath) return '';
  return shell.openPath(targetPath);
});
