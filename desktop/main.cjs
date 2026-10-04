const { app, BrowserWindow, Tray, Menu, nativeImage, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const url = 'http://127.0.0.1:3000';
let window, tray, server, quitting = false, log;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(start).catch(error => {
    if (process.argv.includes('--smoke-test')) { console.error(error.message); app.exit(1); return; }
    dialog.showErrorBox('StoryFlow chưa khởi động được', `${error.message}\nNhật ký: data/desktop.log`);
    app.quit();
  });
}
async function ready() {
  try { const response = await fetch(`${url}/api/studio`, { signal: AbortSignal.timeout(2000) }); return response.ok; }
  catch { return false; }
}
async function start() {
  process.chdir(root);
  if (!(await ready())) {
    if (!fs.existsSync(path.join(root, '.next', 'BUILD_ID')))
      throw Error('Chạy npm run build trước khi mở desktop, hoặc npm run dev để dùng bản phát triển.');
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    log = fs.openSync(path.join(root, 'data/desktop.log'), 'a');
    // Use Electron's bundled Node for the existing server and worker scripts.
    server = spawn(process.execPath, ['--import', 'tsx', 'scripts/app.ts', '--production'], {
      cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', log, log], windowsHide: true,
    });
    let failed;
    server.on('error', error => { failed = error; });
    server.on('exit', code => {
      failed = Error(`Máy chủ đã dừng (${code}).`);
      if (window && !quitting) { dialog.showErrorBox('StoryFlow', failed.message); app.quit(); }
    });
    const deadline = Date.now() + 90000;
    while (!(await ready())) {
      if (failed) throw failed;
      if (Date.now() > deadline) throw Error('Máy chủ chưa sẵn sàng sau 90 giây. Kiểm tra cổng 3000 và nhật ký.');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  window = new BrowserWindow({
    show: !process.argv.includes('--smoke-test'),
    width: 1440, height: 950, minWidth: 1000, minHeight: 650, title: 'StoryFlow',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== url) event.preventDefault();
  });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  if (process.argv.includes('--smoke-test')) {
    await window.loadURL(url);
    console.log('DESKTOP_READY');
    app.quit();
    return;
  }
  // Small generated application icon; no external assets needed.
  const rgba = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 110; rgba[i + 1] = 73; rgba[i + 2] = 235; rgba[i + 3] = 255; }
  tray = new Tray(nativeImage.createFromBuffer(rgba, { width: 32, height: 32 }));
  tray.setToolTip('StoryFlow · đang chạy nền');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mở StoryFlow', click: () => { window.show(); window.focus(); } },
    { label: 'Ẩn cửa sổ', click: () => window.hide() },
    { type: 'separator' },
    { label: 'Thoát giao diện (tác vụ nền tiếp tục)', click: () => app.quit() },
  ]));
  tray.on('double-click', () => { window.show(); window.focus(); });
  await window.loadURL(url);
}
app.on('before-quit', () => {
  quitting = true;
  // Only stop the server started by this instance. Detached workers retain jobs.
  server?.kill();
  if (log !== undefined) fs.closeSync(log);
});
app.on('window-all-closed', () => { if (quitting) app.quit(); });
