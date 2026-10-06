import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { state, base, report } from "./verification.mjs";
const data = await state();
const project = data.projects
  .filter((p) =>
    data.jobs.some(
      (j) =>
        j.projectId === p.id &&
        ["audio", "images", "rendering", "queued", "error", "paused"].includes(
          j.status,
        ),
    ),
  )
  .sort((a, b) => b.chapters.length - a.chapters.length)[0];
assert.ok(project, "Need an existing pipeline for read-only UI verification");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.addInitScript(
    (id) => localStorage.setItem("storyflow-project", id),
    project.id,
  );
  await page.goto(base);
  await page.getByRole("button", { name: "Tạo video", exact: true }).click();
  await page.getByLabel("Chọn dự án truyện").selectOption(project.id);
  const panel = page.locator(".batch-progress");
  await expect(panel).toBeVisible();
  assert.equal(await panel.locator(".chapter-progress-row").count(), 0);
  const height = (await panel.boundingBox()).height;
  assert.ok(height >= 150 && height <= 220, `compact height=${height}`);
  const text = await panel.innerText();
  if (project.settings.imageEnabled === false) {
    assert.ok(text.includes("Dùng ảnh chung"));
    for (const x of ["Ảnh master", "Character Bible", "portrait", "gọi API"])
      assert.ok(!text.includes(x));
  }
  await panel.getByRole("button", { name: "Chi tiết", exact: true }).click();
  await expect(panel.locator(".chapter-progress-row").first()).toBeVisible();
  const detailHeight = (
    await panel.locator(".batch-progress-details").boundingBox()
  ).height;
  assert.ok(detailHeight <= 320);
  const rows = await panel.locator(".chapter-progress-row").count();
  await panel.getByRole("button", { name: "Thu gọn", exact: true }).click();
  assert.equal(await panel.locator(".chapter-progress-row").count(), 0);
  await page.screenshot({
    path: "test-results/compact-progress.png",
    fullPage: false,
  });
  await report("compact-progress-browser", {
    passed: true,
    projectId: project.id,
    chapters: project.chapters.length,
    compactHeight: height,
    detailsHeight: detailHeight,
    detailRows: rows,
  });
} finally {
  await browser.close();
}
