import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { get, list, put, root } from "../../modules/project/store";
import { defaults, type Job, type Project, type VideoRecord } from "../../modules/project/types";
import { createVideoRecord, mergeVideoRecords } from "../../modules/videoLibrary";
import { verifyVideo } from "../../modules/videoRender/process";

async function main() {
  const assets = path.join(root, "assets");
  mkdirSync(assets, { recursive: true });
  const chapters = Array.from({ length: 10 }, (_, i) => ({
    id: randomUUID(),
    title: `Chương ${i + 1}`,
    text: "",
    scenes: [],
  }));
  const project: Project = {
    id: randomUUID(), name: "Ghép 10 chương", createdAt: new Date().toISOString(),
    settings: defaults, chapters,
  };
  put("project", project);
  const videos: VideoRecord[] = [];
  const hash = (filename: string) => createHash("sha256")
    .update(readFileSync(path.join(assets, filename))).digest("hex");
  for (let index = 0; index < chapters.length; index++) {
    const output = randomUUID() + ".mp4";
    const destination = path.join(assets, output);
    execFileSync(process.env.FFMPEG_PATH || "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24",
      "-f", "lavfi", "-i", `sine=frequency=${440 + index * 30}:sample_rate=24000`,
      "-t", String(0.5 + index * 0.03),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "24000", "-ac", "1",
      "-shortest", destination,
    ], { windowsHide: true, stdio: "pipe", timeout: 15000 });
    const probe = await verifyVideo(destination);
    const video: VideoRecord = {
      id: randomUUID(),
      projectId: project.id,
      chapterIds: [chapters[index].id],
      chapterTitles: [chapters[index].title],
      title: chapters[index].title,
      kind: "chapter",
      output,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      duration: Number(probe.format.duration),
      width: 320,
      height: 180,
      fileSize: statSync(destination).size,
      version: 1,
      verified: true,
    };
    put("video", video);
    videos.push(video);
  }
  const sourcesBefore = videos.map((video) => hash(video.output));
  const job: Job = {
    id: randomUUID(), projectId: project.id,
    kind: "merge-video", chapterIds: chapters.map((c) => c.id),
    // Deliberately reverse the UI selection; chapter ordering must win.
    sourceVideoIds: [...videos].reverse().map((video) => video.id),
    status: "rendering", createdAt: new Date().toISOString(),
    progress: 10, message: "Đang ghép", snapshot: { settings: defaults },
  };
  const merged = await mergeVideoRecords(job, project);
  assert.deepEqual(merged.chapterIds, chapters.map((c) => c.id));
  const mergedProbe = await verifyVideo(path.join(assets, merged.output));
  const expectedDuration = videos.reduce((sum, video) => sum + video.duration, 0);
  const actualDuration = Number(mergedProbe.format.duration);
  assert.ok(actualDuration >= expectedDuration * 0.85,
    `Output too short: ${actualDuration} / ${expectedDuration}`);
  assert.ok(actualDuration <= expectedDuration * 1.15,
    `Output too long: ${actualDuration} / ${expectedDuration}`);
  assert.deepEqual(videos.map((video) => hash(video.output)), sourcesBefore,
    "Original MP4s must not be modified");
  const record = await createVideoRecord({
    ...job, ...merged, status: "done", verified: true, progress: 100,
  }, project);
  assert.equal(record.kind, "merged");
  assert.equal(get<VideoRecord>(record.id, "video").output, merged.output);
  assert.equal(list<VideoRecord>("video").length, 11);
  process.stdout.write(JSON.stringify({ count: videos.length, expectedDuration, actualDuration }));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
