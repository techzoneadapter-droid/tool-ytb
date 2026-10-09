const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
async function main(){
  const install=process.env.STORYFLOW_SMOKE_EXE;
  const dist=path.resolve('dist');
  const directory=path.resolve('dist/desktop-smoke');
  fs.mkdirSync(directory,{recursive:true});
  if(!install)throw Error('STORYFLOW_SMOKE_EXE is required');
  const target=require('../package.json').version;
  const server=http.createServer((req,res)=>{
    const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname.slice(1));
    if(!name || name!==path.basename(name) || !/\.(yml|exe|blockmap)$/.test(name)){res.writeHead(404);res.end();return;}
    const file=path.join(dist,name);
    if(!fs.existsSync(file)){res.writeHead(404);res.end();return;}
    const size=fs.statSync(file).size;
    // Updater can request byte ranges for its differential download.
    const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
    if(range){const start=+range[1],end=range[2]?+range[2]:size-1;res.writeHead(206,{'content-range':`bytes ${start}-${end}/${size}`,'content-length':end-start+1,'accept-ranges':'bytes'});fs.createReadStream(file,{start,end}).pipe(res);}
    else{res.writeHead(200,{'content-length':size,'accept-ranges':'bytes'});fs.createReadStream(file).pipe(res);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const child=spawn(install,['--smoke-test'],{env:{...process.env,STORYFLOW_SMOKE_DIR:directory,STORYFLOW_SMOKE_TARGET:target,STORYFLOW_SMOKE_FEED:`http://127.0.0.1:${server.address().port}/`,STORYFLOW_WORKSPACE:path.join(directory,'workspace')},windowsHide:true,stdio:'ignore'});
  child.on('error',error=>fs.writeFileSync(path.join(directory,'error.txt'),error.stack));
  try{
    const deadline=Date.now()+240000;
    while(!fs.existsSync(path.join(directory,'result.json'))){
      if(fs.existsSync(path.join(directory,'error.txt')))throw Error(fs.readFileSync(path.join(directory,'error.txt'),'utf8'));
      if(Date.now()>deadline)throw Error('Installed app/update smoke timed out; see workspace/data/desktop.log');
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    const result=JSON.parse(fs.readFileSync(path.join(directory,'result.json')));
    if(!result.ok || result.version!==target || result.backups.length<2)throw Error('Update/persistence verification failed');
    console.log('WINDOWS_INSTALL_UPDATE_PERSISTENCE_PASS '+JSON.stringify(result));
  }finally{server.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
