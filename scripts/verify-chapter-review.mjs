import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {state,post,photo,waitJob,report} from './verification.mjs';
// Restart only an idle worker so this verification loads the latest source.
assert.ok(!(await state()).jobs.some(j=>['queued','audio','images','rendering'].includes(j.status)));
const pid=Number(await readFile('data/worker.lock','utf8'));
process.kill(pid,'SIGTERM');
await new Promise(r=>setTimeout(r,1000));
await post({action:'startService',service:'worker'});
const p=await post({action:'create',name:'[TEST chapter review '+Date.now()+']',text:'Chương 1\nLan đi qua khu rừng.\nChương 2\nÁnh nắng chiếu trên dòng suối.',settings:{ttsProvider:'korva-local',voice:'ngoc_huyen',imageEnabled:false,fallbackImage:await photo(),humanCheck:true}});
const jobs=await post({action:'enqueue',kind:'pipeline',projectId:p.id,chapterIds:p.chapters.map(c=>c.id),merge:false});
for(const j of jobs)await waitJob(j.id,'paused');
for(const j of jobs){await post({action:'approve',projectId:p.id,chapterIds:j.chapterIds});await post({action:'resume',id:j.id});const done=await waitJob(j.id);assert.ok(done.startedAt);assert.ok(done.finishedAt);}
let saved=(await state()).projects.find(x=>x.id===p.id);const images=saved.chapters.flatMap(c=>c.scenes).map(s=>s.image);
await post({action:'settings',projectId:p.id,settings:{...saved.settings,voice:'bao_kim'}});
saved=(await state()).projects.find(x=>x.id===p.id);assert.ok(saved.chapters.every(c=>c.scenes.every(s=>!s.audio)));assert.deepEqual(saved.chapters.flatMap(c=>c.scenes).map(s=>s.image),images);
await post({action:'settings',projectId:p.id,settings:{...saved.settings,style:'Tu tiên',aspect:'9:16'}});
saved=(await state()).projects.find(x=>x.id===p.id);assert.deepEqual(saved.chapters.flatMap(c=>c.scenes).map(s=>s.image),images);assert.ok(saved.chapters.every(c=>c.scenes.every(s=>s.prompt.includes('Chapter context:')&&!s.motion)));
await report('chapter-review',{multiplePausedChaptersResume:true,scopedApproval:true,timestamps:true,voiceInvalidatesOnlyAudio:true,uploadedImagesPreserved:true});
