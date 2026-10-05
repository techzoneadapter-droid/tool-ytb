import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { base, post, report } from "./verification.mjs";

// Only owned fixtures are exposed to this browser; mutations use the real API/database/files.
const owned = new Set(),
  videoIDs = new Set(),
  requests = [],
  dialogs = [],
  errors = [];
const marker = `TEST bulk delete ${Date.now()}`;
const db = new DatabaseSync(path.resolve("data/storyflow.sqlite"));
db.exec("PRAGMA busy_timeout=5000");
const output = randomUUID() + ".mp4";
await mkdir("data/assets", { recursive: true });
execFileSync(
  process.env.FFMPEG_PATH || "ffmpeg",
  [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=purple:s=320x180:r=12",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=24000:cl=mono",
    "-t",
    "0.3",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-pix_fmt",
    "yuv420p",
    path.resolve("data/assets", output),
  ],
  { windowsHide: true, stdio: "ignore" },
);
const size = (await stat(path.resolve("data/assets", output))).size;
async function makeProject(index) {
  const p = await post({
    action: "create",
    name: `${marker} Group ${index}`,
    text: "Chương 1: Kiểm thử\nMột câu chuyện để kiểm tra xóa dữ liệu.",
    settings: { audioEnabled: false, splitScenes: false },
  });
  owned.add(p.id);
  return p;
}
function makeVideo(p, title, extra = {}) {
  const id = randomUUID();
  videoIDs.add(id);
  const now = new Date().toISOString();
  const record = {
    id,
    projectId: p.id,
    chapterIds: [p.chapters[0].id],
    chapterTitles: ["fixture"],
    title,
    kind: "merged",
    output,
    createdAt: now,
    updatedAt: now,
    duration: 0.3,
    width: 320,
    height: 180,
    fileSize: size,
    verified: true,
    version: 1,
    ...extra,
  };
  db.prepare("INSERT INTO records VALUES (?, 'video', ?)").run(
    id,
    JSON.stringify(record),
  );
  return record;
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
page.setDefaultTimeout(30000);
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", async (dialog) => {
  dialogs.push(dialog.message());
  await dialog.accept();
});
let navigationCount = 0;
page.on("framenavigated", (frame) => {
  if (frame === page.mainFrame()) navigationCount++;
});
await page.route("**/api/studio", async (route) => {
  if (route.request().method() === "GET") {
    const response = await route.fetch(),
      data = await response.json();
    data.projects = data.projects.filter((p) => owned.has(p.id));
    data.jobs = data.jobs.filter((job) => owned.has(job.projectId));
    await route.fulfill({ response, json: data });
  } else {
    const body = route.request().postDataJSON();
    assert.equal(body.action, "deleteProjects");
    assert.ok(body.projectIds.every((id) => owned.has(id)));
    requests.push(body);
    await route.continue();
  }
});
await page.route("**/api/videos", async (route) => {
  if (route.request().method() === "GET") {
    const response = await route.fetch(),
      data = await response.json();
    data.videos = data.videos.filter((video) => owned.has(video.projectId));
    data.history = data.history.filter((job) => owned.has(job.projectId));
    await route.fulfill({ response, json: data });
  } else {
    const body = route.request().postDataJSON();
    assert.ok(["deleteMany", "delete"].includes(body.action));
    assert.ok(
      (body.videoIds || [body.videoId]).every((id) => videoIDs.has(id)),
    );
    requests.push(body);
    // Verify loading/disabled behavior while a real deletion request is outstanding.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  }
});
try {
  const projects = [];
  for (let i = 0; i < 5; i++) projects.push(await makeProject(i));
  const videos = Array.from({ length: 20 }, (_, i) =>
    makeVideo(projects[0], `${i < 3 ? "Needle" : "Other"} ${i}`),
  );
  await page.addInitScript(
    (id) => localStorage.setItem("storyflow-project", id),
    projects[0].id,
  );
  await page.goto(base);
  await page
    .getByRole("button", { name: "Quản lý video", exact: true })
    .click();
  await expect(page.locator(".video-library-row")).toHaveCount(20);
  const navigationBeforeDeletes = navigationCount;
  await page.getByLabel("Tìm video", { exact: true }).fill("Needle");
  await expect(page.locator(".video-library-row")).toHaveCount(3);
  await page.getByLabel("Chọn tất cả video", { exact: true }).check();
  await expect(
    page.getByText("Đã chọn 3 video", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Chọn Needle 0", { exact: true }).uncheck();
  assert.equal(
    await page
      .getByLabel("Chọn tất cả video")
      .evaluate((el) => el.indeterminate),
    true,
  );
  await page.getByLabel("Chọn tất cả video").check();
  await page.getByLabel("Tìm video", { exact: true }).fill("");
  await page.getByLabel("Chọn Other 3", { exact: true }).check();
  await page.getByLabel("Tìm video", { exact: true }).fill("Needle");
  await page.getByLabel("Chọn tất cả video").uncheck();
  await expect(
    page.getByText("Đã chọn 1 video", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Xóa 1 video", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Đang xóa...", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("Đã chọn 1 video", { exact: true })).toHaveCount(
    0,
  );
  assert.deepEqual(requests.at(-1).videoIds, [videos[3].id]);
  assert.match(dialogs.at(-1), /Ảnh nguồn, audio nguồn và dự án vẫn được giữ/);
  makeVideo(projects[0], "Other replacement");
  await page.getByLabel("Tìm video", { exact: true }).fill("");
  await expect(page.locator(".video-library-row")).toHaveCount(20);
  await page.getByLabel("Chọn tất cả video").check();
  const before = requests.length;
  await page.getByRole("button", { name: "Xóa 20 video", exact: true }).click();
  await expect(page.locator(".video-library-row")).toHaveCount(0);
  assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1).videoIds.length, 20);
  // Current-project deletion selects a remaining project without a page reload.
  await page
    .getByLabel("Chọn dự án " + projects[0].name, { exact: true })
    .check();
  await page.getByRole("button", { name: "Xóa 1 dự án", exact: true }).click();
  await expect(page.locator(".library-project-row")).toHaveCount(4);
  await expect(page.locator(".library-header h2")).toHaveText(projects[4].name);
  assert.ok(!dialogs.at(-1).includes("20 video thành phẩm"));
  const extra = await makeProject(5);
  // The project confirmation counts all versions, including those hidden by latestVideos.
  makeVideo(extra, "Older", { kind: "chapter", version: 1 });
  makeVideo(extra, "Latest", { kind: "chapter", version: 2 });
  await expect(page.locator(".library-project-row")).toHaveCount(5);
  await expect(
    page.locator(".library-project-row").filter({ hasText: extra.name }),
  ).toContainText("2 video");
  await page
    .locator(".library-project-row")
    .filter({ hasText: extra.name })
    .getByRole("button")
    .click();
  await expect(page.locator(".video-library-row")).toHaveCount(1);
  await expect(page.locator(".video-library-row")).toContainText("Latest");
  await page.getByLabel("Tìm dự án video").fill("Group 5");
  await page.getByLabel("Chọn tất cả dự án").check();
  await expect(
    page.getByText("Đã chọn 1 dự án", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Tìm dự án video").fill("");
  assert.equal(
    await page
      .getByLabel("Chọn tất cả dự án")
      .evaluate((el) => el.indeterminate),
    true,
  );
  await page.getByLabel("Chọn tất cả dự án").check();
  await expect(
    page.getByText("Đã chọn 5 dự án", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Xóa 5 dự án", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Chưa có dự án", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".library-project-row")).toHaveCount(0);
  assert.match(dialogs.at(-1), /5 dự án\n2 video thành phẩm/);
  assert.equal(
    navigationCount,
    navigationBeforeDeletes,
    "deletions never reload the page",
  );
  assert.deepEqual(errors, []);
  await report("bulk-delete-ui", {
    passed: true,
    cases: [
      "delete one video",
      "delete 20 videos in one request",
      "search select-all only visible",
      "indeterminate selection",
      "uncheck keeps IDs outside filter",
      "delete current project switches remaining",
      "project search select-all",
      "delete five projects",
      "confirmation counts hidden video versions",
      "delete all projects empty state",
      "loading prevents duplicate requests",
      "no page reload",
    ],
    requests: requests.map((r) => ({
      action: r.action,
      count: (r.videoIds || r.projectIds || [r.videoId]).length,
    })),
  });
} finally {
  await browser.close();
  const remaining = (
    await (await fetch(base + "/api/studio")).json()
  ).projects.filter((p) => owned.has(p.id));
  if (remaining.length)
    await post({
      action: "deleteProjects",
      projectIds: remaining.map((p) => p.id),
    });
  db.close();
  await unlink(path.resolve("data/assets", output)).catch(() => {});
}
