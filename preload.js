const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  printReceipt: (data) => ipcRenderer.send('print-receipt', data),
  openCashDrawer: () => ipcRenderer.send('open-drawer')
});