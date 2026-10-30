const { contextBridge, ipcRenderer } = require('electron');

// The only surface our pages get: no Node, just these window controls.
contextBridge.exposeInMainWorld('opsBridge', {
  win: (action) => ipcRenderer.send('ops:win', String(action)),
  setHeight: (px) => ipcRenderer.send('ops:height', Number(px)),
  openMain: (term) => ipcRenderer.send('ops:open-main', term ? String(term) : null),
  action: (name) => ipcRenderer.send('ops:action', String(name)),
  quit: () => ipcRenderer.send('ops:quit'),
  notify: (title, body) => ipcRenderer.send('ops:notify', String(title), String(body)),
  onSettings: (fn) => ipcRenderer.on('ops:settings', (_e, s) => fn(s || {})),
});
