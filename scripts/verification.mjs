import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium, expect } from "@playwright/test";
export const base = process.env.STORYFLOW_URL || "http://127.0.0.1:3000";
export const state = async () => {
  const r = await fetch(base + "/api/studio");
  assert.equal(r.status, 200);
  return r.json();
};
export async function post(body, endpoint = "/api/studio", status = 200) {
  const r = await fetch(base + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  assert.equal(r.status, status, JSON.stringify(d));
  return d;
}
export async function waitJob(id, status = "done") {
  let j;
  await expect
    .poll(
      async () => {
        j = (await state()).jobs.find((j) => j.id === id);
        if (j.status === "error" && status !== "error") throw Error(j.error);
        return j.status;
      },
      { timeout: 600000, intervals: [1000, 2000] },
    )
    .toBe(status);
  return j;
}
export async function report(name, result) {
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/" + name + ".json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
}
export function probe(file, audio = true) {
  const d = JSON.parse(
    execFileSync(
      process.env.FFPROBE_PATH || "ffprobe",
      [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        "data/assets/" + file,
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
  assert.ok(Number(d.format.duration) > 0);
  if (audio) assert.ok(d.streams.some((s) => s.codec_type === "audio"));
  return d;
}
export async function photo() {
  const data = await readFile("test-results/forest-photo.jpg");
  const form = new FormData();
  form.append("file", new Blob([data], { type: "image/jpeg" }), "forest.jpg");
  const r = await fetch(base + "/api/upload", { method: "POST", body: form });
  assert.equal(r.status, 200);
  return (await r.json()).asset;
}
export async function testTTS() {
  const result = {};
  for (const provider of ["vieneu-local", "korva-local"]) {
    const request = {
      provider,
      voiceId: "ngoc_huyen",
      text: "Một buổi sáng yên bình. Lan đi qua khu rừng.",
      format: "wav",
    };
    const r = await fetch(base + "/api/tts/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const d = await r.json();
    if (!r.ok) {
      assert.equal(d.ok, false);
      assert.equal(d.audioUrl, undefined);
      result[provider] = { status: "INTEGRATION ONLY", reason: d.message };
      continue;
    }
    assert.ok(d.duration > 0);
    probe(d.file);
    const first = Buffer.from(
      await (await fetch(base + d.audioUrl)).arrayBuffer(),
    );
    assert.ok(first.length > 1000);
    const second = await post(request, "/api/tts/preview");
    const bytes = Buffer.from(
      await (await fetch(base + second.audioUrl)).arrayBuffer(),
    );
    assert.equal(
      createHash("sha256").update(first).digest("hex"),
      createHash("sha256").update(bytes).digest("hex"),
    );
    result[provider] = {
      status: "REAL PASS",
      duration: d.duration,
      cache: true,
    };
  }
  await report("local-tts", result);
  return result;
}
export async function testPipeline() {
  const before = await state();
  const preserved = before.projects.map((p) => ({
    id: p.id,
    name: p.name,
    chapters: p.chapters.length,
  }));
  const p = await post({
    action: "create",
    name: "[TEST redesign pipeline " + Date.now() + "]",
    text: "Chương 1\nLan đi qua khu rừng.\nChương 2\nÁnh nắng chiếu trên dòng suối.",
    settings: {
      ttsProvider: "korva-local",
      voice: "ngoc_huyen",
      imageEnabled: false,
      fallbackImage: await photo(),
      humanCheck: false,
    },
  });
  const ids = p.chapters.map((c) => c.id);
  assert.equal(ids.length, 2);
  const jobs = await post({
    action: "enqueue",
    kind: "pipeline",
    projectId: p.id,
    chapterIds: [...ids].reverse(),
    merge: false,
  });
  assert.equal(jobs.length, 2);
  assert.deepEqual(
    jobs.map((j) => j.chapterIds[0]),
    ids,
  );
  for (const j of jobs) {
    const result = await waitJob(j.id);
    assert.equal(result.verified, true);
    assert.ok(
      probe(result.output).streams.some((s) => s.codec_type === "video"),
    );
    assert.ok(
      (await (await fetch(base + "/api/files/" + result.srt)).text()).includes(
        "-->",
      ),
    );
  }
  let saved = (await state()).projects.find((x) => x.id === p.id);
  assert.ok(saved.chapters.every(c=>c.scenes.every(s=>!s.image)), 'Shared image stays in settings, never copied into scenes');
  assert.ok(saved.settings.fallbackImage);
  const audio = saved.chapters.flatMap((c) => c.scenes).map((s) => s.audio);
  assert.ok(
    saved.chapters.every((c) =>
      c.scenes.every((s) => s.audioSource === "korva-local" && s.duration > 0),
    ),
  );
  const [merged] = await post({
    action: "enqueue",
    kind: "pipeline",
    projectId: p.id,
    chapterIds: [...ids].reverse(),
    merge: true,
  });
  const output = await waitJob(merged.id);
  assert.deepEqual(output.chapterIds, ids);
  probe(output.output);
  saved = (await state()).projects.find((x) => x.id === p.id);
  assert.deepEqual(
    saved.chapters.flatMap((c) => c.scenes).map((s) => s.audio),
    audio,
  );
  const range = await fetch(base + "/api/files/" + output.output, {
    headers: { Range: "bytes=0-99" },
  });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 100);
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(base);
    await page.getByRole("button", { name: "Tạo video", exact: true }).click();
    await page.getByLabel("Chọn dự án truyện").selectOption(p.id);
    await expect(page.locator("video")).toHaveCount(3);
    const v = page.locator("video").first();
    await expect
      .poll(() =>
        v.evaluate((v) => Number.isFinite(v.duration) && v.duration > 0),
      )
      .toBe(true);
    await v.evaluate((v) => v.play());
    await expect
      .poll(() => v.evaluate((v) => v.currentTime))
      .toBeGreaterThan(0);
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "↓ Tải MP4" }).first().click();
    assert.equal(await (await download).failure(), null);
    await page.reload();
    await page.getByRole("button", { name: "Tạo video", exact: true }).click();
    await page.getByLabel("Chọn dự án truyện").selectOption(p.id);
    await expect(page.locator("video")).toHaveCount(3);
  } finally {
    await browser.close();
  }
  const after = await state();
  for (const old of preserved) {
    const current = after.projects.find((x) => x.id === old.id);
    assert.ok(current);
    assert.equal(current.name, old.name);
    assert.equal(current.chapters.length, old.chapters);
  }
  await report("local-pipeline", {
    projectId: p.id,
    perChapter: "PASS",
    merged: "PASS",
    subtitle: "PASS",
    ffprobe: "PASS",
    reuse: "PASS",
    player: "PASS",
    download: "PASS",
    refresh: "PASS",
    existingProjects: "PASS",
  });
  return p.id;
}
export async function testAI() {
  const status = await state();
  const result = {};
  const enabled = await post(
    { prompt: "A forest at dawn", provider: "flux2-local", enabled: false },
    "/api/image/generate",
    400,
  );
  assert.match(enabled.error, /đang tắt/);
  if (!status.providers.runtime.flux) {
    const error = await post(
      { prompt: "A forest at dawn", provider: "flux2-local" },
      "/api/image/generate",
      400,
    );
    assert.match(error.error, /FLUX/);
    assert.equal(error.file, undefined);
    result.flux = {
      status: "INTEGRATION ONLY",
      inference: "SKIPPED: engine unavailable",
    };
  } else {
    const image = await post(
      { prompt: "A forest at dawn", provider: "flux2-local" },
      "/api/image/generate",
    );
    const sharp = (await import("sharp")).default;
    await sharp(
      Buffer.from(await (await fetch(base + image.imageUrl)).arrayBuffer()),
    ).stats();
    result.flux = { status: "REAL PASS" };
  }
  const p = await post({
    action: "create",
    name: "[TEST motion " + Date.now() + "]",
    text: "Chương 1\nLan đứng giữa rừng.\nChương 2\nNắng lên.",
    settings: {
      ttsProvider: "korva-local",
      voice: "ngoc_huyen",
      audioEnabled: false,
      imageEnabled: false,
      fallbackImage: await photo(),
      motionMode: "selected",
    },
  });
  await post({
    action: "motionSelection",
    projectId: p.id,
    sceneIds: [p.chapters[0].scenes[0].id],
  });
  const [job] = await post({
    action: "enqueue",
    kind: "pipeline",
    projectId: p.id,
    chapterIds: p.chapters.map((c) => c.id),
    merge: true,
  });
  const failed = await waitJob(job.id, "error");
  const saved = (await state()).projects.find((x) => x.id === p.id);
  assert.equal(saved.chapters[1].scenes[0].motionStatus, undefined);
  if (!status.providers.runtime.wan) {
    assert.match(failed.error, /Wan2.2/);
    assert.equal(saved.chapters[0].scenes[0].motionStatus, "error");
    result.wan = {
      status: "INTEGRATION ONLY",
      inference: "SKIPPED: engine unavailable",
      pipelineActuallyAttemptsMotion: true,
    };
  } else {
    const scene = saved.chapters[0].scenes[0];
    assert.equal(scene.motionStatus, "done");
    assert.ok(
      probe(scene.motion, false).streams.some((s) => s.codec_type === "video"),
    );
    result.wan = { status: "REAL PASS" };
  }
  await report("local-ai", result);
}
export async function testRealMedia() {
  const p = await post({
    action: "create",
    name: "[TEST media validation " + Date.now() + "]",
    text: "Một câu chuyện ngắn.",
  });
  await post(
    {
      action: "enqueue",
      kind: "render",
      projectId: p.id,
      chapterIds: p.chapters.map((c) => c.id),
    },
    "/api/studio",
    400,
  );
  const after = await state();
  assert.equal(after.jobs.filter((j) => j.projectId === p.id).length, 0);
  await post({ action: "delete", projectId: p.id });
  await report("real-media-results", {
    missingMediaBlocked: true,
    noFakeCompletion: true,
  });
}
