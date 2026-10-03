import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {base,state,post,photo,waitJob,report} from './verification.mjs';
const p=await post({action:'create',name:'[TEST UI retry '+Date.now()+']',text:'Lan đi qua khu rừng.',settings:{ttsProvider:'korva-local',voice:'ngoc_huyen',audioEnabled:false,imageEnabled:false}});
const [j]=await post({action:'enqueue',kind:'pipeline',projectId:p.id,chapterIds:p.chapters.map(c=>c.id),merge:true});await waitJob(j.id,'error');
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage();page.setDefaultTimeout(60000);await page.goto(base);await page.getByRole('button',{name:'Tạo video',exact:true}).click();await page.getByLabel('Chọn dự án truyện').selectOption(p.id);
 await page.getByRole('switch',{name:/Tự động tạo lời đọc/}).check();
 await page.getByLabel('Ảnh dùng chung',{exact:true}).setInputFiles('test-results/forest-photo.jpg');await expect(page.getByAltText('Ảnh dùng chung')).toBeVisible();
 const retried=page.waitForResponse(r=>r.url().endsWith('/api/studio')&&r.request().postDataJSON()?.action==='retry');
 await page.getByRole('button',{name:'Thử lại phần lỗi',exact:true}).click();assert.equal((await retried).status(),200);const done=await waitJob(j.id);assert.equal(done.verified,true);
 await expect(page.locator('video')).toHaveCount(1,{timeout:15000});const current=(await state()).projects.find(x=>x.id===p.id);assert.equal(current.settings.audioEnabled,true);assert.ok(current.settings.fallbackImage);await report('ui-retry',{retryUsesEditedSettings:true,realOutput:done.output});
}finally{await browser.close();}
