import { randomUUID } from "node:crypto";
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { Job, Project, VideoRecord } from "../project/types";
import { get, list, put, remove, root } from "../project/store";
import { assetExists } from "../project/media";
import { verifyVideo } from "../videoRender/process";

const assets = path.join(root, "assets");

function videoMeta(data: any) {
  const stream = data.streams?.find((s: { codec_type: string }) => s.codec_type === "video");
  return {
    duration: Number(data.format?.duration) || 0,
    width: Number(stream?.width) || 0,
    height: Number(stream?.height) || 0,
  };
}

export async function createVideoRecord(job: Job, project: Project): Promise<VideoRecord> {
  if (!job.output || !job.verified || !assetExists(job.output))
    throw Error("Không thể lưu video chưa được xác minh.");
  const file = path.join(assets, job.output);
  const [probe, info] = await Promise.all([verifyVideo(file), stat(file)]);
  const chapterTitles = project.chapters
    .filter((c) => job.chapterIds.includes(c.id))
    .map((c) => c.title);
  const existing = list<VideoRecord>("video")
    .filter((v) => v.projectId === project.id && v.kind === (job.chapterIds.length === 1 ? "chapter" : "merged"))
    .filter((v) => JSON.stringify(v.chapterIds) === JSON.stringify(job.chapterIds));
  const version = Math.max(0, ...existing.map((v) => v.version || 1)) + 1;
  const now = new Date().toISOString();
  const meta = videoMeta(probe);
  const record: VideoRecord = {
    id: randomUUID(),
    projectId: project.id,
    chapterIds: [...job.chapterIds],
    chapterTitles,
    title: job.outputTitle || (chapterTitles.length === 1 ? chapterTitles[0] : project.name),
    kind: job.kind === "merge-video" || job.chapterIds.length > 1 ? "merged" : "chapter",
    output: job.output,
    srt: job.srt,
    vtt: job.vtt,
    createdAt: now,
    updatedAt: now,
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    fileSize: info.size,
    verified: true,
    version,
    sourceJobId: job.id,
    sourceVideoIds: job.sourceVideoIds,
  };
  put("video", record as unknown as { id: string; [key: string]: unknown });
  return record;
}

export async function migrateCompletedJobs() {
  const existingJobs = new Set(
    list<VideoRecord>("video").map((video) => video.sourceJobId).filter(Boolean),
  );
  for (const job of list<Job>("job")) {
    if (
      job.status !== "done" ||
      !job.verified ||
      !job.output ||
      existingJobs.has(job.id) ||
      !assetExists(job.output)
    ) continue;
    const project = list<Project>("project").find((p) => p.id === job.projectId);
    if (!project) continue;
    try {
      await createVideoRecord(job, project);
    } catch {
      // Old/missing files remain visible in job history, never fabricate a video record.
    }
  }
}

export async function removeVideoRecord(id: string) {
  const video = get<VideoRecord>(id, "video");
  remove("video", id);
  const stillUsed = list<VideoRecord>("video");
  for (const name of [video.output, video.srt, video.vtt].filter(Boolean) as string[]) {
    if (stillUsed.some((other) => [other.output, other.srt, other.vtt].includes(name))) continue;
    await unlink(path.join(assets, name)).catch(() => {});
  }
}

export function listVideos() {
  return list<VideoRecord>("video").map((video) => ({
    ...video,
    verified: video.verified && assetExists(video.output),
  }));
}
