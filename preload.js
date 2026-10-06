const { contextBridge, ipcRenderer } = require('electron');

// 伪装成 Tauri 的 __TAURI__（前端代码不用改）
const fakeWindow = {
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close')
};

contextBridge.exposeInMainWorld('__TAURI__', {
  window: {
    getCurrentWindow: () => fakeWindow
  }
});

// Chronos Seal API
contextBridge.exposeInMainWorld('chronosSeal', {
  githubLogin: (proxyUrl) => ipcRenderer.invoke('github-login', { proxyUrl }),
  deviceFlowStart: () => ipcRenderer.invoke('github-device-flow-start'),
  deviceFlowPoll: (deviceCode, interval) =>
    ipcRenderer.invoke('github-device-flow-poll', { deviceCode, interval }),
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
