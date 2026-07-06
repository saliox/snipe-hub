// Pont sécurisé renderer <-> main (contextIsolation activé).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  version: () => ipcRenderer.invoke('app:version'),
  platforms: () => ipcRenderer.invoke('platforms:list'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateApply: () => ipcRenderer.invoke('update:apply'),

  info: (pid) => ipcRenderer.invoke('pf:info', pid),
  whoami: (pid) => ipcRenderer.invoke('pf:whoami', pid),
  login: (pid, arg) => ipcRenderer.invoke('pf:login', pid, arg),
  logout: (pid) => ipcRenderer.invoke('pf:logout', pid),
  setToken: (pid, token, isUser) => ipcRenderer.invoke('pf:setToken', pid, token, isUser),
  check: (pid, name) => ipcRenderer.invoke('pf:check', pid, name),
  snipe: (pid, opts) => ipcRenderer.invoke('pf:snipe', pid, opts),
  stop: () => ipcRenderer.invoke('pf:stop'),

  accounts: (pid) => ipcRenderer.invoke('pf:accounts', pid),
  accountSetActive: (pid, id) => ipcRenderer.invoke('pf:accountSetActive', pid, id),
  accountRemove: (pid, id) => ipcRenderer.invoke('pf:accountRemove', pid, id),

  bulk: (pid, payload) => ipcRenderer.invoke('pf:bulk', pid, payload),
  onBulk: (cb) => ipcRenderer.on('bulk', (_e, d) => cb(d)),

  watchGet: () => ipcRenderer.invoke('watch:get'),
  watchAdd: (item) => ipcRenderer.invoke('watch:add', item),
  watchRemove: (platform, name) => ipcRenderer.invoke('watch:remove', platform, name),
  watchClear: () => ipcRenderer.invoke('watch:clear'),
  watchMonitor: (on) => ipcRenderer.invoke('watch:monitor', on),
  onWatchFree: (cb) => ipcRenderer.on('watch-free', (_e, d) => cb(d)),

  onLog: (cb) => ipcRenderer.on('log', (_e, d) => cb(d)),
  onUpdate: (cb) => ipcRenderer.on('update-status', (_e, d) => cb(d)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_e, d) => cb(d)),
});
