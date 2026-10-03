import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { base, state, waitJob, report, probe } from "./verification.mjs";
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.goto(base);
  await page
    .getByLabel("Tên dự án", { exact: true })
    .fill("[TEST one-click redesign " + Date.now() + "]");
  await page
    .getByLabel("Nội dung truyện", { exact: true })
    .fill(
      "Chương 1\nLan đi qua khu rừng.\nChương 2\nÁnh nắng chiếu trên dòng suối.",
    );
  const created = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/studio") &&
      r.request().postDataJSON()?.action === "create",
  );
  await page
    .getByRole("button", { name: "Tạo dự án truyện", exact: true })
    .click();
  const p = await (await created).json();
  await page.getByRole("button", { name: "Chuyển sang Tạo video" }).click();
  await page
    .getByLabel("Engine giọng đọc", { exact: true })
    .selectOption("korva-local");
  await page.getByRole("button", { name: "▶ Nghe thử", exact: true }).click();
  await expect(page.locator("audio")).toHaveCount(1, { timeout: 180000 });
  await expect
    .poll(() => page.locator("audio").evaluate((a) => a.duration > 0))
    .toBe(true);
  await page
    .getByRole("switch", { name: /Tự động tạo ảnh minh họa/ })
    .uncheck();
  await page
    .getByLabel("Ảnh dùng chung", { exact: true })
    .setInputFiles("test-results/forest-photo.jpg");
  await expect(page.getByAltText("Ảnh dùng chung")).toBeVisible();
  const queued = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/studio") &&
      r.request().postDataJSON()?.action === "enqueue",
  );
  await page
    .getByRole("button", { name: "Bắt đầu tạo video", exact: true })
    .click();
  const r = await queued;
  assert.equal(r.status(), 200);
  const jobs = await r.json();
  assert.equal(jobs.length, 2);
  for (const j of jobs) {
    const done = await waitJob(j.id);
    probe(done.output);
  }
  await expect(page.locator("video")).toHaveCount(2, { timeout: 15000 });
  const saved = (await state()).projects.find((x) => x.id === p.id);
  assert.equal(saved.settings.ttsProvider, "korva-local");
  assert.equal(saved.settings.imageEnabled, false);
  await report("one-click", {
    projectId: p.id,
    browserOneClick: true,
    voicePreview: true,
    realMP4: true,
    perChapter: true,
  });
} finally {
  await browser.close();
}
