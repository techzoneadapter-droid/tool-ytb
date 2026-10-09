const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const { resolveWorkspace, saveWorkspace, validateWorkspace } = require('./workspace.cjs');
const { DesktopUpdates } = require('./update-controller.cjs');
app.setName('StoryFlow');
app.setPath('userData', path.join(app.getPath('appData'), 'StoryFlow'));
const developmentRoot = path.resolve(__dirname, '..');
const codeRoot = app.isPackaged ? path.join(process.resourcesPath, 'runtime/app') : developmentRoot;
const node = app.isPackaged ? path.join(process.resourcesPath, 'runtime/bin/node.exe') : process.execPath;
const smokeHandoff = path.join(app.getPath('userData'), 'desktop-smoke-handoff.json');
let persistedSmoke;
try { if (fs.existsSync(smokeHandoff)) persistedSmoke = JSON.parse(fs.readFileSync(smokeHandoff, 'utf8')); } catch {}
const smokeOptions = process.env.STORYFLOW_SMOKE_DIR ? {
  directory: process.env.STORYFLOW_SMOKE_DIR, target: process.env.STORYFLOW_SMOKE_TARGET, feed: process.env.STORYFLOW_SMOKE_FEED,
} : persistedSmoke;
const smoke = !!smokeOptions?.directory;
let window, tray, server, url, workspace, updates, quitting = false, installing = false, log;
const token = randomBytes(32).toString('hex');

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(start).catch(error => {
    if (smoke) { fs.mkdirSync(smokeOptions.directory, { recursive: true }); fs.writeFileSync(path.join(smokeOptions.directory, 'error.txt'), error.stack); app.exit(1); return; }
    dialog.showErrorBox('StoryFlow chưa khởi động được', `${error.message}\nNhật ký trong thư mục dữ liệu: data/desktop.log`);
    app.quit();
  });
}
async function control(route, method = 'GET') {
  const response = await fetch(url + '/_storyflow/' + route, {
    method, headers: { 'x-storyflow-token': token }, signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error('Chưa chuẩn bị được dữ liệu để cập nhật.');
  return response.json();
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  child.kill();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Máy chủ chưa dừng.')), 10000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
function state() { return { ...updates.state, workspace }; }
function trusted(event) {
  if (event.sender !== window?.webContents || event.senderFrame?.url?.split('/').slice(0,3).join('/') !== url)
    throw Error('Nguồn yêu cầu không hợp lệ.');
}
async function start() {
  workspace = resolveWorkspace(app.getPath('userData'), app.isPackaged ? path.dirname(app.getPath('exe')) : path.join(developmentRoot, 'dist'), process.env.STORYFLOW_WORKSPACE);
  if (app.isPackaged && process.env.STORYFLOW_WORKSPACE) saveWorkspace(app.getPath('userData'), workspace, path.dirname(app.getPath('exe')));
  // Source mode retains its existing workspace; packaged mode is independent of the install directory.
  if (!app.isPackaged && !process.env.STORYFLOW_WORKSPACE) workspace = developmentRoot;
  if (!fs.existsSync(path.join(codeRoot, '.next/BUILD_ID'))) throw Error('Chưa có bản build giao diện.');
  fs.mkdirSync(path.join(workspace, 'data'), { recursive: true });
  log = fs.openSync(path.join(workspace, 'data/desktop.log'), 'a');
  const env = { ...process.env, STORYFLOW_CODE_ROOT: codeRoot, STORYFLOW_DESKTOP_TOKEN: token, STORYFLOW_WORKSPACE: workspace,
    TSX_TSCONFIG_PATH: path.join(codeRoot, 'tsconfig.json'), ELECTRON_RUN_AS_NODE: '1' };
  if (app.isPackaged) {
    env.FFMPEG_PATH = path.join(process.resourcesPath, 'runtime/bin/ffmpeg.exe');
    env.FFPROBE_PATH = path.join(process.resourcesPath, 'runtime/bin/ffprobe.exe');
  }
  server = spawn(node, ['--import', pathToFileURL(path.join(codeRoot, 'node_modules/tsx/dist/loader.mjs')).href,
    path.join(codeRoot, 'desktop/server.cjs')], { cwd: workspace, env, stdio: ['ignore', log, log, 'ipc'], windowsHide: true });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Máy chủ chưa sẵn sàng sau 180 giây.')), 180000);
    server.once('error', reject);
    server.once('exit', code => { clearTimeout(timer); reject(Error(`Máy chủ đã dừng (${code}).`)); });
    server.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(message.port); } });
  });
  url = 'http://127.0.0.1:' + port;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  // A loopback feed is permitted only in the installed Windows smoke test.
  if (smoke && smokeOptions.feed) {
    const feed = new URL(smokeOptions.feed);
    if (feed.protocol !== 'http:' || feed.hostname !== '127.0.0.1') throw Error('Smoke feed phải ở loopback.');
    autoUpdater.setFeedURL({ provider: 'generic', url: feed.href });
  }
  updates = new DesktopUpdates({ updater: autoUpdater, version: app.getVersion(), installed: app.isPackaged && process.platform === 'win32',
    isBusy: async () => (await control('status')).activeJobs > 0,
    prepareInstall: () => control('prepare-update', 'POST'),
    install: async () => { installing = true; await stopServer(); quitting = true; autoUpdater.quitAndInstall(true, true); },
  });
  if (smoke) updates.on('failure', error => fs.writeFileSync(path.join(smokeOptions.directory, 'error.txt'), String(error?.stack || error || 'Update failed')));
  window = new BrowserWindow({ show: !smoke, width: 1440, height: 950, minWidth: 1000, minHeight: 650, title: 'StoryFlow',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== url) event.preventDefault(); });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  updates.on('state', () => window?.webContents.send('storyflow:state', state()));
  ipcMain.handle('storyflow:state', event => { trusted(event); return state(); });
  ipcMain.handle('storyflow:update', event => { trusted(event); void updates.request(); return state(); });
  ipcMain.handle('storyflow:workspace', async event => {
    trusted(event);
    if ((await control('status')).activeJobs > 0) { dialog.showErrorBox('StoryFlow', 'Đợi tác vụ hoàn thành trước khi đổi thư mục dữ liệu.'); return; }
    const selected = await dialog.showOpenDialog(window, { title: 'Chọn thư mục dự án cũ hoặc thư mục lưu dữ liệu', defaultPath: workspace, properties: ['openDirectory', 'createDirectory'] });
    if (selected.canceled) return;
    const chosen = validateWorkspace(selected.filePaths[0], path.dirname(app.getPath('exe')));
    if (chosen === workspace) return;
    await control('prepare-update', 'POST');
    saveWorkspace(app.getPath('userData'), chosen, path.dirname(app.getPath('exe')));
    installing = true; await stopServer(); quitting = true; app.relaunch(); app.quit();
  });
  const rgba = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 110; rgba[i+1] = 73; rgba[i+2] = 235; rgba[i+3] = 255; }
  tray = new Tray(nativeImage.createFromBitmap(rgba, { width: 32, height: 32 }));
  tray.setToolTip('StoryFlow · đang chạy nền');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mở StoryFlow', click: () => { window.show(); window.focus(); } },
    { label: 'Cập nhật', click: () => { window.show(); void updates.request(); } },
    { label: 'Ẩn cửa sổ', click: () => window.hide() },
    { type: 'separator' },
    { label: 'Thoát giao diện (tác vụ nền tiếp tục)', click: () => app.quit() },
  ]));
  tray.on('double-click', () => { window.show(); window.focus(); });
  await window.loadURL(url);
  if (smoke) await runSmoke();
}
async function runSmoke() {
  const directory = smokeOptions.directory;
  fs.mkdirSync(directory, { recursive: true });
  const execute = script => window.webContents.executeJavaScript(script);
  const target = smokeOptions.target;
  const first = app.getVersion() !== target;
  const wait = async predicate => { const deadline = Date.now()+120000; while (!(await predicate())) { if (Date.now()>deadline) throw Error('Smoke timeout.'); await new Promise(resolve=>setTimeout(resolve,250)); } };
  await wait(() => execute(`!!window.storyflowDesktop && document.body.innerText.includes('Cập nhật')`));
  const saved = path.join(directory, 'fixture.json');
  let fixture;
  if (first) {
    fixture = await execute(`(async()=>{
      async function post(body){const r=await fetch('/api/studio',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(JSON.stringify(d));return d;}
      const form=new FormData();const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAO0lEQVRIiWMon+lCU8QwasHM0SByGU1F5aMZzWW0qCgfLU1njlY45aNV5szRVoXLaMNr5mjT0WVQt64Bu1lQTAQ+eykAAAAASUVORK5CYII='),c=>c.charCodeAt(0));form.append('file',new Blob([bytes],{type:'image/png'}),'test.png');
      const uploaded=await (await fetch('/api/upload',{method:'POST',body:form})).json();if(!uploaded.asset)throw Error('Upload failed');
      const p=await post({action:'create',name:'Windows installer smoke',text:'Chương 1\\nMột câu chuyện thử nghiệm.',settings:{ttsProvider:'edge-online',voice:'vi-VN-HoaiMyNeural',audioEnabled:false,imageEnabled:true,burnSubtitles:false,fallbackImage:uploaded.asset}});
      await post({action:'enqueue',projectId:p.id,chapterIds:p.chapters.map(c=>c.id),kind:'pipeline'});return {id:p.id,image:uploaded.asset};
    })()`);
    await wait(async () => { const result=await execute(`fetch('/api/studio').then(r=>r.json())`); const job=result.jobs.find(j=>j.projectId===fixture.id); if(job?.status==='error')throw Error(job.error); return job?.status==='done'&&job.verified; });
    fs.writeFileSync(saved, JSON.stringify(fixture));
    const screenshot = await window.webContents.capturePage(); fs.writeFileSync(path.join(directory,'before-update.png'), screenshot.toPNG());
    // NSIS restarts via the Windows shell, which need not preserve the launcher's environment.
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(smokeHandoff, JSON.stringify(smokeOptions));
    await execute(`document.querySelector('[data-storyflow-update]').click()`);
  } else {
    fixture=JSON.parse(fs.readFileSync(saved,'utf8'));
    const data=await execute(`fetch('/api/studio').then(r=>r.json())`);
    const project=data.projects.find(p=>p.id===fixture.id), job=data.jobs.find(j=>j.projectId===fixture.id);
    if(!project || project.settings.fallbackImage!==fixture.image || !job?.verified || job.status!=='done')throw Error('Data did not survive update');
    if(!fs.existsSync(path.join(workspace,'data/assets',fixture.image)) || !fs.existsSync(path.join(workspace,'data/assets',job.output)))throw Error('Media missing after update');
    const screenshot=await window.webContents.capturePage();fs.writeFileSync(path.join(directory,'after-update.png'),screenshot.toPNG());
    await control('prepare-update','POST');
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({ok:true,version:app.getVersion(),workspace,projectId:project.id,video:job.output,updateButton:true,backups:fs.readdirSync(path.join(workspace,'backups'))}));
    fs.rmSync(smokeHandoff, { force: true });
    installing=true;await stopServer();quitting=true;app.quit();
  }
}
app.on('before-quit', () => { quitting = true; updates?.dispose(); if (!installing) server?.kill(); if(log!==undefined){fs.closeSync(log);log=undefined;} });
app.on('window-all-closed', () => { if(quitting)app.quit(); });
