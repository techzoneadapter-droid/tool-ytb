import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import sharp from 'sharp';
import {post,state,waitJob,probe,report} from './verification.mjs';
// Never downloads weights. Run only after the user installs/confirms a local model.
const p=await post({action:'create',name:'[TEST real images '+Date.now()+']',text:'Chapter I\n'+('Lan walks through a forest, pauses beside a river and reaches the mountain. ').repeat(17),settings:{ttsProvider:'korva-local',voice:'ngoc_huyen',imageProvider:'local-fast',imageEnabled:true,burnSubtitles:true}});
const chapter=p.chapters[0];
// Three real scenes via the existing scene planning action is source-driven; use imported paragraphs.
assert.ok(chapter.scenes.length>=3,'Fixture must be split into at least three scenes before real test');
const captions=['Lan walks through a green forest.','Lan stops beside a blue river.','Lan reaches a misty mountain.'];
for(const [i,scene] of chapter.scenes.entries())await post({action:'scene',projectId:p.id,chapterId:chapter.id,scene:{...scene,text:captions[i%3],prompt:captions[i%3]}});
await post({action:'visualProfile',projectId:p.id,chapterId:chapter.id,profile:{...chapter.visualProfile,characters:[{name:'Lan',descriptor:'young Vietnamese woman with straight black hair, white shirt and blue trousers'}],visualNotes:'Rural Vietnam, morning, natural daylight'}});
const [job]=await post({action:'enqueue',projectId:p.id,chapterIds:[chapter.id],kind:'pipeline',merge:true});
const done=await waitJob(job.id);probe(done.output);
const saved=(await state()).projects.find(x=>x.id===p.id);
for(const s of saved.chapters[0].scenes){const bytes=await readFile('data/assets/'+s.image);await sharp(bytes).stats();assert.ok(s.finalImagePrompt && Number.isInteger(s.imageSeed) && s.imageModel==='stabilityai/sd-turbo');}
assert.equal(new Set(saved.chapters[0].scenes.map(s=>s.finalImagePrompt)).size,chapter.scenes.length);
await writeFile('data/fast-benchmark.json',JSON.stringify({passed:true,model:'stabilityai/sd-turbo',projectId:p.id,at:new Date().toISOString()}));
await report('image-consistency',{projectId:p.id,images:'REAL PASS',fullVideo:'PASS',consistency:'prompt/context/seed verified; visual face matching requires human review'});
