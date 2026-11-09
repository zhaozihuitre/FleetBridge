const { contextBridge, ipcRenderer } = require('electron');

// The only surface our pages get: no Node, just these window controls.
contextBridge.exposeInMainWorld('opsBridge', {
  win: (action) => ipcRenderer.send('ops:win', String(action)),
  setHeight: (px) => ipcRenderer.send('ops:height', Number(px)),
  openMain: (term) => ipcRenderer.send('ops:open-main', term ? String(term) : null),
  action: (name) => ipcRenderer.send('ops:action', String(name)),
  quit: () => ipcRenderer.send('ops:quit'),
  // the tray icon's state: 'idle' | 'busy' | 'wait'; still: one frame (reduce motion)
  trayState: (state, still) => ipcRenderer.send('ops:tray', String(state), Boolean(still)),
  // tag: handed back to onNotifyClick when the toast is clicked (which terminal it is about)
  notify: (title, body, tag) => ipcRenderer.send('ops:notify', String(title), String(body), tag ? String(tag) : ''),
  onNotifyClick: (fn) => ipcRenderer.on('ops:notify-click', (_e, tag) => fn(String(tag || ''))),
  onSettings: (fn) => ipcRenderer.on('ops:settings', (_e, s) => fn(s || {})),
});
