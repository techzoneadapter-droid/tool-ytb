import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:3000";
const results = [];
let projectId;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await mkdir("test-results", { recursive: true });
async function state() {
  return (await fetch(base + "/api/studio")).json();
}
async function post(body, status = 200) {
  const response = await fetch(base + "/api/studio", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await response.json();
  assert.equal(response.status, status, JSON.stringify(d));
  return d;
}
async function waitJob(id) {
  for (let i = 0; i < 360; i++) {
    const j = (await state()).jobs.find((j) => j.id === id);
    if (j.status === "error") throw Error(j.error);
    if (["done", "ready"].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error("Quá thời gian chờ tác vụ thật.");
}
try {
  const before = await state();
  const p = await post({
    action: "create",
    name: "[Kiểm thử tài nguyên thật]",
    text: "Một người lữ hành bước lên đỉnh núi. Những đám mây trôi qua cung điện cổ.",
  });
  projectId = p.id;
  await page.goto(base);
  await page.getByRole("button", { name: "Giọng đọc", exact: true }).click();
  await page.getByLabel("Dự án hiện tại").selectOption(p.id);
  const card = page
    .locator("article.voice")
    .filter({ has: page.getByText("Ngọc Huyền", { exact: true }) });
  await expect(
    card.getByRole("button", { name: "Nghe thử", exact: true }),
  ).toBeVisible();
  if (!before.providers.tts.configured) {
    await card.getByRole("button", { name: "Nghe thử", exact: true }).click();
    await expect(card.getByRole("alert")).toHaveText("Chưa cấu hình API TTS");
    assert.equal(await card.locator("audio").count(), 0);
    results.push("Thiếu TTS: báo đúng lỗi, không có player/tệp giả.");
  }
  await page.getByRole("button", { name: "Ảnh AI", exact: true }).click();
  await page
    .getByRole("button", { name: "Tu tiên / Tiên hiệp", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Chia lại cảnh theo phong cách", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Đã áp dụng phong cách");
  let project = (await state()).projects.find((v) => v.id === p.id);
  assert.ok(
    project.chapters[0].scenes.every((s) =>
      s.prompt.includes("Chinese xianxia cultivation fantasy"),
    ),
  );
  results.push(
    "Phong cách Tu tiên được lưu vào từng mô tả cảnh, không đổi tách chương.",
  );
  if (!before.providers.image.configured) {
    await page
      .getByRole("button", { name: "Tạo ảnh cảnh này", exact: true })
      .first()
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Chưa cấu hình API tạo ảnh",
    );
    assert.equal(
      (await state()).jobs.filter((j) => j.projectId === p.id).length,
      0,
    );
    results.push(
      "Thiếu khóa ảnh: báo rõ, không sinh ảnh màu hoặc tác vụ hoàn tất.",
    );
  }
  await post(
    { action: "enqueue", projectId: p.id, chapterIds: [p.chapters[0].id] },
    400,
  );
  results.push("Chặn xuất khi chưa có tệp lời đọc và ảnh thật.");
  await page.reload();
  await page.getByRole("button", { name: "Tạo video", exact: true }).click();
  await page.getByLabel("Dự án hiện tại").selectOption(p.id);
  await expect(
    page.getByRole("button", { name: "Xuất 1 chương", exact: true }),
  ).toBeDisabled();
  const voice = before.providers.voices.find((v) => v.configured);
  if (
    before.providers.tts.configured &&
    before.providers.image.configured &&
    voice
  ) {
    await post({
      action: "settings",
      projectId: p.id,
      settings: { ...project.settings, voice: voice.id },
    });
    await page.getByRole("button", { name: "Giọng đọc", exact: true }).click();
    const realCard = page
      .locator("article.voice")
      .filter({ has: page.getByText(voice.name, { exact: true }) });
    await realCard
      .getByRole("button", { name: "Nghe thử", exact: true })
      .click();
    await expect(realCard.locator("audio")).toBeVisible({ timeout: 180000 });
    await expect
      .poll(() => realCard.locator("audio").evaluate((a) => a.duration), {
        timeout: 30000,
      })
      .toBeGreaterThan(0);
    for (const kind of ["audio", "image"]) {
      const [j] = await post({
        action: "enqueue",
        kind,
        projectId: p.id,
        chapterIds: [p.chapters[0].id],
        merge: true,
      });
      await waitJob(j.id);
    }
    project = (await state()).projects.find((v) => v.id === p.id);
    for (const scene of project.chapters[0].scenes) {
      assert.ok(scene.audioSource && scene.imageSource);
      await post({
        action: "scene",
        projectId: p.id,
        chapterId: p.chapters[0].id,
        scene: { ...scene, approved: true },
      });
    }
    const [j] = await post({
      action: "enqueue",
      projectId: p.id,
      chapterIds: [p.chapters[0].id],
      merge: true,
    });
    const done = await waitJob(j.id);
    assert.ok(done.verified && done.output);
    await page.getByRole("button", { name: "Xuất video", exact: true }).click();
    await expect(page.locator("video")).toBeVisible();
    await expect
      .poll(
        () =>
          page
            .locator("video")
            .first()
            .evaluate((v) => v.duration),
        { timeout: 30000 },
      )
      .toBeGreaterThan(0);
    for (const f of [
      done.output,
      done.srt,
      project.chapters[0].scenes[0].audio,
    ]) {
      const r = await fetch(base + "/api/files/" + f);
      assert.equal(r.status, 200);
      assert.ok((await r.arrayBuffer()).byteLength > 0);
    }
    await page.reload();
    assert.ok((await state()).jobs.find((job) => job.id === j.id).output);
    results.push(
      "API thật: nghe thử, tạo MP3, ảnh thật, FFmpeg MP4, player, tải MP4/MP3/SRT, dữ liệu còn sau refresh.",
    );
  } else
    results.push(
      "CHƯA KIỂM TRA đầu ra AI/MP4 end-to-end: thiếu khóa TTS hoặc ảnh hoặc mã giọng thật. Không tạo tệp thay thế.",
    );
  await page.screenshot({
    path: "test-results/real-media-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: "test-results/real-media-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  results.push(
    "Giao diện desktop/mobile không lỗi JavaScript hoặc tràn ngang.",
  );
  console.log(results.join("\n"));
} finally {
  await browser.close();
  if (projectId) {
    const db = new DatabaseSync("data/storyflow.sqlite");
    db.exec("PRAGMA busy_timeout=5000");
    const jobs = db
      .prepare(
        "SELECT body FROM records WHERE kind='job' AND json_extract(body,'$.projectId')=?",
      )
      .all(projectId)
      .map((r) => JSON.parse(r.body));
    if (jobs.every((j) => ["done", "ready", "error"].includes(j.status))) {
      db.prepare(
        "DELETE FROM records WHERE kind='job' AND json_extract(body,'$.projectId')=?",
      ).run(projectId);
      db.prepare(
        "DELETE FROM records WHERE kind='project' AND id=? AND json_extract(body,'$.name')=?",
      ).run(projectId, "[Kiểm thử tài nguyên thật]");
    }
    db.close();
  }
  await writeFile(
    "test-results/real-media-results.json",
    JSON.stringify({ results }, null, 2),
  );
}
