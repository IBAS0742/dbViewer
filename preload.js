const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickDbFile: () => ipcRenderer.invoke('dialog:pick-db'),
  listTables: (path) => ipcRenderer.invoke('db:list-tables', path),
  getSchema: (path, table) => ipcRenderer.invoke('db:get-schema', { path, table }),
  query: (args) => ipcRenderer.invoke('db:query', args),
  exportFull: (args) => ipcRenderer.invoke('db:export', args),
  exportSheets: (args) => ipcRenderer.invoke('export:sheets', args),
  loadConfig: () => ipcRenderer.invoke('app:load-config')
});
