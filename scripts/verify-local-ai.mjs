import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:3000";
let projectId, uploadId;
const results = {};
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
async function post(route, body, status = 200) {
  const r = await fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  assert.equal(r.status, status, JSON.stringify(d));
  return d;
}
const state = async () => (await fetch(base + "/api/studio")).json();
const project = async () =>
  (await state()).projects.find((p) => p.id === projectId);
async function job(id, target) {
  await expect
    .poll(
      async () => {
        const j = (await state()).jobs.find((j) => j.id === id);
        if (j.status === "error" && target !== "error") throw Error(j.error);
        return j.status;
      },
      { timeout: 180000, intervals: [500, 1000] },
    )
    .toBe(target);
  return (await state()).jobs.find((j) => j.id === id);
}
try {
  const ttsResponse = await fetch(base + "/api/tts/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "vieneu-local",
      voiceId: "Ngọc Huyền",
      text: "Xin chào.",
      format: "wav",
    }),
  });
  const tts = await ttsResponse.json();
  if (ttsResponse.ok) {
    assert.ok(tts.duration > 0);
    assert.equal((await fetch(base + tts.audioUrl)).status, 200);
    results.vieneuRealAudio = true;
  } else {
    assert.match(tts.message, /Chưa chạy VieNeu/);
    results.missingVieneu = true;
  }
  const flux = await post(
    "/api/image/generate",
    { prompt: "A mountain at dawn", provider: "flux2-local" },
    400,
  );
  assert.match(flux.error, /FLUX.2 local/);
  const off = await post(
    "/api/image/generate",
    { prompt: "A mountain", provider: "flux2-local", enabled: false },
    400,
  );
  assert.match(off.error, /đang tắt/);
  let p = await post("/api/studio", {
    action: "create",
    name: "[Kiểm thử local AI tạm thời]",
    text: "Chương 1\nXin chào, một ngày mới đã bắt đầu.\nChương 2\nNắng lên trên đỉnh núi.",
  });
  projectId = p.id;
  assert.equal(p.settings.motionMode, "off");
  await post(
    "/api/video/generate",
    { projectId, chapterIds: p.chapters.map((c) => c.id), merge: true },
    400,
  );
  // Explicit test upload, not a simulated FLUX output.
  const png = await sharp(
    Buffer.from(
      '<svg width="320" height="180"><rect width="320" height="180" fill="#ddeeff"/><text x="30" y="90">Render regression test</text></svg>',
    ),
  )
    .png()
    .toBuffer();
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), "test.png");
  const uploaded = await (
    await fetch(base + "/api/upload", { method: "POST", body: form })
  ).json();
  uploadId = uploaded.asset;
  const chapter = p.chapters[0];
  p = await post("/api/studio", {
    action: "scene",
    projectId,
    chapterId: chapter.id,
    scene: { ...chapter.scenes[0], image: uploadId, motionSelected: true },
  });
  p = await post("/api/studio", {
    action: "settings",
    projectId,
    settings: {
      ...p.settings,
      ttsProvider: "korva-local",
      voice: "ngoc_huyen",
      imageEnabled: false,
      motionMode: "selected",
      humanCheck: false,
      burnSubtitles: false,
    },
  });
  const motion = await post("/api/video/generate", {
    projectId,
    chapterIds: p.chapters.map((c) => c.id),
    merge: true,
  });
  const failed = await job(motion.jobId, "error");
  assert.match(failed.error, /Wan2.2 local/);
  console.log("Missing-service API and selected-scene checks passed");
  const status = await (
    await fetch(base + "/api/video/jobs/" + motion.jobId)
  ).json();
  assert.equal(status.scenes.length, 1);
  assert.equal(status.scenes[0].videoUrl, undefined);
  p = await project();
  assert.equal(p.chapters[1].scenes[0].motionStatus, undefined);
  await page.goto(base);
  console.log("Browser loaded");
  await page.getByRole("button", { name: "Tạo video", exact: true }).click();
  await page.getByLabel("Dự án hiện tại").selectOption(projectId);
  await expect(
    page.getByText(/Không kết nối được Wan2.2 local/).first(),
  ).toBeVisible();
  await page.getByLabel("Ảnh động", { exact: true }).selectOption("off");
  await page
    .getByRole("button", { name: "Lưu lựa chọn tạo ảnh", exact: true })
    .click();
  await expect
    .poll(async () => (await project()).settings.motionMode)
    .toBe("off");
  const [audioJob] = await post("/api/studio", {
    action: "enqueue",
    kind: "prepare",
    projectId,
    chapterIds: [chapter.id],
    merge: true,
  });
  await job(audioJob.id, "ready"); // imageEnabled=false skips FLUX despite it being unavailable.
  const [renderJob] = await post("/api/studio", {
    action: "enqueue",
    kind: "render",
    projectId,
    chapterIds: [chapter.id],
    merge: true,
  });
  const rendered = await job(renderJob.id, "done");
  assert.equal(rendered.verified, true);
  assert.equal(
    (await fetch(base + "/api/files/" + rendered.output)).status,
    200,
  );
  p = await project();
  const audio = p.chapters[0].scenes[0].audio;
  assert.equal((await fetch(base + "/generated/audio/" + audio)).status, 200);
  await page.reload();
  assert.equal((await project()).settings.motionMode, "off");
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/local-ai.png", fullPage: true });
  assert.deepEqual(errors, []);
  Object.assign(results, {
    missingFlux: true,
    missingWan: true,
    onlySelectedSceneSubmitted: true,
    disabledImageSkippedInPrepare: true,
    staticRenderVerified: true,
    publicAudioAccessible: true,
    pageErrors: errors,
  });
  await writeFile(
    "test-results/local-ai.json",
    JSON.stringify(results, null, 2),
  );
  console.log(results);
} finally {
  await browser.close();
  if (projectId) {
    const db = new DatabaseSync("data/storyflow.sqlite");
    const active = db
      .prepare(
        "SELECT count(*) AS n FROM records WHERE kind='job' AND json_extract(body,'$.projectId')=? AND json_extract(body,'$.status') IN ('queued','audio','images','rendering')",
      )
      .get(projectId);
    if (!active.n) {
      db.prepare(
        "DELETE FROM records WHERE kind='job' AND json_extract(body,'$.projectId')=?",
      ).run(projectId);
      db.prepare(
        "DELETE FROM records WHERE kind='project' AND id=? AND json_extract(body,'$.name')=?",
      ).run(projectId, "[Kiểm thử local AI tạm thời]");
      if (uploadId)
        db.prepare("DELETE FROM records WHERE kind='upload' AND id=?").run(
          uploadId,
        );
    }
    db.close();
  }
}
