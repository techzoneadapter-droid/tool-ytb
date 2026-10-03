import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });
import { mkdir, unlink, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { acquireLock, startService, WORKER_PROTOCOL } from "../modules/providers/services";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  root,
  claim,
  get,
  list,
  put,
  remove,
  updateJob,
  mergeProjectChapters,
} from "../modules/project/store";
import type { Job, Project, Settings } from "../modules/project/types";
import { speak, speakBatch } from "../modules/tts";
import { makeImage, makeStoryImageBatch } from "../modules/imagePrompt";
import {
  sceneVisual,
  ensureVisualProfile,
} from "../modules/imagePrompt/profile";
import { imageConfig } from "../modules/providers/config";
import { runtimeStatus } from "../modules/providers/runtime-status";
import { modalHealth } from "../modules/providers/modal/client";
import { ttsSource } from "../modules/tts";
import {
  assetExists,
  requireSceneMedia,
  resolveSceneImage,
  validImage,
} from "../modules/project/media";
import { duration, verifyVideo } from "../modules/videoRender/process";
import { assets, render } from "../modules/videoRender";
import { makeMotion, usesMotion } from "../modules/providers/local-workers";
import { createVideoRecord, mergeVideoRecords } from "../modules/videoLibrary";
const lockPath = path.join(root, "worker.lock");

async function imageEngineReady(settings: Settings) {
  if (settings.imageEnabled === false) return true;
  if (
    settings.imageProvider === "modal-story" ||
    settings.imageProvider === "modal-reference"
  )
    return (await modalHealth("image")).ready;
  if (settings.imageProvider === "aihorde") return true;
  if (settings.imageProvider === "pollinations") return true;
  if (
    settings.imageProvider === "flux2-local" ||
    settings.imageProvider === "local-fast" ||
    settings.imageProvider === "auto-local"
  ) {
    const runtime = await runtimeStatus();
    return settings.imageProvider === "flux2-local"
      ? runtime.flux
      : runtime.fast;
  }
  if (settings.imageProvider === "openai") return !!imageConfig().key;
  return false;
}

