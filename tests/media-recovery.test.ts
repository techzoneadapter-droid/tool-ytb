import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { restoreMissingVideoFiles } from "../modules/videoLibrary/recovery";

test("recovers moved MP4 and subtitle without editing source or touching missing records", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "storyflow-recover-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, "old", "data", "assets");
  const target = path.join(root, "new", "data", "assets");
  await mkdir(legacy, { recursive: true });
  const name = "f0a11e12-1234-4ed3-abcd-000000000001.mp4";
  const srt = name.replace(".mp4", ".srt");
  const missing = "f0a11e12-1234-4ed3-abcd-000000000002.mp4";
  await writeFile(path.join(legacy, name), Buffer.alloc(512, 42));
  await writeFile(path.join(legacy, srt), "1\n00:00:00,000 --> 00:00:01,000\nXin chào\n");
  const report = await restoreMissingVideoFiles(
    [
      { output: name, fileSize: 512, srt },
      { output: missing, fileSize: 512 },
    ],
    target,
    [path.join(root, "old")],
  );
  assert.equal(report.videosRestored, 1);
  assert.equal(report.filesRestored, 2);
  assert.equal(report.videosMissing, 1);
  assert.equal((await stat(path.join(target, name))).size, 512);
  assert.equal((await readFile(path.join(legacy, name))).length, 512);
  assert.match(await readFile(path.join(target, srt), "utf8"), /Xin chào/);

  const next = await restoreMissingVideoFiles([{ output: name, fileSize: 512 }], target, [path.join(root, "old")]);
  assert.equal(next.filesRestored, 0);
  assert.equal(next.videosMissing, 0);
});

test("never recovers wrong-sized or unsafe filenames", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "storyflow-recover-safe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = path.join(root, "assets");
  const target = path.join(root, "new");
  await mkdir(old, { recursive: true });
  const file = "bbbbbbbb-1111-4444-aaaa-000000000000.mp4";
  await writeFile(path.join(old, file), Buffer.alloc(15));
  const r = await restoreMissingVideoFiles(
    [{ output: file, fileSize: 120 }, { output: "../unsafe.mp4", fileSize: 1 }],
    target, [old],
  );
  assert.equal(r.filesRestored, 0);
  assert.equal(r.videosMissing, 1);
});
