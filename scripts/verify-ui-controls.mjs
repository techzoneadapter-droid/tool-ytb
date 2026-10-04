import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = 'http://127.0.0.1:3000';
const data = await fetch(`${base}/api/studio`).then(r => r.json());
const project = structuredClone(data.projects[0]);
assert.ok(project, 'An existing project is required for the UI fixture');
project.settings.imageProvider = 'flow-browser';
const fixture = { ...data, projects: [project], jobs: [{
  id: 'ui-fixture', projectId: project.id, chapterIds: [project.chapters[0].id],
  kind: 'pipeline', status: 'images', progress: 40, message: 'UI fixture',
  createdAt: new Date().toISOString(), snapshot: { settings: project.settings },
}] };
const actions = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/api/studio', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: fixture });
    const body = route.request().postDataJSON();
    actions.push(body.action);
    if (body.action === 'initializeFlowSession') return route.fulfill({ json: { ok: true, status: { connected: true, state: 'ready' } } });
    throw Error(`Unexpected mutation: ${body.action}`);
  });
  await page.goto(base);
  await page.getByRole('button', { name: 'Tạo video', exact: true }).click();
  await page.getByText('Quản lý tác vụ hiện tại', { exact: true }).waitFor();
  assert.equal(await page.locator('fieldset.config-fields').isDisabled(), false);
  assert.equal(await page.getByRole('button', { name: 'Chọn tất cả', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Đang có tác vụ', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Quản lý tác vụ hiện tại', exact: true }).click();
  await page.locator('#flow-cookie-json').fill('[]');
  await page.getByRole('button', { name: 'Kết nối bằng cookie', exact: true }).click();
  await page.waitForTimeout(300);
  assert.deepEqual(actions, ['initializeFlowSession'], 'Connecting must not enqueue videos');
  fixture.jobs = [];
  await page.getByRole('button', { name: 'Bắt đầu tạo video', exact: true }).waitFor({ timeout: 15000 });
  assert.equal(await page.getByRole('button', { name: 'Bắt đầu tạo video', exact: true }).isEnabled(), true);
  console.log('PASS: editable settings during jobs, visible job controls, no automatic enqueue, controls unlock after jobs finish');
} finally { await browser.close(); }
