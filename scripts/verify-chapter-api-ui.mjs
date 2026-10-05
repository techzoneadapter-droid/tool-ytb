import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile, unlink } from "node:fs/promises";
import assert from "node:assert/strict";
import sharp from "sharp";
import { base, post, state, report } from "./verification.mjs";

const configFile = "data/image-api/api-compatible.json";
const backup = await readFile(configFile).catch((error) => {
  if (error.code !== "ENOENT") throw error;
  return undefined;
});
assert.equal(
  (await state()).jobs.filter((job) =>
    ["queued", "audio", "images", "rendering"].includes(job.status),
  ).length,
  0,
  "Run only while the worker is idle",
);
const bytes = await sharp({
  create: { width: 640, height: 360, channels: 3, background: "#7964bb" },
})
  .png()
  .toBuffer();
let calls = 0;
const server = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, "Bearer fixture-ui-key");
  if (req.url.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "fixture-image" }] }));
    return;
  }
  for await (const _chunk of req) {
    /* Consume the real request body. */
  }
  calls++;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      data: [{ b64_json: bytes.toString("base64") }],
      usage: { output_tokens: 8 },
    }),
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1460, height: 1000 } });
page.setDefaultTimeout(30000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let project;
try {
  project = await post({
    action: "create",
    name: `[TEST chapter API UI ${Date.now()}]`,
    text: "Chương 1: Rừng đêm\nLâm Hạo 24 tuổi, tóc đen ngắn, mặc áo khoác đen. Lâm Hạo cầm kiếm đứng trong rừng.\nChương 2: Bình minh\nLâm Hạo bước bên dòng sông vào bình minh.",
    settings: { audioEnabled: false, splitScenes: false },
  });
  const hydrated = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/studio") &&
      response.request().method() === "GET",
  );
  await page.goto(base);
  await hydrated;
  await page.getByRole("button", { name: "Tạo video", exact: true }).click();
  await page.getByLabel("Chọn dự án truyện").selectOption(project.id);
  await page
    .locator('select:has(option[value="api-compatible"])')
    .selectOption("api-compatible");
  await page
    .getByLabel("Base URL (bao gồm /v1 nếu API yêu cầu)")
    .fill(`http://127.0.0.1:${server.address().port}/v1`);
  await page.getByLabel("Model ảnh riêng (tùy chọn)").fill("fixture-image");
  await page.getByLabel("API key", { exact: true }).fill("fixture-ui-key");
  assert.equal(
    await page.getByLabel("API key", { exact: true }).getAttribute("type"),
    "password",
  );
  await page
    .getByRole("button", { name: "Kết nối & lấy danh sách model" })
    .click();
  await expect(page.locator("#image-api-model-api-compatible")).toHaveValue(
    "fixture-image",
  );
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await page
    .getByText("Cấu hình tạo ảnh & đồng nhất nhân vật", { exact: true })
    .click();
  await page.getByLabel("Luồng API tối đa").fill("1");
  await page.getByLabel("Timeout (giây)").fill("60");
  await page.getByLabel("Số lần retry").fill("0");
  await page
    .getByLabel("API/model hỗ trợ Reference image", { exact: true })
    .check();
  await page
    .getByLabel("API/model hỗ trợ Nhiều reference trong một yêu cầu", {
      exact: true,
    })
    .check();
  await page.getByLabel("API/model hỗ trợ Seed", { exact: true }).check();
  await page
    .getByLabel("API/model hỗ trợ Negative prompt riêng", { exact: true })
    .check();
  await page
    .getByLabel(
      "Debug: xem prompt, negative, character block và metadata trong hồ sơ chương",
    )
    .check();
  await page
    .getByRole("button", { name: "Bắt đầu tạo video", exact: true })
    .click();
  let snapshot;
  await expect
    .poll(
      async () => {
        snapshot = await state();
        const jobs = snapshot.jobs.filter(
          (job) => job.projectId === project.id,
        );
        if (jobs.some((job) => job.status === "error"))
          throw Error(jobs.find((job) => job.status === "error").error);
        return jobs.filter((job) => job.status === "done").length;
      },
      { timeout: 60000, intervals: [1000] },
    )
    .toBe(2);
  const saved = snapshot.projects.find((item) => item.id === project.id);
  assert.equal(saved.settings.imageAPIOptions.concurrency, 1);
  assert.equal(saved.settings.imageAPIOptions.debug, true);
  assert.equal(calls, 3, "one portrait + two chapter masters");
  for (const chapter of saved.chapters) {
    assert.equal(new Set(chapter.scenes.map((scene) => scene.image)).size, 1);
    assert.equal(chapter.apiImage.referenceFiles.length, 1);
  }
  const hydratedReload = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/studio") &&
      response.request().method() === "GET",
  );
  await page.reload();
  await hydratedReload;
  await page.getByRole("button", { name: "Tạo video", exact: true }).click();
  await page.getByLabel("Chọn dự án truyện").selectOption(project.id);
  await expect(page.locator("#image-api-model-api-compatible")).toHaveValue(
    "fixture-image",
  );
  await page
    .getByText("Nhân vật, bối cảnh và prompt ảnh", { exact: true })
    .click();
  await page.getByText("CharacterBible · cấp dự án", { exact: true }).click();
  await page
    .getByRole("button", { name: "Lưu Character Bible", exact: true })
    .click();
  await expect(page.locator('img[alt="Portrait Lâm Hạo"]')).toBeVisible();
  assert.equal(
    await page
      .locator('img[alt="Portrait Lâm Hạo"]')
      .evaluate((img) => img.complete && img.naturalWidth > 0),
    true,
  );
  await page.locator(".image-api-connection").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "test-results/chapter-api-ui.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await report("chapter-api-ui", {
    result: "PASS",
    modelConnection: "PASS",
    settingsPersistence: "PASS",
    portraitReuse: "PASS",
    chapterMasters: 2,
    apiCalls: calls,
    realFFmpegVideos: 2,
    browserErrors: errors,
  });
} finally {
  await browser.close();
  if (project) await post({ action: "delete", projectId: project.id });
  if (backup) await writeFile(configFile, backup);
  else await unlink(configFile).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
