import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:3000";
const state = async () => (await fetch(base + "/api/studio")).json();
async function post(body) {
  const r = await fetch(base + "/api/studio", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  assert.equal(r.status, 200, JSON.stringify(data));
  return data;
}
async function wait(id, status) {
  for (let i = 0; i < 240; i++) {
    const j = (await state()).jobs.find((j) => j.id === id);
    if (j.status === status) return j;
    if (j.status === "error" && status !== "error") throw Error(j.error);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error("Timed out waiting for " + status);
}
const photo = await readFile("test-results/forest-photo.jpg");
const form = new FormData();
form.append("file", new Blob([photo], { type: "image/jpeg" }), "forest.jpg");
const uploaded = await (
  await fetch(base + "/api/upload", { method: "POST", body: form })
).json();
const created = await post({
  action: "createVideo",
  name: "[TEST recovery " + Date.now() + "]",
  text: "Chương 1\nSáng nay, Lan bước vào khu rừng. Tiếng chim vang lên trên những tán lá.\nChương 2\nLan dừng chân bên dòng suối nhỏ, ngắm ánh nắng chiếu qua cành cây.",
  settings: {
    ttsProvider: "korva-local",
    voice: "ngoc_huyen",
    imageProvider: "flux2-local",
    burnSubtitles: false,
  },
});
const id = (await state()).jobs.find((j) => j.projectId === created.id).id;
const failed = await wait(id, "error");
assert.equal(failed.counts.failed, 2);
assert.equal(failed.counts.audio, 2);
assert.match(failed.error, /FLUX/);
assert.equal(failed.output, undefined);
let project = (await state()).projects.find((p) => p.id === created.id);
const audio = project.chapters.flatMap((c) => c.scenes).map((s) => s.audio);
await post({
  action: "settings",
  projectId: project.id,
  settings: {
    ...project.settings,
    imageEnabled: false,
    fallbackImage: uploaded.asset,
    humanCheck: true,
  },
});
await post({ action: "retry", id });
await wait(id, "paused");
project = (await state()).projects.find((p) => p.id === created.id);
assert.deepEqual(
  project.chapters.flatMap((c) => c.scenes).map((s) => s.audio),
  audio,
);
await post({ action: "approve", projectId: project.id });
const before = Number(await readFile("data/worker.lock", "utf8"));
await Promise.all([
  post({ action: "startService", service: "worker" }),
  post({ action: "startService", service: "worker" }),
]);
assert.equal(Number(await readFile("data/worker.lock", "utf8")), before);
// All jobs must be idle before restarting the test worker.
assert.ok(
  !(await state()).jobs.some((j) =>
    ["queued", "audio", "images", "rendering"].includes(j.status),
  ),
);
process.kill(before, "SIGTERM");
await new Promise((r) => setTimeout(r, 1000));
await post({ action: "resume", id });
const done = await wait(id, "done");
project = (await state()).projects.find((p) => p.id === created.id);
assert.deepEqual(
  project.chapters.flatMap((c) => c.scenes).map((s) => s.audio),
  audio,
);
assert.equal(done.srt, undefined);
assert.equal(done.vtt, undefined);
assert.equal(done.verified, true);
const report = {
  twoFailedImages: true,
  bothAudioItemsCompleted: true,
  retryKeptAudio: true,
  manualReview: true,
  resumedAfterWorkerRestart: true,
  duplicateStartPrevented: true,
  subtitlesOff: true,
  projectId: project.id,
  output: done.output,
};
await writeFile("test-results/recovery.json", JSON.stringify(report, null, 2));
console.log(report);
