import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {base,state,report} from './verification.mjs';
const data=await state();
const project=data.projects.find(p=>p.name.startsWith('[TEST'));
assert.ok(project);
const browser=await chromium.launch({channel:'msedge',headless:true});
const errors=[];
try {
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.getByRole('button',{name:'Tạo video',exact:true}).click();
 await page.getByLabel('Chọn dự án truyện').selectOption(project.id);
 for(const [provider,count] of [['vieneu-local',25],['korva-local',10]]) {
   await page.getByLabel('Engine giọng đọc',{exact:true}).selectOption(provider);
   await expect(page.getByLabel('Giọng',{exact:true}).locator('option')).toHaveCount(count);
   await page.getByRole('button',{name:'▶ Nghe thử',exact:true}).click();
   await expect(page.locator('audio')).toBeVisible({timeout:120000});
   await page.locator('audio').evaluate(a=>a.play());
   await expect.poll(()=>page.locator('audio').evaluate(a=>a.currentTime)).toBeGreaterThan(0);
   let requests=0;page.on('request',r=>{if(r.url().includes('/api/tts/preview'))requests++});
   await page.getByRole('button',{name:'▶ Nghe thử',exact:true}).click();
   assert.equal(requests,0,'second click plays browser cache without API');
 }
 assert.deepEqual(errors,[]);
 await report('voices-ui',{vieneu:25,korva:10,playback:'PASS',browserCache:'PASS',errors});
} finally {await browser.close()}
