const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {pathToFileURL}=require('node:url');
async function main(){
  const root=path.resolve(__dirname,'..'),workspace=fs.mkdtempSync(path.join(os.tmpdir(),'storyflow-server-smoke-'));
  const token='fixture-control-token';let logs='';
  const child=spawn(process.execPath,['--import',pathToFileURL(path.join(root,'node_modules/tsx/dist/loader.mjs')).href,path.join(root,'desktop/server.cjs')],{
    cwd:workspace,env:{...process.env,STORYFLOW_CODE_ROOT:root,STORYFLOW_DESKTOP_TOKEN:token,TSX_TSCONFIG_PATH:path.join(root,'tsconfig.json')},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true,
  });
  child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  let url;
  try{
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),90000);child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});child.on('message',m=>{if(m.type==='ready'){clearTimeout(timer);resolve(m.port);}});});
    url='http://127.0.0.1:'+port;
    const control=(action,method='GET')=>fetch(url+'/_storyflow/'+action,{method,headers:{'x-storyflow-token':token}});
    assert.equal((await fetch(url+'/_storyflow/status')).status,403);
    assert.equal((await fetch(url)).status,200);
    const png=await require('sharp')({create:{width:32,height:32,channels:3,background:'blue'}}).png().toBuffer();
    const form=new FormData();form.append('file',new Blob([png],{type:'image/png'}),'fixture.png');
    const image=await(await fetch(url+'/api/upload',{method:'POST',body:form})).json();assert.ok(image.asset);
    const post=async body=>{const r=await fetch(url+'/api/studio',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(r.status,200,JSON.stringify(d));return d;};
    const p=await post({action:'create',name:'desktop runtime',text:'Chương 1\nMột câu chuyện thử.',settings:{ttsProvider:'edge-online',voice:'vi-VN-HoaiMyNeural',audioEnabled:false,imageEnabled:false,burnSubtitles:false,fallbackImage:image.asset}});
    await post({action:'enqueue',projectId:p.id,chapterIds:p.chapters.map(c=>c.id),kind:'pipeline'});
    assert.ok((await(await control('status')).json()).activeJobs>0);
    assert.equal((await control('prepare-update','POST')).status,409);
    const deadline=Date.now()+90000;
    while(true){const d=await(await fetch(url+'/api/studio')).json();const job=d.jobs.find(j=>j.projectId===p.id);if(job.status==='error')throw Error(job.error+' '+logs);if(job.status==='done'){assert.ok(fs.existsSync(path.join(workspace,'data/assets',job.output)));break;}if(Date.now()>deadline)throw Error(logs);await new Promise(r=>setTimeout(r,250));}
    const prepared=await(await control('prepare-update','POST')).json();assert.equal(prepared.ok,true);assert.ok(fs.existsSync(path.join(prepared.backup,'storyflow.sqlite')));
    assert.equal((await fetch(url+'/api/studio',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'create',name:'blocked',text:'blocked'})})).status,503);
    const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(prepared.backup,'storyflow.sqlite'),{readOnly:true});assert.ok(db.prepare('SELECT id FROM records WHERE id=?').get(p.id));db.close();
    console.log('DESKTOP_SERVER_WORKSPACE_MEDIA_BACKUP_PASS');
  }finally{if(url)await fetch(url+'/_storyflow/prepare-update',{method:'POST',headers:{'x-storyflow-token':token}}).catch(()=>{});child.kill();await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});fs.rmSync(workspace,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
