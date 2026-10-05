import { randomUUID } from "node:crypto";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Job, Project, Scene, VideoRecord } from "../project/types";
import { subtitles } from "../subtitle";
import { get, list, put, remove, root } from "../project/store";
import { assetExists } from "../project/media";
import { run, verifyVideo } from "../videoRender/process";

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
  const sceneId = job.sceneIds?.length === 1 ? job.sceneIds[0] : undefined;
  const kind = sceneId ? "scene" : job.kind === "merge-video" || job.chapterIds.length > 1 ? "merged" : "chapter";
  const existing = list<VideoRecord>("video")
    .filter((v) => v.projectId === project.id && v.kind === kind && v.sceneId === sceneId)
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
    kind,
    sceneId,
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

export async function createSceneVideoRecord(scene: Scene, chapterId: string, project: Project, jobId: string): Promise<VideoRecord> {
  const output = scene.flow?.videoPath;
  if (!output || !assetExists(output)) throw Error("Không thể lưu cảnh chưa có MP4 thật.");
  const file = path.join(assets, output);
  const probe = await verifyVideo(file);
  const existing = list<VideoRecord>("video").filter(record => record.projectId === project.id && record.sceneId === scene.id);
  const same = existing.find(record => record.output === output);
  if (same) return same;
  const chapter = project.chapters.find(item => item.id === chapterId);
  const index = chapter?.scenes.findIndex(item => item.id === scene.id) ?? -1;
  const base = output.slice(0, -4);
  await writeFile(path.join(assets, base + ".srt"), subtitles([scene]));
  await writeFile(path.join(assets, base + ".vtt"), subtitles([scene], true));
  const now = new Date().toISOString();
  const record: VideoRecord = {
    id: randomUUID(), projectId: project.id, chapterIds: [chapterId], chapterTitles: [chapter?.title || "Chương"],
    title: `${chapter?.title || "Chương"} · Cảnh ${index + 1}`, kind: "scene", sceneId: scene.id,
    output, srt: base + ".srt", vtt: base + ".vtt", createdAt: now, updatedAt: now,
    ...videoMeta(probe), fileSize: (await stat(file)).size, verified: true,
    version: Math.max(0, ...existing.map(item => item.version)) + 1, sourceJobId: jobId,
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
      job.outputs?.length ||
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


export async function mergeVideoRecords(job: Job, project: Project) {
  const ids = job.sourceVideoIds || [];
  if (ids.length < 2) throw Error("Chọn ít nhất 2 video để ghép.");
  const all = list<VideoRecord>("video");
  const selected = ids.map((id) => all.find((v) => v.id === id));
  if (selected.some((v) => !v || v.projectId !== project.id || !assetExists(v.output)))
    throw Error("Một video nguồn không còn hợp lệ.");

  const ordered = (selected as VideoRecord[]).sort((a, b) => {
    const ai = Math.min(...a.chapterIds.map((id) => project.chapters.findIndex((x) => x.id === id)).filter((x) => x >= 0));
    const bi = Math.min(...b.chapterIds.map((id) => project.chapters.findIndex((x) => x.id === id)).filter((x) => x >= 0));
    if (ai !== bi) return ai - bi;
    const scenes = project.chapters[ai]?.scenes || [];
    return scenes.findIndex(scene => scene.id === a.sceneId) - scenes.findIndex(scene => scene.id === b.sceneId);
  });
  const work = path.join(root, "work", "merge-" + job.id);
  await mkdir(work, { recursive: true });
  const listFile = path.join(work, "concat.txt");
  await writeFile(
    listFile,
    ordered
      .map((video) => "file '" + path.join(assets, video.output).replaceAll("\\", "/").replaceAll("'", "'\\''") + "'")
      .join("\n"),
  );
  const output = randomUUID() + ".mp4";
  const destination = path.join(assets, output);
  try {
    await run(["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", destination]);
    await verifyVideo(destination);
  } catch {
    await unlink(destination).catch(() => {});
    await run([
      "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c:v", "libx264", "-preset", "fast", "-crf", "23",
      "-c:a", "aac", "-ar", "24000", "-ac", "1",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", destination,
    ]);
    await verifyVideo(destination);
  }
  return {
    output,
    chapterIds: [...new Set(ordered.flatMap((video) => video.chapterIds))],
  };
}
