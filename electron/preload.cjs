const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pngoo', {
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  pickOutput: () => ipcRenderer.invoke('output:pick'),
  getPathForFile: file => webUtils.getPathForFile(file),
  describeDroppedPaths: paths => ipcRenderer.invoke('paths:describe', paths),
  startCompression: payload => ipcRenderer.invoke('compression:start', payload),
  cancelCompression: () => ipcRenderer.send('compression:cancel'),
  openPath: targetPath => ipcRenderer.invoke('path:open', targetPath),
  onProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('compression:progress', listener);
    return () => ipcRenderer.removeListener('compression:progress', listener);
  }
});