async function splitLegacyPipelineJobs() {
  const candidates = list<Job>("job").filter(
    (job) =>
      job.kind === "pipeline" &&
      job.status === "queued" &&
      job.outputMode === "separate" &&
      job.chapterIds.length > 1,
  );
  for (const job of candidates) {
    const project = get<Project>(job.projectId, "project");
    const chapterIds = project.chapters
      .filter((chapter) => job.chapterIds.includes(chapter.id))
      .map((chapter) => chapter.id);
    if (chapterIds.length < 2) continue;
    const batchId = job.batchId || randomUUID();
    const sharedCompleted = new Set(job.completedItems || []);
    chapterIds.forEach((chapterId, index) => {
      const chapter = project.chapters.find((item) => item.id === chapterId)!;
      const sceneIds = new Set(chapter.scenes.map((scene) => scene.id));
      const completedItems = [...sharedCompleted].filter((key) => {
        const sceneId = key.split(":")[0];
        return sceneIds.has(sceneId);
      });
      const child: Job = {
        ...job,
        id: index === 0 ? job.id : randomUUID(),
        chapterIds: [chapterId],
        batchId,
        batchIndex: index,
        batchTotal: chapterIds.length,
        completedItems,
        outputs: undefined,
        output: undefined,
        srt: undefined,
        vtt: undefined,
        verified: false,
        progress: 0,
        status: "queued",
        error: undefined,
        stageProgress: undefined,
        finishedAt: undefined,
        message: `Khôi phục video ${index + 1}/${chapterIds.length} dưới dạng tác vụ độc lập`,
      };
      put("job", child);
    });
  }
}
async function main() {
  await acquireLock(lockPath);
  const heartbeat = () =>
    writeFile(
      path.join(root, "worker.health.json"),
      JSON.stringify({
        pid: process.pid,
        time: Date.now(),
        protocol: WORKER_PROTOCOL,
      }),
    ).catch(() => {});
  await heartbeat();
  setInterval(heartbeat, 3000);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      void unlink(lockPath).finally(() => process.exit(0));
    });
  await mkdir(assets, { recursive: true });
  for (const j of list<Job>("job"))
    if (["audio", "images", "rendering"].includes(j.status))
      updateJob(j.id, { status: "queued", message: "Khôi phục xử lý" });
  await splitLegacyPipelineJobs();
  const configuredParallel = Number(process.env.MAX_PARALLEL_VIDEOS || 2);
  const maxParallelVideos = Number.isFinite(configuredParallel)
    ? Math.max(1, Math.min(4, Math.floor(configuredParallel)))
    : 2;
  const running = new Set<Promise<void>>();
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  console.log(
    `StoryFlow: pipeline độc lập theo video · tối đa ${maxParallelVideos} video chạy song song.`,
  );
  while (true) {
    while (running.size < maxParallelVideos) {
      const job = claim();
      if (!job) break;
      let task!: Promise<void>;
      task = (async () => {
        try {
      const p = get<Project>(job.projectId, "project");
      const saveProject = () => {
        mergeProjectChapters(p, job.chapterIds);
      };
      const s = job.snapshot.settings;
      for (const chapter of p.chapters.filter((c) =>
        job.chapterIds.includes(c.id),
      ))
        ensureVisualProfile(chapter, s);
      saveProject();
      // Project order is authoritative even if the request selected IDs in reverse order.
      let scenes = p.chapters
        .filter((c) => job.chapterIds.includes(c.id))
        .flatMap((c) => c.scenes)
        .filter((scene) => !job.sceneIds || job.sceneIds.includes(scene.id));
      const kind = job.kind || (job.prepare ? "prepare" : "render");

      if (kind === "merge-video") {
        updateJob(job.id, { status: "rendering", progress: 10, message: "Đang ghép các video đã chọn" });
        const merged = await mergeVideoRecords(job, p);
        job.chapterIds = merged.chapterIds;
        job.output = merged.output;
        job.verified = true;
        job.progress = 100;
        job.status = "done";
        job.finishedAt = new Date().toISOString();
        job.message = "Video ghép đã xuất và kiểm tra thành công";
        put("job", job);
        await createVideoRecord(job, p);
        return;
      }

      if (kind === "motion")
        scenes = scenes.filter((scene) => usesMotion(scene, s));
      if (!scenes.length) throw Error("Không có cảnh để xử lý.");
      const checkpoint = (
        status: Job["status"],
        progress: number,
        message: string,
      ) => {
        const currentStatus = get<Job>(job.id, "job").status;
        if (currentStatus === "paused") throw Error("PAUSED");
        if (currentStatus === "cancelled") throw Error("CANCELLED");
        updateJob(job.id, {
          status,
          progress: Math.min(99, progress),
          message,
        });
      };

      const stageTimers = new Map<
        string,
        { startedAt: number; baseline: number }
      >();
      const reportStage = (
        status: Job["status"],
        label: string,
        current: number,
        total: number,
        detail: string,
        concurrency = 1,
        globalProgress?: number,
      ) => {
        const currentStatus = get<Job>(job.id, "job").status;
        if (currentStatus === "paused" || currentStatus === "cancelled") return;
        let timer = stageTimers.get(label);
        if (!timer) {
          timer = { startedAt: Date.now(), baseline: current };
          stageTimers.set(label, timer);
        }
        const elapsedSeconds = Math.max(
          0,
          Math.floor((Date.now() - timer.startedAt) / 1000),
        );
        const produced = Math.max(0, current - timer.baseline);
        const ratePerMinute =
          elapsedSeconds >= 2 && produced > 0
            ? (produced * 60) / elapsedSeconds
            : undefined;
        const etaSeconds =
          ratePerMinute && current < total
            ? Math.round(((total - current) / ratePerMinute) * 60)
            : undefined;
        updateJob(job.id, {
          status,
          ...(globalProgress === undefined
            ? {}
            : { progress: Math.min(99, Math.max(0, globalProgress)) }),
          message: detail,
          stageProgress: {
            label,
            current,
            total,
            detail,
            concurrency,
            elapsedSeconds,
            etaSeconds,
            ratePerMinute,
            updatedAt: new Date().toISOString(),
          },
        });
      };
      if (
        s.imageEnabled === false &&
        ["pipeline", "prepare", "render"].includes(kind)
      ) {
        for (const scene of scenes) {
          if (!(await resolveSceneImage(scene, s)))
            throw Error(
              "Cảnh chưa có ảnh hợp lệ. Hãy chọn ảnh dùng chung trước khi render.",
            );
        }
        updateJob(job.id, { message: "Đã kiểm tra ảnh cảnh / ảnh dùng chung" });
      }
      if (kind !== "render") {
        let completed = 0;
        let failed = 0;
        const completedItems = new Set(job.completedItems || []);
        updateJob(job.id, { subtitlesReady: false });
        const tasks =
          kind === "prepare" || kind === "pipeline"
            ? [
                ...(s.audioEnabled === false ? [] : ["audio"]),
                ...(s.imageEnabled === false ? [] : ["image"]),
                ...(kind === "pipeline" &&
                s.motionMode &&
                s.motionMode !== "off"
                  ? ["motion"]
                  : []),
              ]
            : [kind];
        const total = scenes.reduce(
          (n, scene) =>
            n +
            tasks.filter((t) => t !== "motion" || usesMotion(scene, s)).length,
          0,
        );
        const handledThisRun = new Set<string>();
        const relevantKeys = scenes.flatMap((scene) =>
          tasks
            .filter((type) => type !== "motion" || usesMotion(scene, s))
            .map((type) => scene.id + ":" + type),
        );
        completed = relevantKeys.filter((key) => completedItems.has(key)).length;
        const finishKey = (key: string) => {
          if (!completedItems.has(key)) {
            completedItems.add(key);
            completed++;
          }
          handledThisRun.add(key);
        };
        const valid = async (
          scene: (typeof scenes)[number],
          type: "audio" | "image" | "motion",
        ) => {
          try {
            if (type === "image") {
              const effective = await resolveSceneImage(scene, s);
              if (!effective) return false;
              await sharp(path.join(assets, effective)).stats();
              return true;
            }
            if (!assetExists(scene[type])) return false;
            if (type === "audio") {
              if (!scene.audioSource) return false;
              const seconds = await duration(path.join(assets, scene.audio!));
              if (!(seconds > 0)) return false;
              scene.duration = seconds;
            } else await verifyVideo(path.join(assets, scene.motion!), false);
            return true;
          } catch {
            return false;
          }
        };
        const counts = () => ({
          audio: scenes.filter((x) => completedItems.has(x.id + ":audio"))
            .length,
          image:
            s.imageEnabled === false
              ? scenes.length
              : scenes.filter((x) => completedItems.has(x.id + ":image"))
                  .length,
          motion: scenes.filter((x) => completedItems.has(x.id + ":motion"))
            .length,
          rendered: get<Job>(job.id, "job").counts?.rendered || 0,
          total: scenes.length,
          failed,
        });
        const reportResource = (
          type: "audio" | "image" | "motion",
          scene: (typeof scenes)[number],
          concurrency = 1,
        ) => {
          const currentCounts = counts();
          const stageCurrent =
            type === "audio"
              ? currentCounts.audio
              : type === "image"
                ? currentCounts.image
                : currentCounts.motion || 0;
          const stageTotal =
            type === "motion"
              ? scenes.filter((item) => usesMotion(item, s)).length
              : scenes.length;
          const label =
            type === "audio"
              ? "Lời đọc"
              : type === "motion"
                ? "Ảnh động"
                : "Hình ảnh";
          const chapter = p.chapters.find((candidate) =>
            candidate.scenes.some((item) => item.id === scene.id),
          );
          reportStage(
            type === "audio" ? "audio" : "images",
            label,
            stageCurrent,
            stageTotal,
            `${label}: ${stageCurrent}/${stageTotal} cảnh · ${chapter?.title || "Chương"} · cảnh ${scenes.indexOf(scene) + 1}`,
            concurrency,
            Math.floor(
              (completed / Math.max(1, total)) *
                (kind === "pipeline" ? 75 : 99),
            ),
          );
          return currentCounts;
        };
        const sharedFallbackReady =
          s.imageEnabled !== false &&
          s.fallbackOnImageError === true &&
          (await validImage(s.fallbackImage));
        const bypassUnavailableImageAI =
          sharedFallbackReady && !(await imageEngineReady(s));

        if (tasks.includes("audio") && s.ttsProvider === "vieneu-local") {
          checkpoint("audio", 1, "Đang khởi động VieNeu Local và nạp giọng đọc");
          await startService("vieneu");
        }

        for (const type of tasks as ("audio" | "image" | "motion")[]) {
          for (const scene of scenes) {
            const loopKey = scene.id + ":" + type;
            if (handledThisRun.has(loopKey)) continue;
            if (
              type === "image" &&
              bypassUnavailableImageAI &&
              !(await valid(scene, "image"))
            ) {
              const key = scene.id + ":image";
              scene.image = undefined;
              scene.imageSource = "shared";
              scene.imageStatus = "done";
              scene.imageError = undefined;
              scene.approved = !s.humanCheck;
              finishKey(key);
              saveProject();
              const currentCounts = reportResource("image", scene, 1);
              updateJob(job.id, {
                completedItems: [...completedItems],
                counts: currentCounts,
                message:
                  "AI ảnh chưa sẵn sàng — đang dùng ảnh chung để tiếp tục dựng video",
              });
              continue;
            }

            if (
              type === "audio" &&
              [
                "modal-vieneu",
                "vieneu-local",
                "edge-online",
                "pollinations",
                "cloud",
              ].includes(s.ttsProvider || "") &&
              !completedItems.has(scene.id + ":audio") &&
              !(await valid(scene, "audio"))
            ) {
              const start = scenes.findIndex((item) => item.id === scene.id);
              const group: typeof scenes = [];
              for (const candidate of scenes.slice(Math.max(0, start))) {
                if (group.length >= 32) break;
                if (
                  !completedItems.has(candidate.id + ":audio") &&
                  !handledThisRun.has(candidate.id + ":audio") &&
                  !(await valid(candidate, "audio"))
                )
                  group.push(candidate);
              }
              if (group.length) {
                const engineName =
                  s.ttsProvider === "modal-vieneu"
                    ? "VieNeu Cloud"
                    : s.ttsProvider === "edge-online"
                      ? "Edge TTS Online"
                      : s.ttsProvider === "pollinations"
                        ? "Pollinations TTS"
                        : s.ttsProvider === "cloud"
                          ? "Cloud TTS"
                          : "VieNeu Local";
                const expectedConcurrency =
                  s.ttsProvider === "modal-vieneu"
                    ? Math.min(16, group.length)
                    : s.ttsProvider === "edge-online"
                      ? Math.min(6, group.length)
                      : s.ttsProvider === "vieneu-local"
                        ? Math.min(6, group.length)
                        : s.ttsProvider === "pollinations"
                          ? Math.min(3, group.length)
                          : Math.min(2, group.length);
                checkpoint(
                  "audio",
                  Math.floor(
                    (completed / Math.max(1, total)) *
                      (kind === "pipeline" ? 75 : 99),
                  ),
                  `${engineName}: bắt đầu nhóm ${group.length} cảnh`,
                );
                const beforeCounts = counts();
                reportStage(
                  "audio",
                  "Lời đọc",
                  beforeCounts.audio,
                  scenes.length,
                  `${engineName}: đang xử lý nhóm ${group.length} cảnh · tối đa ${expectedConcurrency} luồng`,
                  expectedConcurrency,
                  Math.floor(
                    (completed / Math.max(1, total)) *
                      (kind === "pipeline" ? 75 : 99),
                  ),
                );
                const files = group.map(() =>
                  path.join(assets, randomUUID() + ".mp3"),
                );
                const byId = new Map(
                  group.map((item, index) => [
                    item.id,
                    { item, index },
                  ]),
                );
                for (const item of group) {
                  item.audioStatus = "working";
                  item.audioError = undefined;
                }
                saveProject();
                try {
                  const durations = await speakBatch(
                    group.map((item, index) => ({
                      id: item.id,
                      text: item.text,
                      file: files[index],
                    })),
                    s,
                    {
                      shouldStop: () => {
                        const status = get<Job>(job.id, "job").status;
                        return status === "paused" || status === "cancelled";
                      },
                      onProgress: (event) => {
                        const found = byId.get(event.id);
                        if (!found) return;
                        const { item, index } = found;
                        item.audio = path.basename(files[index]);
                        item.audioSource = ttsSource(s);
                        item.duration = event.seconds;
                        item.audioStatus = "done";
                        item.audioError = undefined;
                        item.approved = !s.humanCheck;
                        finishKey(item.id + ":audio");
                        saveProject();
                        const chapter = p.chapters.find((candidate) =>
                          candidate.scenes.some((x) => x.id === item.id),
                        );
                        const currentCounts = counts();
                        const globalProgress = Math.floor(
                          (completed / Math.max(1, total)) *
                            (kind === "pipeline" ? 75 : 99),
                        );
                        reportStage(
                          "audio",
                          "Lời đọc",
                          currentCounts.audio,
                          scenes.length,
                          `${engineName}: ${currentCounts.audio}/${scenes.length} cảnh · ${chapter?.title || "Chương"} · ${event.concurrency} luồng`,
                          event.concurrency,
                          globalProgress,
                        );
                        updateJob(job.id, {
                          completedItems: [...completedItems],
                          counts: currentCounts,
                        });
                      },
                    },
                  );

                  const status = get<Job>(job.id, "job").status;
                  if (status === "paused") throw Error("PAUSED");
                  if (status === "cancelled") throw Error("CANCELLED");

                  for (const item of group) {
                    if (!durations.has(item.id) && !completedItems.has(item.id + ":audio"))
                      throw Error("Engine giọng đọc thiếu audio trong batch.");
                  }
                  continue;
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : String(error);
                  if (message === "PAUSED" || message === "CANCELLED")
                    throw error;
                  for (const item of group) {
                    if (completedItems.has(item.id + ":audio")) continue;
                    item.audioStatus = "error";
                    item.audioError = message;
                    handledThisRun.add(item.id + ":audio");
                    failed++;
                  }
                  saveProject();
                  updateJob(job.id, {
                    completedItems: [...completedItems],
                    counts: counts(),
                  });
                  throw Error(message);
                }
              }
            }

            if (
              type === "image" &&
              ["aihorde", "pollinations"].includes(s.imageProvider || "") &&
              !completedItems.has(scene.id + ":image") &&
              !(await valid(scene, "image"))
            ) {
              const start = scenes.findIndex((item) => item.id === scene.id);
              const group: typeof scenes = [];
              for (const candidate of scenes.slice(Math.max(0, start))) {
                if (group.length >= 12) break;
                if (
                  !completedItems.has(candidate.id + ":image") &&
                  !handledThisRun.has(candidate.id + ":image") &&
                  !(await valid(candidate, "image"))
                )
                  group.push(candidate);
              }

              if (group.length) {
                const engineName =
                  s.imageProvider === "aihorde"
                    ? "AI Horde"
                    : "Pollinations";
                // Each video owns one image lane. Parallelism comes from
                // independent video jobs, which avoids hammering free APIs
                // (AI Horde anonymous commonly rate-limits bursts).
                const concurrency = 1;
                checkpoint(
                  "images",
                  Math.floor(
                    (completed / Math.max(1, total)) *
                      (kind === "pipeline" ? 75 : 99),
                  ),
                  `${engineName}: bắt đầu nhóm ${group.length} ảnh · ${concurrency} luồng`,
                );
                const beforeCounts = counts();
                reportStage(
                  "images",
                  "Hình ảnh",
                  beforeCounts.image,
                  scenes.length,
                  `${engineName}: đang xử lý nhóm ${group.length} ảnh · ${concurrency} luồng`,
                  concurrency,
                  Math.floor(
                    (completed / Math.max(1, total)) *
                      (kind === "pipeline" ? 75 : 99),
                  ),
                );

                let cursor = 0;
                const workers = Array.from(
                  { length: Math.min(concurrency, group.length) },
                  async () => {
                    while (true) {
                      const status = get<Job>(job.id, "job").status;
                      if (status === "paused" || status === "cancelled") return;
                      const index = cursor++;
                      if (index >= group.length) return;
                      const item = group[index];
                      const key = item.id + ":image";
                      const chapter = p.chapters.find((candidate) =>
                        candidate.scenes.some((x) => x.id === item.id),
                      )!;
                      const file = randomUUID() + ".png";
                      const visual = sceneVisual(chapter, item, s);
                      item.finalImagePrompt = visual.prompt;
                      item.imageSeed = visual.seed;
                      item.imageStatus = "working";
                      item.imageError = undefined;
                      saveProject();
                      try {
                        let generated;
                        try {
                          generated = await makeImage(
                            visual.prompt,
                            path.join(assets, file),
                            s,
                            visual.seed,
                          );
                        } catch (primaryError) {
                          const alternateProvider =
                            s.imageProvider === "aihorde"
                              ? "pollinations"
                              : "aihorde";
                          updateJob(job.id, {
                            message:
                              `${engineName} tạm lỗi; video này tự chuyển sang ${alternateProvider === "aihorde" ? "AI Horde" : "Pollinations"}`,
                          });
                          generated = await makeImage(
                            visual.prompt,
                            path.join(assets, file),
                            {
                              ...s,
                              imageProvider: alternateProvider,
                            },
                            visual.seed,
                          );
                          item.imageError =
                            "Provider chính lỗi, đã tự chuyển: " +
                            (primaryError instanceof Error
                              ? primaryError.message
                              : String(primaryError));
                        }
                        item.imageEngine = generated.engine;
                        item.imageModel = generated.model;
                        item.image = file;
                        item.imageSource = generated.engine;
                        item.imageStatus = "done";
                        item.motion = undefined;
                        item.motionStatus = undefined;
                        item.motionError = undefined;
                        item.approved = !s.humanCheck;
                        finishKey(key);
                      } catch (error) {
                        const message =
                          error instanceof Error
                            ? error.message
                            : String(error);
                        item.imageStatus = "error";
                        item.imageError = message;
                        if (
                          s.fallbackOnImageError &&
                          (await resolveSceneImage(
                            { ...item, image: undefined },
                            s,
                          ))
                        ) {
                          finishKey(key);
                          item.approved = !s.humanCheck;
                        } else {
                          handledThisRun.add(key);
                          failed++;
                        }
                      }

                      saveProject();
                      const currentCounts = counts();
                      const globalProgress = Math.floor(
                        (completed / Math.max(1, total)) *
                          (kind === "pipeline" ? 75 : 99),
                      );
                      reportStage(
                        "images",
                        "Hình ảnh",
                        currentCounts.image,
                        scenes.length,
                        `${engineName}: ${currentCounts.image}/${scenes.length} cảnh · ${chapter.title} · ${concurrency} luồng`,
                        concurrency,
                        globalProgress,
                      );
                      updateJob(job.id, {
                        completedItems: [...completedItems],
                        counts: currentCounts,
                      });
                    }
                  },
                );
                await Promise.all(workers);

                const status = get<Job>(job.id, "job").status;
                if (status === "paused") throw Error("PAUSED");
                if (status === "cancelled") throw Error("CANCELLED");
                continue;
              }
            }

            if (
              type === "image" &&
              s.imageProvider === "modal-story" &&
              !completedItems.has(scene.id + ":image") &&
              !(await valid(scene, "image"))
            ) {
              const chapter = p.chapters.find((candidate) =>
                candidate.scenes.some((item) => item.id === scene.id),
              )!;
              const chapterScenes = chapter.scenes.filter(
                (item) =>
                  scenes.some((selected) => selected.id === item.id) &&
                  !completedItems.has(item.id + ":image"),
              );
              const start = Math.max(
                0,
                chapterScenes.findIndex((item) => item.id === scene.id),
              );
              const group: typeof chapterScenes = [];
              for (const candidate of chapterScenes.slice(start)) {
                if (group.length >= 10) break;
                if (!(await valid(candidate, "image"))) group.push(candidate);
              }
              if (group.length) {
                checkpoint(
                  "images",
                  Math.floor(
                    (completed / Math.max(1, total)) *
                      (kind === "pipeline" ? 75 : 99),
                  ),
                  `Story AI đang tạo ${group.length} cảnh đồng nhất — ${chapter.title}`,
                );
                const files: string[] = [];
                const prompts: string[] = [];
                for (const item of group) {
                  const visual = sceneVisual(chapter, item, s);
                  item.finalImagePrompt = visual.prompt;
                  item.imageSeed = visual.seed;
                  item.imageStatus = "working";
                  item.imageError = undefined;
                  files.push(path.join(assets, randomUUID() + ".png"));
                  prompts.push(visual.prompt);
                }
                saveProject();
                try {
                  const characterDescription =
                    chapter.visualProfile?.characters?.[0]?.descriptor ||
                    chapter.visualProfile?.visualNotes ||
                    "a consistent main character";
                  const generated = await makeStoryImageBatch(
                    prompts,
                    files,
                    s,
                    chapter.visualProfile?.seed || 0,
                    characterDescription,
                  );
                  for (let index = 0; index < group.length; index++) {
                    const item = group[index];
                    item.image = path.basename(files[index]);
                    item.imageSource = generated.engine;
                    item.imageEngine = generated.engine;
                    item.imageModel = generated.model;
                    item.imageStatus = "done";
                    item.imageError = undefined;
                    item.motion = undefined;
                    item.motionStatus = undefined;
                    item.motionError = undefined;
                    item.approved = !s.humanCheck;
                    finishKey(item.id + ":image");
                  }
                  saveProject();
                  const imageCounts = counts();
                  reportStage(
                    "images",
                    "Hình ảnh",
                    imageCounts.image,
                    scenes.length,
                    `Story AI: ${imageCounts.image}/${scenes.length} cảnh · ${chapter.title}`,
                    Math.min(10, group.length),
                    Math.floor(
                      (completed / Math.max(1, total)) *
                        (kind === "pipeline" ? 75 : 99),
                    ),
                  );
                  updateJob(job.id, {
                    completedItems: [...completedItems],
                    counts: imageCounts,
                  });
                  continue;
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : String(error);
                  let usedFallback = 0;
                  for (const item of group) {
                    item.imageStatus = "error";
                    item.imageError = message;
                    if (
                      s.fallbackOnImageError &&
                      (await resolveSceneImage(
                        { ...item, image: undefined },
                        s,
                      ))
                    ) {
                      finishKey(item.id + ":image");
                      usedFallback++;
                    } else {
                      handledThisRun.add(item.id + ":image");
                      failed++;
                    }
                  }
                  saveProject();
                  updateJob(job.id, {
                    completedItems: [...completedItems],
                    counts: counts(),
                  });
                  if (usedFallback === group.length) continue;
                  throw Error(message);
                }
              }
            }
            if (type === "motion" && !usesMotion(scene, s)) continue;
            const key = scene.id + ":" + type;
            if (!job.regenerate && completedItems.has(key)) {
              handledThisRun.add(key);
              continue;
            }
            if (await valid(scene, type)) {
              finishKey(key);
              scene[(type + "Status") as "audioStatus"] = "done";
              scene[(type + "Error") as "audioError"] = undefined;
              saveProject();
              updateJob(job.id, {
                completedItems: [...completedItems],
                counts: counts(),
              });
              continue;
            }
            completedItems.delete(key);
            checkpoint(
              type === "audio" ? "audio" : "images",
              Math.floor(
                (completed / Math.max(1, total)) *
                  (kind === "pipeline" ? 75 : 99),
              ),
              "Đang tạo " +
                (type === "audio"
                  ? "lời đọc"
                  : type === "motion"
                    ? "ảnh động"
                    : "ảnh") +
                " — " +
                p.chapters.find((c) => c.scenes.some((x) => x.id === scene.id))
                  ?.title +
                " / cảnh " +
                (scenes.indexOf(scene) + 1),
            );
            scene[(type + "Status") as "audioStatus"] = "working";
            scene[(type + "Error") as "audioError"] = undefined;
            saveProject();
            try {
              if (type === "audio") {
                const file = randomUUID() + ".mp3";
                scene.duration = await speak(
                  scene.text,
                  path.join(assets, file),
                  s,
                );
                scene.audio = file;
                scene.audioSource = ttsSource(s);
              } else if (type === "motion") {
                const file = randomUUID() + ".mp4";
                await makeMotion(scene, path.join(assets, file), s);
                scene.motion = file;
              } else {
                const file = randomUUID() + ".png";
                const chapter = p.chapters.find((c) =>
                  c.scenes.some((x) => x.id === scene.id),
                )!;
                const visual = sceneVisual(chapter, scene, s);
                scene.finalImagePrompt = visual.prompt;
                scene.imageSeed = visual.seed;
                saveProject();
                const generated = await makeImage(
                  visual.prompt,
                  path.join(assets, file),
                  s,
                  visual.seed,
                );
                scene.imageEngine = generated.engine;
                scene.imageModel = generated.model;
                scene.image = file;
                scene.imageSource = generated.engine;
                scene.motion = undefined;
                scene.motionStatus = undefined;
                scene.motionError = undefined;
              }
              scene[(type + "Status") as "audioStatus"] = "done";
              scene.approved = !s.humanCheck;
              saveProject();
              finishKey(key);
            } catch (e) {
              if (
                type === "image" &&
                s.fallbackOnImageError &&
                (await resolveSceneImage({ ...scene, image: undefined }, s))
              ) {
                scene.imageError = e instanceof Error ? e.message : String(e);
                scene.imageStatus = "error";
                scene.approved = !s.humanCheck;
                finishKey(key);
                saveProject();
                const fallbackCounts = reportResource(type, scene, 1);
                updateJob(job.id, {
                  completedItems: [...completedItems],
                  counts: fallbackCounts,
                });
                continue;
              }
              scene[(type + "Status") as "audioStatus"] = "error";
              scene[(type + "Error") as "audioError"] =
                e instanceof Error ? e.message : String(e);
              saveProject();
              failed++;
            }
            const currentCounts = reportResource(type, scene, 1);
            updateJob(job.id, {
              completedItems: [...completedItems],
              counts: currentCounts,
            });
          }
        }
        if (failed)
          throw Error(
            `${failed} tài nguyên lỗi. Thử lại chỉ xử lý tài nguyên lỗi hoặc còn thiếu. ${scenes.flatMap((scene) => [scene.audioError, scene.imageError, scene.motionError]).find(Boolean) || ""}`,
          );
        if (kind === "pipeline") {
          checkpoint(
            "rendering",
            75,
            "Tài nguyên đã sẵn sàng; chuẩn bị phụ đề và video",
          );
        } else {
          checkpoint(
            "ready",
            99,
            "Tài nguyên thật đã lưu. Có thể nghe, xem và duyệt cảnh.",
          );
          updateJob(job.id, { status: "ready", progress: 0 });
          return;
        }
      }
      for (const scene of scenes) {
        await requireSceneMedia(scene, s);
        if (usesMotion(scene, s)) {
          if (!scene.motion)
            throw Error("Ảnh động đã bật nhưng cảnh chưa có clip Wan hợp lệ.");
          await verifyVideo(path.join(assets, scene.motion), false);
        }
        scene.duration = await duration(path.join(assets, scene.audio!));
        if (!Number.isFinite(scene.duration) || scene.duration <= 0)
          throw Error("Tệp lời đọc không có thời lượng hợp lệ.");
      }
      if (s.humanCheck && scenes.some((scene) => !scene.approved)) {
        updateJob(job.id, {
          status: "paused",
          message: "Tài nguyên đã lưu. Duyệt cảnh bên dưới rồi nhấn Tiếp tục.",
        });
        return;
      }
      if (kind === "pipeline" && job.outputMode === "separate") {
        const chapters = p.chapters.filter((chapter) =>
          job.chapterIds.includes(chapter.id),
        );
        const outputs: NonNullable<Job["outputs"]> = [];
        let subtitlesReady = false;

        for (let index = 0; index < chapters.length; index++) {
          const chapter = chapters[index];
          const chapterScenes = chapter.scenes.filter(
            (scene) => !job.sceneIds || job.sceneIds.includes(scene.id),
          );
          if (!chapterScenes.length) continue;

          const base = 75 + (index / Math.max(1, chapters.length)) * 24;
          const span = 24 / Math.max(1, chapters.length);
          checkpoint(
            "rendering",
            Math.floor(base),
            `Đang dựng video ${index + 1}/${chapters.length} — ${chapter.title}`,
          );
          reportStage(
            "rendering",
            "Dựng video",
            outputs.length,
            chapters.length,
            `Chuẩn bị video ${index + 1}/${chapters.length} · ${chapter.title}`,
            1,
            Math.floor(base),
          );
          const result = await render(chapterScenes, s, (n) => {
            if (n >= 0.65 && s.burnSubtitles && !subtitlesReady) {
              updateJob(job.id, { subtitlesReady: true });
              subtitlesReady = true;
            }
            const renderProgress = Math.floor(base + n * span);
            checkpoint(
              "rendering",
              renderProgress,
              `Đang dựng video ${index + 1}/${chapters.length} — ${chapter.title}`,
            );
            reportStage(
              "rendering",
              "Dựng video",
              outputs.length,
              chapters.length,
              `Video ${index + 1}/${chapters.length} · FFmpeg ${Math.round(n * 100)}% · ${chapter.title}`,
              1,
              renderProgress,
            );
          });
          if (!assetExists(result.output))
            throw Error(`Không tìm thấy MP4 của ${chapter.title} sau khi xuất.`);
          await verifyVideo(path.join(assets, result.output));

          const child: Job = {
            ...job,
            id: chapters.length === 1 ? job.id : `${job.id}:${chapter.id}`,
            chapterIds: [chapter.id],
            outputTitle: chapter.title,
            outputMode: undefined,
            outputs: undefined,
            ...result,
            status: "done",
            progress: 100,
            verified: true,
            finishedAt: new Date().toISOString(),
            message: "MP4 đã xuất và kiểm tra thành công",
          };
          await createVideoRecord(child, p);
          outputs.push({
            chapterIds: [chapter.id],
            output: result.output,
            srt: result.srt,
            vtt: result.vtt,
            verified: true,
          });
          reportStage(
            "rendering",
            "Dựng video",
            outputs.length,
            chapters.length,
            `Đã xong ${outputs.length}/${chapters.length} video · ${chapter.title}`,
            1,
            Math.floor(base + span),
          );
          updateJob(job.id, {
            outputs,
            ...(chapters.length === 1
              ? {
                  output: result.output,
                  srt: result.srt,
                  vtt: result.vtt,
                  verified: true,
                }
              : {}),
            counts: {
              ...(get<Job>(job.id, "job").counts || {
                audio: scenes.length,
                image: scenes.length,
                total: scenes.length,
                failed: 0,
              }),
              rendered: outputs.length,
            },
          });
        }

        updateJob(job.id, {
          outputs,
          status: "done",
          progress: 100,
          verified: outputs.length === chapters.length && outputs.length > 0,
          finishedAt: new Date().toISOString(),
          message: `Đã tạo xong ${outputs.length}/${chapters.length} video`,
        });
        return;
      }

      checkpoint(
        "rendering",
        kind === "pipeline" ? 75 : 0,
        "FFmpeg đang dựng video từ tài nguyên thật",
      );
      reportStage(
        "rendering",
        "Dựng video",
        0,
        100,
        "FFmpeg đang chuẩn bị luồng hình, tiếng và phụ đề",
        1,
        kind === "pipeline" ? 75 : 0,
      );
      let subtitlesReady = false;
      const result = await render(scenes, s, (n) => {
        if (n >= 0.65 && s.burnSubtitles && !subtitlesReady) {
          updateJob(job.id, { subtitlesReady: true });
          subtitlesReady = true;
        }
        const renderProgress = Math.floor(
          (kind === "pipeline" ? 75 : 0) +
            n * (kind === "pipeline" ? 24 : 99),
        );
        checkpoint(
          "rendering",
          renderProgress,
          "FFmpeg đang mã hóa video",
        );
        reportStage(
          "rendering",
          "Dựng video",
          Math.round(n * 100),
          100,
          `FFmpeg đang mã hóa video · ${Math.round(n * 100)}%`,
          1,
          renderProgress,
        );
      });
      if (!assetExists(result.output))
        throw Error("Không tìm thấy MP4 sau khi xuất.");
      await verifyVideo(path.join(assets, result.output));
      checkpoint("rendering", 99, "Đã kiểm tra tệp video");
      const finished = updateJob(job.id, {
        ...result,
        status: "done",
        progress: 100,
        verified: true,
        finishedAt: new Date().toISOString(),
        message: "MP4 đã xuất và kiểm tra thành công",
      });
      await createVideoRecord(finished, p);
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          if (error !== "PAUSED" && error !== "CANCELLED")
            updateJob(job.id, {
              status: "error",
              finishedAt: new Date().toISOString(),
              error,
              message: "Video này xử lý thất bại — các video khác vẫn tiếp tục",
            });
        }
      })().finally(() => running.delete(task));
      running.add(task);
    }

    if (!running.size) await sleep(600);
    else await Promise.race([...running, sleep(250)]);
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
