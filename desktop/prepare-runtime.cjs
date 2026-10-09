const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
async function main() {
  const root = path.resolve(__dirname,'..');
  const stage = path.join(root,'.desktop-payload');
  const code = path.join(stage,'runtime/app');
  const shell = path.join(stage,'shell');
  const pkg = require(path.join(root,'package.json'));
  if (!fs.existsSync(path.join(root,'.next/BUILD_ID'))) throw Error('Build Next trước khi đóng gói.');
  fs.rmSync(code,{recursive:true,force:true});fs.rmSync(shell,{recursive:true,force:true});
  fs.mkdirSync(code,{recursive:true});fs.mkdirSync(shell,{recursive:true});
  for(const name of ['modules','scripts','workers','tsconfig.json','.next','public','docs'])
    fs.cpSync(path.join(root,name),path.join(code,name),{recursive:true,filter:source=>!source.includes(`${path.sep}.next${path.sep}cache`) && !source.includes(`${path.sep}public${path.sep}generated`) && !source.includes('__pycache__')});
  fs.mkdirSync(path.join(code,'desktop'),{recursive:true});fs.copyFileSync(path.join(root,'desktop/server.cjs'),path.join(code,'desktop/server.cjs'));
  fs.writeFileSync(path.join(code,'next.config.js'),'module.exports={devIndicators:false,serverExternalPackages:["mammoth","sharp"]};\n');
  const runtimePackage={...pkg};delete runtimePackage.scripts;delete runtimePackage.devDependencies;delete runtimePackage.main;
  fs.writeFileSync(path.join(code,'package.json'),JSON.stringify(runtimePackage));
  // Reuse the committed lockfile; omit dev tools and never ship environment/key/data files.
  fs.copyFileSync(path.join(root,'package-lock.json'),path.join(code,'package-lock.json'));
  const npm=process.platform==='win32'?'npm.cmd':'npm';
  const run=(args,cwd)=>execFileSync(npm,args,{cwd,stdio:'inherit',shell:process.platform==='win32',env:{...process.env,PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1'}});
  run(['ci','--omit=dev','--ignore-scripts'],code);
  fs.cpSync(path.join(root,'desktop'),path.join(shell,'desktop'),{recursive:true});
  fs.writeFileSync(path.join(shell,'package.json'),JSON.stringify({name:pkg.name,version:pkg.version,description:pkg.description,author:pkg.author,main:pkg.main,dependencies:{'electron-updater':pkg.dependencies['electron-updater']}}));
  run(['install','--omit=dev','--ignore-scripts'],shell);
  fs.mkdirSync(path.join(stage,'icons'),{recursive:true});
  const sharp=require('sharp');
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" rx="52" fill="#6e49eb"/><path d="M54 59h54q20 0 20 18v125q-12-16-30-16H54zm148 0h-54q-20 0-20 18v125q12-16 30-16h44z" fill="white"/><path d="M112 98v60l43-30z" fill="#6e49eb"/></svg>';
  const png=await sharp(Buffer.from(svg)).png().toBuffer();const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header[6]=0;header[7]=0;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
  fs.writeFileSync(path.join(stage,'icons/icon.ico'),Buffer.concat([header,png]));
  const bin=path.join(stage,'runtime/bin');fs.mkdirSync(bin,{recursive:true});
  if(process.platform==='win32')fs.copyFileSync(process.execPath,path.join(bin,'node.exe'));
  for(const name of ['node.exe','ffmpeg.exe','ffprobe.exe'])if(!fs.existsSync(path.join(bin,name)))throw Error('Thiếu runtime '+name+'; chạy desktop/prepare-windows.ps1.');
  console.log('DESKTOP_PAYLOAD_READY');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
