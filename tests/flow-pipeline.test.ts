import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { ConcurrencyGate } from "../modules/pipeline/flow-scenes";
import { renderSceneBuffer } from "../modules/videoRender/scene";
import { recoverInterruptedFlowScenes } from "../modules/videoRender/scene-cache";
import { verifyVideo } from "../modules/videoRender/process";
import { defaults, type Scene, type Project } from "../modules/project/types";

let directory: string;
const originalCwd = process.cwd();
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "storyflow-flow-pipeline-"));
  process.chdir(directory);
});
after(async () => {
  process.chdir(originalCwd);
  const target = path.resolve(directory);
  if (
    !target.startsWith(path.resolve(tmpdir()) + path.sep) ||
    !path.basename(target).startsWith("storyflow-flow-pipeline-")
  )
    throw Error("Unexpected test cleanup path");
  await rm(target, { recursive: true, force: true });
});

test("FFmpeg decodes a Buffer through stdin, creates real AV streams and no image file", async () => {
  const output = path.join(directory, randomUUID() + ".mp4");
  const buffer = await sharp({
    create: { width: 768, height: 512, channels: 3, background: "#0066bb" },
  })
    .png()
    .toBuffer();
  const scene: Scene = {
    id: randomUUID(),
    text: "Một cảnh",
    prompt: "A river",
    duration: 0.4,
    approved: false,
  };
  await renderSceneBuffer({
    imageBuffer: buffer,
    scene,
    settings: defaults,
    outputPath: output,
  });
  const probe = await verifyVideo(output);
  assert.equal(
    probe.streams.find(
      (stream: { codec_type: string }) => stream.codec_type === "video",
    ).width,
    1280,
  );
  assert.ok(Number(probe.format.duration) >= 0.4);
  assert.equal(
    (await readdir(directory)).filter((name) => /\.(png|jpe?g)$/i.test(name))
      .length,
    0,
  );
});

test("scene 2 failure preserves scene 1/3, publishes immediately, retries only failure and assembles cached clips", async () => {
  // SQLite closes with the child before Windows removes the isolated test directory.
  await promisify(execFile)(
    process.execPath,
    [
      "--import",
      path.join(originalCwd, "node_modules/tsx/dist/loader.mjs"),
      path.join(originalCwd, "tests/helpers/flow-pipeline-integration.ts"),
    ],
    { cwd: directory, windowsHide: true },
  );
});

test("global concurrency gates bound work and release slots after errors", async () => {
  const gate = new ConcurrencyGate(() => 2);
  let active = 0,
    peak = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) =>
      gate.run(async () => {
        active++;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (index === 2) throw Error("expected failure");
        } finally {
          active--;
        }
      }),
    ),
  );
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
});

test("restart makes interrupted scenes retryable without changing completed MP4 checkpoints", () => {
  const scenes: Scene[] = ["done", "image", "rendering"].map(
    (status, index) => ({
      id: String(index),
      text: "fixture",
      prompt: "fixture",
      duration: 1,
      approved: false,
      flow: {
        sceneId: String(index),
        chapterId: "chapter",
        status: status as "done" | "image" | "rendering",
        prompt: "fixture",
        videoPath: `${index}.mp4`,
        updatedAt: "before",
      },
    }),
  );
  const project: Project = {
    id: "fixture",
    name: "fixture",
    createdAt: "before",
    settings: defaults,
    chapters: [{ id: "chapter", title: "fixture", text: "fixture", scenes }],
  };
  assert.equal(recoverInterruptedFlowScenes(project), true);
  assert.deepEqual(
    scenes.map((scene) => scene.flow!.status),
    ["done", "pending", "pending"],
  );
  assert.deepEqual(
    scenes.map((scene) => scene.flow!.videoPath),
    ["0.mp4", "1.mp4", "2.mp4"],
  );
  assert.equal(scenes[0].flow!.updatedAt, "before");
  assert.equal(recoverInterruptedFlowScenes(project), false);
});
