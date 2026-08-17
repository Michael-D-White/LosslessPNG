const path = require('node:path');
const fsp = require('node:fs/promises');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
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
    const checks = await window.webContents.executeJavaScript(`({
      title: document.title,
      mode: document.querySelector('.lossless')?.textContent.trim(),
      addFilesLabel: document.querySelector('#addFilesButton')?.textContent,
      goLabel: document.querySelector('#goButton')?.textContent,
      bridgeReady: typeof window.pngoo?.pickFiles === 'function',
      bodyWidth: document.body.scrollWidth,
      bodyHeight: document.body.scrollHeight
    })`);
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
      !checks.bridgeReady
    ) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
