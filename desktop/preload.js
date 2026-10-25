const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  askFromServerScreen: (payload = {}) => ipcRenderer.invoke('ask-from-server-screen', payload),
  getShortcuts: () => ipcRenderer.invoke('get-shortcuts'),
  updateShortcuts: (shortcuts) => ipcRenderer.invoke('update-shortcuts', shortcuts),
  resetShortcuts: () => ipcRenderer.invoke('reset-shortcuts'),
  syncOverlayWindow: (payload) => ipcRenderer.invoke('sync-overlay-window', payload),
  resizeOverlayWindow: (payload) => ipcRenderer.invoke('resize-overlay-window', payload),
  destroyOverlay: () => ipcRenderer.invoke('destroy-overlay'),
  getOverlayState: () => ipcRenderer.invoke('get-overlay-state'),
  onOverlayState: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('overlay-state', wrapped);
    return () => ipcRenderer.removeListener('overlay-state', wrapped);
  },
  onShortcuts: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('shortcuts-state', wrapped);
    return () => ipcRenderer.removeListener('shortcuts-state', wrapped);
  },
  onFocusTabCommand: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('focus-tab-command', wrapped);
    return () => ipcRenderer.removeListener('focus-tab-command', wrapped);
  },
  onOverlayQuestionCommand: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('overlay-question-command', wrapped);
    return () => ipcRenderer.removeListener('overlay-question-command', wrapped);
  },
  onDesktopToast: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('desktop-toast', wrapped);
    return () => ipcRenderer.removeListener('desktop-toast', wrapped);
  },
  onConfigUpdated: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('config-updated', wrapped);
    return () => ipcRenderer.removeListener('config-updated', wrapped);
  },
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: (opts = {}) => ipcRenderer.invoke('update-check', opts),
  downloadUpdate: (payload) => ipcRenderer.invoke('update-download', payload),
  openUpdateInstaller: (dmgPath) => ipcRenderer.invoke('update-open-installer', dmgPath),
  openReleasePage: () => ipcRenderer.invoke('update-open-release-page'),
  skipUpdateVersion: (version) => ipcRenderer.invoke('update-skip-version', version),
  onUpdateState: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('update-state', wrapped);
    return () => ipcRenderer.removeListener('update-state', wrapped);
  },
});
