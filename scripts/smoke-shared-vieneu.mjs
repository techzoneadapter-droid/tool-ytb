import sharp from "sharp";
import assert from "node:assert/strict";
import { base, post, state, report, waitJob, probe } from "./verification.mjs";
const bytes = await sharp({
  create: { width: 1280, height: 720, channels: 3, background: "#6655aa" },
})
  .png()
  .toBuffer();
const form = new FormData();
form.append(
  "file",
  new File([bytes], "shared-image.png", { type: "image/png" }),
);
const uploadResponse = await fetch(base + "/api/upload", {
  method: "POST",
  body: form,
});
assert.equal(uploadResponse.status, 200);
const { asset } = await uploadResponse.json();
const p = await post({
  action: "create",
  name: `[TEST shared VieNeu ${Date.now()}]`,
  text: "Chương 1: Ảnh dùng chung\nĐây là chương kiểm tra lời đọc của StoryFlow. Chúng ta dùng duy nhất ảnh chung để dựng video. Không cần tạo ảnh mới.",
  settings: {
    imageEnabled: false,
    fallbackImage: asset,
    audioEnabled: true,
    ttsProvider: "vieneu-local",
    voice: "Ngọc Huyền",
    splitScenes: false,
    burnSubtitles: false,
    imageProvider: "flow-browser",
    motionMode: "off",
    humanCheck: false,
  },
});
console.log(JSON.stringify({ projectId: p.id, fallbackImage: asset }));
await post({
  action: "enqueue",
  projectId: p.id,
  chapterIds: p.chapters.map((c) => c.id),
  kind: "pipeline",
});
const job = (await state()).jobs.find((j) => j.projectId === p.id);
const done = await waitJob(job.id);
const saved = (await state()).projects.find((item) => item.id === p.id);
assert.equal(saved.characterBible, undefined);
assert.equal(saved.chapters[0].apiImage, undefined);
assert.equal(saved.chapters[0].masterImage, undefined);
assert.equal(saved.chapters[0].visualProfile, undefined);
assert.equal(done.imageMode, "shared");
assert.equal(done.sharedImageValid, true);
const metadata = probe(done.output);
await report("shared-vieneu-live", {
  passed: true,
  projectId: p.id,
  jobId: done.id,
  fallbackImage: asset,
  voice: done.snapshot.settings.voice,
  output: done.output,
  duration: Number(metadata.format.duration),
  imageGenerationSkipped: true,
  characterBibleGenerated: false,
});
