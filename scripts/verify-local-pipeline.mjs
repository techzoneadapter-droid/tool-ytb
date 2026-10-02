import { chromium, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:3000";
let projectId;
const browser = await chromium.launch({ channel: "msedge", headless: true });
async function post(route, body) {
  const r = await fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  return d;
}
const state = async () => (await fetch(base + "/api/studio")).json();
try {
  const p = await post("/api/studio", {
    action: "create",
    name: "[Kiểm thử TTS local tạm thời]",
    text: "Xin chào, đây là lời đọc trên máy của tôi.",
  });
  projectId = p.id;
  assert.equal(p.settings.ttsProvider, "vieneu-local");
  const page = await browser.newPage();
  await page.goto(base);
  await page.getByRole("button", { name: "Giọng đọc", exact: true }).click();
  await page.getByLabel("Dự án hiện tại").selectOption(p.id);
  const card = page
    .locator("article.voice")
    .filter({ hasText: "KorvaTTS local" })
    .filter({ has: page.getByText("Ngọc Huyền", { exact: true }) });
  await card
    .getByRole("button", { name: "Chọn giọng Ngọc Huyền", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Lưu giọng đọc", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await state()).projects.find((x) => x.id === p.id).settings
          .ttsProvider,
    )
    .toBe("korva-local");
  await page.reload();
  const saved = (await state()).projects.find((x) => x.id === p.id);
  assert.equal(saved.settings.voice, "ngoc_huyen");
  const [job] = await post("/api/studio", {
    action: "enqueue",
    kind: "audio",
    projectId: p.id,
    chapterIds: [p.chapters[0].id],
    merge: true,
  });
  await expect
    .poll(
      async () => {
        const current = (await state()).jobs.find((x) => x.id === job.id);
        if (current.status === "error") throw Error(current.error);
        return current.status;
      },
      { timeout: 180000, intervals: [1000, 2000] },
    )
    .toBe("ready");
  const scene = (await state()).projects.find((x) => x.id === p.id).chapters[0]
    .scenes[0];
  assert.equal(scene.audioSource, "korva-local");
  assert.equal(scene.audioStatus, "done");
  assert.ok(scene.duration > 0 && scene.audio.endsWith(".mp3"));
  const bytes = await fetch(base + "/api/files/" + scene.audio);
  assert.equal(bytes.status, 200);
  const request = {
    provider: "korva-local",
    voiceId: "ngoc_huyen",
    text: "Xin chào StoryFlow.",
    format: "wav",
  };
  const first = await post("/api/tts/generate", request);
  const second = await post("/api/tts/generate", request);
  async function hash(url) {
    return createHash("sha256")
      .update(Buffer.from(await (await fetch(base + url)).arrayBuffer()))
      .digest("hex");
  }
  assert.equal(await hash(first.audioUrl), await hash(second.audioUrl));
  const results = {
    selectionSaved: true,
    worker: "ready",
    source: scene.audioSource,
    sceneDuration: scene.duration,
    wavDuration: first.duration,
    cacheBytesMatch: true,
  };
  await writeFile(
    "test-results/local-pipeline.json",
    JSON.stringify(results, null, 2),
  );
  console.log(results);
} finally {
  await browser.close();
  if (projectId) {
    const db = new DatabaseSync("data/storyflow.sqlite");
    db.prepare(
      "DELETE FROM records WHERE kind='job' AND json_extract(body,'$.projectId')=? AND json_extract(body,'$.status') NOT IN ('audio','images','rendering','queued')",
    ).run(projectId);
    const active = db
      .prepare(
        "SELECT count(*) AS n FROM records WHERE kind='job' AND json_extract(body,'$.projectId')=?",
      )
      .get(projectId);
    if (!active.n)
      db.prepare(
        "DELETE FROM records WHERE kind='project' AND id=? AND json_extract(body,'$.name')=?",
      ).run(projectId, "[Kiểm thử TTS local tạm thời]");
    db.close();
  }
}
