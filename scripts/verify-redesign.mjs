import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { base, state, post, report } from "./verification.mjs";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
const result = {};
await mkdir("test-results", { recursive: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
page.setDefaultTimeout(60000);
expect.configure({ timeout: 15000 });
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("400 (Bad Request)"))
    errors.push(m.text() + " " + m.location().url);
});
try {
  await page.goto(base);
  await expect(
    page.getByRole("heading", { name: "Nhập truyện", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("button")).toHaveCount(3);
  const text =
    "Chương 1: Bình minh\nLan bước vào khu rừng.\nChương II: Dòng suối\nÁnh nắng chiếu trên dòng suối.";
  await page.getByLabel("Nội dung truyện", { exact: true }).fill(text);
  await expect(page.getByText("Đã phát hiện 2 chương")).toBeVisible();
  await page.getByLabel("Tải file truyện", { exact: true }).setInputFiles({
    name: "StoryFlow UI Test.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(text),
  });
  await expect(page.getByLabel("Nội dung truyện", { exact: true })).toHaveValue(
    text,
  );
  result.txt = "PASS";
  await page
    .getByLabel("Tải file truyện", { exact: true })
    .setInputFiles("tests/fixtures/redesign-story.docx");
  await expect(
    page.getByLabel("Nội dung truyện", { exact: true }),
  ).toContainText("");
  await expect
    .poll(() =>
      page.getByLabel("Nội dung truyện", { exact: true }).inputValue(),
    )
    .toContain("Lan");
  await expect(page.getByText("Đã phát hiện 2 chương")).toBeVisible();
  result.docx = "PASS";
  const name = "[TEST StoryFlow UI " + Date.now() + "]";
  await page.getByLabel("Tên dự án", { exact: true }).fill(name);
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/studio") &&
      r.request().postDataJSON()?.action === "create",
  );
  await page
    .getByRole("button", { name: "Tạo dự án truyện", exact: true })
    .click();
  const p = await (await response).json();
  assert.equal(p.chapters.length, 2);
  assert.equal(
    (await state()).jobs.filter((j) => j.projectId === p.id).length,
    0,
  );
  await page.getByRole("button", { name: "Chuyển sang Tạo video" }).click();
  await expect(page.getByLabel("Chọn dự án truyện")).toHaveValue(p.id);
  await page.getByLabel("Engine giọng đọc").selectOption("korva-local");
  await expect(page.getByLabel("Giọng", { exact: true })).toHaveValue(
    "ngoc_huyen",
  );
  await page
    .getByRole("switch", { name: /Tự động tạo ảnh minh họa/ })
    .uncheck();
  await expect(page.getByLabel("Phong cách ảnh")).toHaveCount(0);
  await page.getByRole("switch", { name: /Tự động tạo ảnh minh họa/ }).check();
  await page.getByLabel("Phong cách ảnh").selectOption("Tu tiên");
  await page.getByRole("switch", { name: /Tạo ảnh động bằng AI/ }).check();
  await page.getByLabel("Chỉ cảnh được chọn", { exact: true }).check();
  await expect(page.locator(".motion-scenes")).toBeVisible();
  await page.getByRole("switch", { name: /Tạo ảnh động bằng AI/ }).uncheck();
  await page.getByLabel("9:16 Shorts / Reels", { exact: false }).check();
  await page.getByLabel("Gộp các chương đã chọn thành một video").check();
  for (const width of [1366, 1600]) {
    await page.setViewportSize({ width, height: width === 1366 ? 768 : 900 });
    for (const [name, file] of [
      ["Nhập truyện", "import"],
      ["Tạo video", "video"],
      ["Quản lý kênh", "channels"],
    ]) {
      await page
        .getByRole("navigation")
        .getByRole("button", { name, exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: `test-results/redesign-${file}-${width}.png`,
        fullPage: true,
      });
    }
  }
  await expect(
    page.getByRole("button", { name: /Liên kết YouTube/ }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: /Liên kết Facebook/ }),
  ).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: "Tạo video", exact: true }).click();
  await page.getByLabel("Chọn dự án truyện").selectOption(p.id);
  await expect(page.getByLabel("Chọn dự án truyện")).toHaveValue(p.id);
  await post({ action: "rename", projectId: p.id, name: name + " renamed" });
  assert.ok(
    (await state()).projects.some(
      (x) => x.id === p.id && x.name.endsWith("renamed"),
    ),
  );
  assert.deepEqual(errors, []);
  await report("redesign-ui", {
    ...result,
    threeTabs: "PASS",
    parser: "PASS",
    persist: "PASS",
    rename: "PASS",
    viewports: [1366, 1600],
    horizontalOverflow: false,
    errors,
  });
} finally {
  await browser.close();
}
