import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Job, Project, Scene, VideoRecord } from "../project/types";
import { subtitles } from "../subtitle";
import {
  list,
  put,
  root,
  deleteVideoRecords,
  removeProjects,
} from "../project/store";
import { assetExists } from "../project/media";
import { run, verifyVideo, duration } from "../videoRender/process";
import { encodeWithFallback } from "../videoRender/encoder";

const assets = path.join(root, "assets");

function videoVersionKey(record: Pick<VideoRecord, "projectId" | "kind" | "sceneId" | "chapterIds">) {
  return JSON.stringify([record.projectId, record.kind, record.sceneId || null, record.chapterIds]);
}

function videoMeta(data: any) {
  const stream = data.streams?.find(
    (s: { codec_type: string }) => s.codec_type === "video",
  );
  return {
    duration: Number(data.format?.duration) || 0,
    width: Number(stream?.width) || 0,
    height: Number(stream?.height) || 0,
  };
}

export async function createVideoRecord(
  job: Job,
  project: Project,
  knownVersions?: Map<string, number>,
): Promise<VideoRecord> {
  if (!job.output || !job.verified || !assetExists(job.output))
    throw Error("Không thể lưu video chưa được xác minh.");
  const file = path.join(assets, job.output);
  const [probe, info] = await Promise.all([verifyVideo(file), stat(file)]);
  const chapterTitles = project.chapters
    .filter((c) => job.chapterIds.includes(c.id))
    .map((c) => c.title);
  const sceneId = job.sceneIds?.length === 1 ? job.sceneIds[0] : undefined;
  const kind = sceneId
    ? "scene"
    : job.kind === "merge-video" || job.chapterIds.length > 1
      ? "merged"
      : "chapter";
  const key = videoVersionKey({ projectId: project.id, kind, sceneId, chapterIds: job.chapterIds });
  const version = knownVersions
    ? (knownVersions.get(key) || 0) + 1
    : Math.max(0, ...list<VideoRecord>("video")
        .filter((video) => videoVersionKey(video) === key)
        .map((video) => video.version || 1)) + 1;
  const now = new Date().toISOString();
  const meta = videoMeta(probe);
  const record: VideoRecord = {
    id: randomUUID(),
    projectId: project.id,
    chapterIds: [...job.chapterIds],
    chapterTitles,
    title:
      job.outputTitle ||
      (chapterTitles.length === 1 ? chapterTitles[0] : project.name),
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
  knownVersions?.set(key, version);
  return record;
}

export async function createSceneVideoRecord(
  scene: Scene,
  chapterId: string,
  project: Project,
  jobId: string,
): Promise<VideoRecord> {
  const output = scene.flow?.videoPath;
  if (!output || !assetExists(output))
    throw Error("Không thể lưu cảnh chưa có MP4 thật.");
  const file = path.join(assets, output);
  const probe = await verifyVideo(file);
  const existing = list<VideoRecord>("video").filter(
    (record) => record.projectId === project.id && record.sceneId === scene.id,
  );
  const same = existing.find((record) => record.output === output);
  if (same) return same;
  const chapter = project.chapters.find((item) => item.id === chapterId);
  const index = chapter?.scenes.findIndex((item) => item.id === scene.id) ?? -1;
  const base = output.slice(0, -4);
  await writeFile(path.join(assets, base + ".srt"), subtitles([scene]));
  await writeFile(path.join(assets, base + ".vtt"), subtitles([scene], true));
  const now = new Date().toISOString();
  const record: VideoRecord = {
    id: randomUUID(),
    projectId: project.id,
    chapterIds: [chapterId],
    chapterTitles: [chapter?.title || "Chương"],
    title: `${chapter?.title || "Chương"} · Cảnh ${index + 1}`,
    kind: "scene",
    sceneId: scene.id,
    output,
    srt: base + ".srt",
    vtt: base + ".vtt",
    createdAt: now,
    updatedAt: now,
    ...videoMeta(probe),
    fileSize: (await stat(file)).size,
    verified: true,
    version: Math.max(0, ...existing.map((item) => item.version)) + 1,
    sourceJobId: jobId,
  };
  put("video", record as unknown as { id: string; [key: string]: unknown });
  return record;
}

export async function migrateCompletedJobs() {
  // Recreate missing library indexes only from verified, existing job outputs.
  // Never delete, rename, or overwrite an MP4. Honour explicitly deleted videos.
  const existingVideos = list<VideoRecord>("video");
  const existingOutputs = new Set(existingVideos.map(v => v.output));
  const knownVersions = new Map<string, number>();
  for (const video of existingVideos) {
    const key = videoVersionKey(video);
    knownVersions.set(key, Math.max(knownVersions.get(key) || 0, video.version || 1));
  }
  const projects = new Map(list<Project>("project").map(p => [p.id, p]));
  for (const job of list<Job>("job")) {
    if (job.videoLibraryDeleted || !["done", "error"].includes(job.status)) continue;
    const project = projects.get(job.projectId);
    if (!project) continue;
    const outputs = job.outputs?.length
      ? job.outputs.filter(item => item.verified).map(item => ({
          chapterIds: item.chapterIds, output: item.output, srt: item.srt, vtt: item.vtt,
        }))
      : job.verified && job.output
        ? [{ chapterIds: job.chapterIds, output: job.output, srt: job.srt, vtt: job.vtt }]
        : [];
    for (const output of outputs) {
      if (!output.output || existingOutputs.has(output.output) || !assetExists(output.output))
        continue;
      try {
        await createVideoRecord({
          ...job, ...output, verified: true, chapterIds: output.chapterIds,
          outputTitle: undefined,
        }, project, knownVersions);
        existingOutputs.add(output.output);
      } catch {
        // An invalid or inaccessible file must not become a fake completed video.
      }
    }
  }
}

export async function removeVideoRecord(id: string) {
  return removeVideoRecords([id]);
}

async function cleanVideoFiles(videos: VideoRecord[]) {
  const references = new Set(
    list<VideoRecord>("video").flatMap((video) => [
      video.output,
      video.srt,
      video.vtt,
    ]),
  );
  // Flow scene MP4s remain reusable source caches even after a library record is removed.
  for (const project of list<Project>("project"))
    for (const chapter of project.chapters)
      for (const scene of chapter.scenes) references.add(scene.flow?.videoPath);
  for (const job of list<Job>("job").filter((job) =>
    ["queued", "audio", "images", "rendering", "paused"].includes(job.status),
  )) {
    references.add(job.output);
    references.add(job.srt);
    references.add(job.vtt);
    for (const output of job.outputs || [])
      for (const name of [output.output, output.srt, output.vtt])
        references.add(name);
  }
  const names = new Set(
    videos.flatMap((video) => [video.output, video.srt, video.vtt]),
  );
  for (const name of names) {
    if (
      !name ||
      references.has(name) ||
      !/^[a-f0-9-]+\.(mp4|srt|vtt)$/i.test(name)
    )
      continue;
    await unlink(path.join(assets, name)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function removeVideoRecords(ids: string[]) {
  const videos = deleteVideoRecords(ids);
  await cleanVideoFiles(videos);
  return videos.length;
}

export async function removeProjectRecords(ids: string[]) {
  const result = removeProjects(ids);
  await cleanVideoFiles(result.videos);
  return { deleted: result.deleted, deletedVideos: result.videos.length };
}

export function listVideos() {
  return list<VideoRecord>("video").map((video) => ({
    ...video,
    verified: video.verified && assetExists(video.output),
  }));
}

export async function mergeVideoRecords(
  job: Job,
  project: Project,
  onProgress?: (fraction: number) => void,
) {
  const ids = job.sourceVideoIds || [];
  if (ids.length < 2) throw Error("Chọn ít nhất 2 video để ghép.");
  const all = list<VideoRecord>("video");
  const selected = ids.map((id) => all.find((v) => v.id === id));
  if (
    selected.some(
      (v) => !v || v.projectId !== project.id || !assetExists(v.output),
    )
  )
    throw Error("Một video nguồn không còn hợp lệ.");

  const chapterPositions = new Map(project.chapters.map((chapter, index) => [chapter.id, index]));
  const scenePositions = new Map(project.chapters.flatMap((chapter) =>
    chapter.scenes.map((scene, index) => [scene.id, index] as const),
  ));
  const ordered = (selected as VideoRecord[]).sort((a, b) => {
    const chapterPosition = (video: VideoRecord) => Math.min(
      ...video.chapterIds.map((id) => chapterPositions.get(id) ?? Number.MAX_SAFE_INTEGER),
    );
    const chapterDiff = chapterPosition(a) - chapterPosition(b);
    if (chapterDiff) return chapterDiff;
    const sceneDiff = (scenePositions.get(a.sceneId || "") ?? Number.MAX_SAFE_INTEGER) -
      (scenePositions.get(b.sceneId || "") ?? Number.MAX_SAFE_INTEGER);
    return sceneDiff || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
  const work = path.join(root, "work", "merge-" + job.id);
  await mkdir(work, { recursive: true });
  const bumpers: { intro?: string; outro?: string } = {};
  if (job.mergeWithBumpers) {
    const first = await verifyVideo(path.join(assets, ordered[0].output));
    const videoStream = first.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    const width = Number(videoStream?.width) || 1280;
    const height = Number(videoStream?.height) || 720;
    for (const label of ["intro", "outro"] as const) {
      const asset = job.snapshot.settings[label];
      if (!asset) continue;
      if (!assetExists(asset)) throw Error(`Không tìm thấy ${label} trong tài nguyên dự án.`);
      const source = path.join(assets, asset);
      const probe = await verifyVideo(source, false);
      const hasAudio = probe.streams.some((s: { codec_type: string }) => s.codec_type === "audio");
      const seconds = await duration(source);
      const target = path.join(work, label + ".mp4");
      await encodeWithFallback((videoArgs) => [
        "-y", "-i", source,
        ...(hasAudio ? [] : ["-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono"]),
        "-map", "0:v:0", "-map", hasAudio ? "0:a:0" : "1:a:0",
        "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=25,format=yuv420p`,
        "-t", String(seconds), ...videoArgs, "-c:a", "aac", "-ar", "24000", "-ac", "1", target,
      ], work, undefined, true);
      await verifyVideo(target);
      bumpers[label] = target;
    }
  }
  const listFile = path.join(work, "concat.txt");
  await writeFile(
    listFile,
    [ ...(bumpers.intro ? [bumpers.intro] : []), ...ordered.map((video) => path.join(assets, video.output)), ...(bumpers.outro ? [bumpers.outro] : []) ]
      .map(
        (file) =>
          "file '" +
          file
            .replaceAll("\\", "/")
            .replaceAll("'", "'\\''") +
          "'",
      )
      .join("\n"),
  );
  const output = randomUUID() + ".mp4";
  const destination = path.join(assets, output);
  try {
    try {
      // Identical streams can be concatenated without an expensive re-encode.
      await run([
        "-y", "-f", "concat", "-safe", "0", "-i", listFile,
        "-c", "copy", "-movflags", "+faststart", destination,
      ]);
      await verifyVideo(destination);
    } catch {
      await unlink(destination).catch(() => {});
      const totalSeconds = ordered.reduce((sum, video) => sum + (video.duration || 0), 0);
      let lastPercent = -1;
      await run([
        "-y", "-f", "concat", "-safe", "0", "-i", listFile,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-ar", "24000", "-ac", "1",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", destination,
      ], undefined, false, totalSeconds > 0 && onProgress
        ? { seconds: totalSeconds, onProgress: (fraction) => {
            const percent = Math.floor(fraction * 100);
            if (percent > lastPercent) {
              lastPercent = percent;
              onProgress(fraction);
            }
          } }
        : undefined);
      await verifyVideo(destination);
    }
    return {
      output,
      chapterIds: [...new Set(ordered.flatMap((video) => video.chapterIds))],
    };
  } catch (error) {
    await unlink(destination).catch(() => {});
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
