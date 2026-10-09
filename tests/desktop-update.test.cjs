const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {mkdtempSync,rmSync,writeFileSync,readFileSync}=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
const {DesktopUpdates}=require('../desktop/update-controller.cjs');
const {resolveWorkspace,saveWorkspace}=require('../desktop/workspace.cjs');
function fixture(options={}){
  const updater=new EventEmitter();let checks=0,downloads=0,backups=0,installs=0;
  updater.checkForUpdates=async()=>{checks++;updater.emit(options.current?'update-not-available':'update-available',{version:'1.0.2'});};
  updater.downloadUpdate=async()=>{downloads++;updater.emit('download-progress',{percent:42});updater.emit('update-downloaded');};
  const controller=new DesktopUpdates({updater,version:'1.0.1',installed:true,isBusy:async()=>false,prepareInstall:async()=>{backups++;},install:async()=>{installs++;},retryMs:15,...options});
  return {updater,controller,counts:()=>({checks,downloads,backups,installs})};
}
async function until(predicate){for(let i=0;i<100&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(predicate());}
test('one click checks, downloads, backs up and installs, with no auto-install on normal quit',async()=>{
  const f=fixture();assert.equal(f.updater.autoDownload,false);assert.equal(f.updater.autoInstallOnAppQuit,false);
  await f.controller.request();await until(()=>f.counts().installs===1);assert.deepEqual(f.counts(),{checks:1,downloads:1,backups:1,installs:1});f.controller.dispose();
});
test('downloaded update waits for queued/running work before touching data',async()=>{
  let busy=true;const f=fixture({isBusy:async()=>busy});await f.controller.request();await until(()=>f.controller.state.phase==='waiting');
  assert.equal(f.counts().installs,0);assert.equal(f.counts().backups,0);await f.controller.request();assert.equal(f.counts().checks,1);
  busy=false;await until(()=>f.counts().installs===1);f.controller.dispose();
});
test('failed backup never installs and a retry uses the already verified download',async()=>{
  let fail=true;let backups=0;const f=fixture({prepareInstall:async()=>{backups++;if(fail)throw Error('Disk error');}});
  await f.controller.request();await until(()=>f.controller.state.phase==='error');assert.equal(f.counts().installs,0);
  fail=false;await f.controller.request();await until(()=>f.counts().installs===1);assert.equal(backups,2);assert.equal(f.counts().downloads,1);f.controller.dispose();
});
test('current and source-only builds do not download or install',async()=>{
  const f=fixture({current:true});await f.controller.request();assert.equal(f.controller.state.phase,'current');assert.equal(f.counts().downloads,0);
  const dev=fixture({installed:false});await dev.controller.request();assert.equal(dev.counts().checks,0);f.controller.dispose();dev.controller.dispose();
});
test('workspace preference survives installs without modifying existing story files',()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'storyflow-workspace-'));try{
    const prefs=path.join(directory,'preferences'),install=path.join(directory,'installation'),legacy=path.join(directory,'old-project');
    const chosen=saveWorkspace(prefs,legacy,install);writeFileSync(path.join(chosen,'story.txt'),'existing content');
    assert.equal(resolveWorkspace(prefs,path.join(directory,'new-installation')),chosen);assert.equal(readFileSync(path.join(chosen,'story.txt'),'utf8'),'existing content');
    assert.throws(()=>saveWorkspace(prefs,path.join(install,'data'),install),/bên ngoài/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('update exposes the actual preparation failure and clears it on retry',async()=>{
  let fail=true;
  const f=fixture({prepareInstall:async()=>{if(fail)throw Error('Worker heartbeat đã cũ.');}});
  await f.controller.request();await until(()=>f.controller.state.phase==='error');
  assert.match(f.controller.state.error,/heartbeat/);
  fail=false;await f.controller.request();await until(()=>f.counts().installs===1);
  assert.equal(f.controller.state.error,undefined);f.controller.dispose();
});
test('dead worker locks can be recovered even when heartbeat is missing or malformed',()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'storyflow-dead-worker-'));
  try{
    const server=path.resolve(__dirname,'../desktop/server.cjs');
    execFileSync(process.execPath,['-e',`
      const fs=require('node:fs'),assert=require('node:assert/strict');
      fs.mkdirSync('data');
      const {stopWorker}=require(${JSON.stringify(server)});
      process.kill=()=>{const error=Error('dead');error.code='ESRCH';throw error;};
      (async()=>{
        for(const health of [undefined,'malformed']){
          fs.writeFileSync('data/worker.lock','12345');
          if(health)fs.writeFileSync('data/worker.health.json',health);
          await stopWorker();assert.equal(fs.existsSync('data/worker.lock'),false);
        }
      })().catch(error=>{console.error(error);process.exit(1);});
    `],{cwd:directory,stdio:'pipe'});
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('desktop cannot replace code or workspace while a live VieNeu installer owns the setup lock',()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'storyflow-ai-install-'));
  try{
    const server=path.resolve(__dirname,'../desktop/server.cjs');
    execFileSync(process.execPath,['-e',`
      const fs=require('node:fs'),assert=require('node:assert/strict');
      fs.mkdirSync('data');fs.writeFileSync('data/vieneu-setup.lock',String(process.pid));
      const {activeJobs,prepareUpdate}=require(${JSON.stringify(server)});
      assert.equal(activeJobs(),1);
      assert.rejects(prepareUpdate(),/Tác vụ đang chạy/).catch(error=>{console.error(error);process.exit(1);});
    `],{cwd:directory,stdio:'pipe'});
  }finally{rmSync(directory,{recursive:true,force:true});}
});
