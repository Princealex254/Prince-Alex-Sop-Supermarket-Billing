const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
// Example hardware library: npm install escpos escpos-usb
// const escpos = require('escpos');
// escpos.USB = require('escpos-usb');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('index.html');
}

app.whenReady().then(createWindow);

// Handle silent thermal printing
ipcMain.on('print-receipt', (event, htmlContent) => {
  console.log('Native Print Triggered');
  // Logic to send raw ESC/POS commands to USB printer goes here
  // const device  = new escpos.USB();
  // const printer = new escpos.Printer(device);
  // device.open(() => {
  //   printer.text(htmlContent).cut().close();
  // });
});

// Handle cash drawer kick
ipcMain.on('open-drawer', () => {
  console.log('Kicking Cash Drawer');
  // ESC/POS command for opening drawer: ASCII ESC p m t1 t2
  // const device  = new escpos.USB();
  // const printer = new escpos.Printer(device);
  // device.open(() => {
  //   printer.cashdraw().close();
  // });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});