const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { DatabaseSync, backup } = require('node:sqlite');
const codeRoot = process.env.STORYFLOW_CODE_ROOT || path.resolve(__dirname, '..');
const token = process.env.STORYFLOW_DESKTOP_TOKEN;
const workspace = process.cwd();
require(path.join(codeRoot, 'node_modules/dotenv')).config({ path: '.env.local', quiet: true });
require(path.join(codeRoot, 'node_modules/dotenv')).config({ quiet: true });
let preparingUpdate = false;
function activeJobs() {
  const setupCount = ['vieneu-setup.lock', 'ai-setup.pid'].filter(name => {
    try {
      const pid = Number(fs.readFileSync(path.join(workspace, 'data', name), 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) return false;
      process.kill(pid, 0); return true;
    } catch { return false; }
  }).length;
  const file = path.join(workspace, 'data/storyflow.sqlite');
  if (!fs.existsSync(file)) return setupCount;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return setupCount + db.prepare("SELECT body FROM records WHERE kind='job'").all().filter(row => ['queued', 'audio', 'images', 'rendering'].includes(JSON.parse(row.body).status)).length;
  } finally { db.close(); }
}
async function stopWorker() {
  const lock = path.join(workspace, 'data/worker.lock');
  if (!fs.existsSync(lock)) return;
  const pid = Number(fs.readFileSync(lock, 'utf8'));
  if (!Number.isInteger(pid) || pid <= 0) throw Error('Không xác minh được worker.');
  try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { fs.rmSync(lock, { force: true }); return; } throw e; }
  const healthFile = path.join(workspace, 'data/worker.health.json');
  if (!fs.existsSync(healthFile)) throw Error('Worker còn chạy nhưng thiếu heartbeat. Hãy thoát và mở lại app rồi thử lại.');
  const health = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
  if (health.pid !== pid) throw Error('Không xác minh được worker. Hãy thoát và mở lại app rồi thử lại.');
  if (!health.time || Date.now() - health.time > 30000) throw Error('Worker heartbeat đã cũ.');
  try { process.kill(pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { fs.rmSync(lock, { force: true }); return; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Worker chưa dừng.');
}
async function prepareUpdate() {
  if (activeJobs()) throw Error('Tác vụ đang chạy.');
  preparingUpdate = true;
  try {
    await stopWorker();
    const directory = path.join(workspace, 'backups', 'before-update-' + Date.now());
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(workspace, 'data/storyflow.sqlite');
    if (fs.existsSync(file)) {
      const db = new DatabaseSync(file, { readOnly: true });
      try { await backup(db, path.join(directory, 'storyflow.sqlite')); } finally { db.close(); }
    }
    for (const name of ['.env.local', '.env'])
      if (fs.existsSync(path.join(workspace, name))) fs.copyFileSync(path.join(workspace, name), path.join(directory, name));
    return directory;
  } catch (error) { preparingUpdate = false; throw error; }
}
async function main() {
  // The TS loader and code root are explicit; the working directory remains writable data.
  const { startService } = require(path.join(codeRoot, 'modules/providers/services.ts'));
  await startService('worker');
  const next = require(path.join(codeRoot, 'node_modules/next'));
  const app = next({ dev: false, dir: codeRoot, hostname: '127.0.0.1' });
  await app.prepare();
  const handler = app.getRequestHandler();
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').startsWith('/_storyflow/')) {
      if (!token || req.headers['x-storyflow-token'] !== token) { res.writeHead(403); res.end(); return; }
      try {
        const route = new URL(req.url, 'http://localhost').pathname;
        let result;
        if (route === '/_storyflow/status' && req.method === 'GET') result = { ok: true, activeJobs: activeJobs(), workspace };
        else if (route === '/_storyflow/prepare-update' && req.method === 'POST') result = { ok: true, backup: await prepareUpdate() };
        else { res.writeHead(404); res.end(); return; }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
      } catch (error) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: error.message || 'Chưa chuẩn bị được cập nhật.' })); }
      return;
    }
    if (preparingUpdate && req.method !== 'GET') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'App đang cài bản mới. Vui lòng đợi khởi động lại.' })); return;
    }
    handler(req, res);
  });
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    process.send?.({ type: 'ready', port });
    console.log('STORYFLOW_READY port=' + port);
    // Existing VieNeu projects become usable after updating without a terminal.
    if (process.platform === 'win32') {
      const file = path.join(workspace, 'data/storyflow.sqlite');
      if (fs.existsSync(file)) {
        const db = new DatabaseSync(file, { readOnly: true });
        let needsVieNeu = false;
        try { needsVieNeu = db.prepare("SELECT body FROM records WHERE kind='project'").all().some(row => JSON.parse(row.body).settings?.ttsProvider === 'vieneu-local'); }
        finally { db.close(); }
        if (needsVieNeu) {
          const { launchVieneuSetup } = require(path.join(codeRoot, 'modules/providers/vieneu-setup.ts'));
          void launchVieneuSetup().catch(error => console.error('VieNeu setup:', error.message));
        }
      }
    }
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });
module.exports = { activeJobs, prepareUpdate, stopWorker };
