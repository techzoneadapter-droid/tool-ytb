import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });
import { mkdir, unlink, writeFile } from "node:fs/promises";
import sharp from "sharp";
import {
  acquireLock,
  startService,
  WORKER_PROTOCOL,
} from "../modules/providers/services";
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
import {
  uploadedImageSettings,
  imageGenerationRemoved,
} from "../modules/project/uploaded-image";
import {
  pipelineConcurrency,
  providerConcurrency,
  withResourceContext,
} from "../modules/pipeline/resources";
import { vieneuHealth } from "../modules/tts/local";
import { speak, speakBatch } from "../modules/tts";
import { processChapterImages } from "../modules/pipeline/chapter-images";
import { ImagePipelineError } from "../modules/providers/api-image-provider";
import { configuredLimit } from "../modules/pipeline/flow-scenes";
import { processProjectFlowScenes } from "../modules/pipeline/flow-runtime";
import { recoverInterruptedFlowScenes } from "../modules/videoRender/scene-cache";
import { ensureVisualProfile } from "../modules/imagePrompt/profile";
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

async function splitLegacyPipelineJobs() {
  const candidates = list<Job>("job").filter(
    (job) =>
      job.kind === "pipeline" &&
      job.status === "queued" &&
      job.outputMode !== "merged" &&
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
        return sceneIds.has(sceneId) || key === chapterId + ":image";
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
  for (const project of list<Project>("project")) {
    if (recoverInterruptedFlowScenes(project)) put("project", project);
  }
  for (const j of list<Job>("job"))
    if (["audio", "images", "rendering"].includes(j.status))
      updateJob(j.id, { status: "queued", message: "Khôi phục xử lý" });
  await splitLegacyPipelineJobs();
  const maxParallelVideos = pipelineConcurrency();
  const running = new Set<Promise<void>>();
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  console.log(
    `StoryFlow: pipeline độc lập theo video · tối đa ${maxParallelVideos} video chạy song song.`,
  );
  while (true) {
    while (running.size < pipelineConcurrency()) {
      const job = claim();
      if (!job) break;
      let task!: Promise<void>;
      task = withResourceContext(
        {
          onWait: (resource) =>
            updateJob(job.id, { waitingResource: "Đang chờ " + resource }),
          onAcquired: () => updateJob(job.id, { waitingResource: undefined }),
        },
        async () => {
          try {
            const p = get<Project>(job.projectId, "project");
            const saveProject = () => {
              mergeProjectChapters(p, job.chapterIds);
            };
            // Also migrate queued snapshots created before image generation was removed.
            if (job.snapshot.settings.imageEnabled !== false)
              for (const chapter of p.chapters.filter((c) =>
                job.chapterIds.includes(c.id),
              ))
                for (const scene of chapter.scenes) {
                  scene.motion = undefined;
                  scene.motionStatus = undefined;
                  scene.motionError = undefined;
                }
            const s = uploadedImageSettings(job.snapshot.settings);
            job.snapshot.settings = s;
            updateJob(job.id, { snapshot: job.snapshot });
            if (s.imageEnabled !== false)
              for (const chapter of p.chapters.filter((c) =>
                job.chapterIds.includes(c.id),
              ))
                ensureVisualProfile(chapter, s);
            saveProject();
            // Project order is authoritative even if the request selected IDs in reverse order.
            let scenes = p.chapters
              .filter((c) => job.chapterIds.includes(c.id))
              .flatMap((c) => c.scenes)
              .filter(
                (scene) => !job.sceneIds || job.sceneIds.includes(scene.id),
              );
            const kind = job.kind || (job.prepare ? "prepare" : "render");
            if (kind === "image") throw Error(imageGenerationRemoved);
            if (s.imageEnabled === false) {
              console.log(
                `job=${job.id} IMAGE_MODE=SHARED fallbackImage=${s.fallbackImage || "missing"} imageGenerationSkipped=true`,
              );
              updateJob(job.id, {
                imageMode: "shared",
                sharedImageValid: await validImage(s.fallbackImage),
              });
            }
            let partialResourceError = "";

            if (kind === "merge-video") {
              updateJob(job.id, {
                status: "rendering",
                progress: 10,
                message: "Đang ghép các video đã chọn",
              });
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
              if (currentStatus === "paused" || currentStatus === "cancelled")
                return;
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
              updateJob(job.id, {
                message: "Đã kiểm tra ảnh cảnh / ảnh dùng chung",
              });
            }
            const flowScenePipeline =
              s.imageProvider === "flow-browser" &&
              s.imageEnabled !== false &&
              ["pipeline", "prepare", "image", "render"].includes(kind);
            if (flowScenePipeline) {
              updateJob(job.id, { sceneErrors: [], error: undefined });
              const started = new Map<string, number>();
              const stageLabels: Record<string, string> = {
                FLOW_SERVICE_START: "Khởi động Flow Worker...",
                FLOW_SESSION_RESTORE: "Đang khôi phục phiên Flow...",
                FLOW_SESSION_CONNECT: "Đang khôi phục phiên Flow...",
                FLOW_PROJECT_OPEN: "Đang mở dự án Flow...",
                FLOW_COMPOSER_WAIT: "Đang chờ trình tạo ảnh...",
                FLOW_READY: "Flow sẵn sàng",
                FLOW_PROMPT_FIND: "Tìm composer",
                FLOW_PROMPT_INJECT: "Điền prompt",
                FLOW_PROMPT_SYNC: "Xác nhận state prompt",
                FLOW_SUBMIT_DISCOVER: "Tìm nút Generate",
                FLOW_SUBMIT_ATTEMPT_1: "Gửi prompt lần 1",
                FLOW_SUBMIT_VERIFY_1: "Xác nhận submit",
                FLOW_SUBMIT_ATTEMPT_2: "Gửi bằng phương pháp dự phòng",
                FLOW_GENERATION_START_WAIT: "Xác nhận generation",
                FLOW_GENERATING: "Flow đang tạo ảnh",
                FLOW_RESULT_WAIT: "Chờ ảnh",
                FLOW_RESULT_READY: "Đã nhận ảnh",
                FLOW_AUTH: "Kiểm tra phiên",
                FLOW_COMPOSER_READY: "Composer sẵn sàng",
                FLOW_PROMPT_INPUT: "Điền prompt",
                FLOW_PROMPT_SENT: "Đã gửi prompt",
                FLOW_GENERATION_START: "Xác nhận generation",
                FLOW_GENERATION_STARTED: "Generation đã bắt đầu",
                FLOW_WAIT_IMAGE: "Đã gửi prompt · Đang chờ model của project",
                FLOW_RESULT_DOWNLOAD: "Nhận bytes trong RAM",
              };
              const errors = await processProjectFlowScenes(
                p,
                job,
                scenes,
                (event) => {
                  const done = scenes.filter(
                    (scene) => scene.flow?.status === "done",
                  ).length;
                  const failed = new Set(
                    scenes
                      .filter((scene) => scene.flow?.status === "error")
                      .map((scene) =>
                        p.chapters.find(
                          (chapter) => chapter.id === scene.flow?.chapterId,
                        )?.masterImage?.status === "error"
                          ? scene.flow!.chapterId
                          : scene.id,
                      ),
                  ).size;
                  const status =
                    event.status === "tts"
                      ? "audio"
                      : event.status === "rendering" || event.status === "done"
                        ? "rendering"
                        : "images";
                  const label =
                    event.status === "tts"
                      ? "Lời đọc"
                      : event.status === "rendering" || event.status === "done"
                        ? "Dựng video"
                        : "Tạo ảnh chương";
                  started.set(
                    event.scene.id,
                    started.get(event.scene.id) || Date.now(),
                  );
                  const chapter = p.chapters.find(
                    (c) => c.id === event.chapterId,
                  );
                  const imageStage = event.status === "image";
                  const detail = `${chapter?.title || "Chương"} · ${imageStage ? "Ảnh master" : `Cảnh ${(event.scene.chapterSceneIndex || 0) + 1}/${chapter?.scenes.length || scenes.length}`} · ${event.stage ? stageLabels[event.stage] || event.stage : event.detail}${event.fraction === undefined ? "" : ` · FFmpeg ${Math.round(event.fraction * 100)}%`}`;
                  reportStage(
                    status,
                    label,
                    imageStage
                      ? p.chapters.filter(
                          (c) =>
                            job.chapterIds.includes(c.id) &&
                            c.masterImage?.status === "ready",
                        ).length
                      : done,
                    imageStage ? job.chapterIds.length : scenes.length,
                    detail,
                    imageStage
                      ? 1
                      : configuredLimit("FLOW_RENDER_CONCURRENCY", 2, 4),
                    Math.floor((done / scenes.length) * 75),
                  );
                  const current = get<Job>(job.id, "job");
                  if (!["paused", "cancelled"].includes(current.status))
                    updateJob(job.id, {
                      counts: {
                        audio: scenes.filter(
                          (scene) =>
                            scene.audioStatus === "done" ||
                            s.audioEnabled === false,
                        ).length,
                        image: p.chapters.filter(
                          (chapter) =>
                            job.chapterIds.includes(chapter.id) &&
                            chapter.masterImage?.status === "ready",
                        ).length,
                        imageTotal: job.chapterIds.length,
                        rendered: done,
                        failed,
                        total: scenes.length,
                      },
                      completedItems: scenes
                        .filter((scene) => scene.flow?.status === "done")
                        .flatMap((scene) => [
                          scene.id + ":audio",
                          scene.id + ":render",
                        ])
                        .concat(
                          p.chapters
                            .filter(
                              (chapter) =>
                                job.chapterIds.includes(chapter.id) &&
                                chapter.masterImage?.status === "ready",
                            )
                            .map((chapter) => chapter.id + ":image"),
                        ),
                      stageProgress: current.stageProgress
                        ? {
                            ...current.stageProgress,
                            elapsedSeconds: Math.floor(
                              (Date.now() - started.get(event.scene.id)!) /
                                1000,
                            ),
                          }
                        : undefined,
                      sceneErrors: scenes
                        .flatMap((scene, index) =>
                          scene.flow?.status === "error"
                            ? [
                                {
                                  sceneId: scene.id,
                                  chapterId: scene.flow.chapterId,
                                  sceneIndex: index + 1,
                                  code: scene.flow.errorCode!,
                                  stage: scene.flow.errorStage!,
                                  message: scene.flow.errorMessage!,
                                },
                              ]
                            : [],
                        )
                        .filter(
                          (error, index, all) =>
                            p.chapters.find(
                              (chapter) => chapter.id === error.chapterId,
                            )?.masterImage?.status !== "error" ||
                            all.findIndex(
                              (item) => item.chapterId === error.chapterId,
                            ) === index,
                        ),
                    });
                },
              );
              updateJob(job.id, { sceneErrors: errors });
              if (errors.length)
                throw Error(
                  errors
                    .map(
                      (error) =>
                        `${p.chapters.find((c) => c.id === error.chapterId)?.masterImage?.status === "error" ? "Ảnh master chương" : "Cảnh " + error.sceneIndex}: [${error.code}] ${error.stage} · ${error.message}`,
                    )
                    .join("\n"),
                );
              if (["prepare", "image"].includes(kind)) {
                updateJob(job.id, {
                  status: "ready",
                  progress: 100,
                  message: `Đã lưu ${scenes.length} scene MP4 trong Quản lý video; ảnh đã giải phóng khỏi RAM.`,
                });
                return;
              }
            }
            if (kind !== "render" && !flowScenePipeline) {
              let completed = 0;
              let failed = 0;
              let recoveredImageFailures = 0;
              const completedItems = new Set(job.completedItems || []);
              updateJob(job.id, { subtitlesReady: false });
              const tasks =
                kind === "prepare" || kind === "pipeline"
                  ? [
                      ...(s.imageProvider === "flow-browser" &&
                      s.imageEnabled !== false
                        ? ["image"]
                        : []),
                      ...(s.audioEnabled === false ? [] : ["audio"]),
                      ...(s.imageEnabled === false ||
                      s.imageProvider === "flow-browser"
                        ? []
                        : ["image"]),
                      ...(kind === "pipeline" &&
                      s.motionMode &&
                      s.motionMode !== "off"
                        ? ["motion"]
                        : []),
                    ]
                  : [kind];
              const imageChapters = p.chapters.filter(
                (chapter) =>
                  job.chapterIds.includes(chapter.id) &&
                  chapter.scenes.some((scene) => scenes.includes(scene)),
              );
              const handledThisRun = new Set<string>();
              const relevantKeys = [
                ...scenes.flatMap((scene) =>
                  tasks
                    .filter(
                      (type) =>
                        type !== "image" &&
                        (type !== "motion" || usesMotion(scene, s)),
                    )
                    .map((type) => scene.id + ":" + type),
                ),
                ...(tasks.includes("image")
                  ? imageChapters.map((chapter) => chapter.id + ":image")
                  : []),
              ];
              const total = relevantKeys.length;
              // Older workers stored scene image keys; chapter keys are revalidated below.
              for (const scene of scenes)
                completedItems.delete(scene.id + ":image");
              for (const chapter of imageChapters)
                completedItems.delete(chapter.id + ":image");
              completed = relevantKeys.filter((key) =>
                completedItems.has(key),
              ).length;
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
                    const seconds = await duration(
                      path.join(assets, scene.audio!),
                    );
                    if (!(seconds > 0)) return false;
                    scene.duration = seconds;
                  } else
                    await verifyVideo(path.join(assets, scene.motion!), false);
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
                    ? job.chapterIds.length
                    : imageChapters.filter((chapter) =>
                        completedItems.has(chapter.id + ":image"),
                      ).length,
                imageTotal: imageChapters.length,
                motion: scenes.filter((x) =>
                  completedItems.has(x.id + ":motion"),
                ).length,
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
                    : type === "image"
                      ? imageChapters.length
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
              if (tasks.includes("audio") && s.ttsProvider === "vieneu-local") {
                checkpoint(
                  "audio",
                  1,
                  "Đang khởi động VieNeu Local và nạp giọng đọc",
                );
                await startService("vieneu");
              }

              for (const type of tasks as ("audio" | "image" | "motion")[]) {
                if (type === "image") {
                  const chapters = imageChapters;
                  const errors = await processChapterImages(p, chapters, s, {
                    save: saveProject,
                    load: () => get<Project>(p.id, "project"),
                    stage: (chapter, label, detail) => {
                      if (chapter.apiImage?.status === "ready")
                        finishKey(chapter.id + ":image");
                      updateJob(job.id, {
                        counts: counts(),
                        completedItems: [...completedItems],
                      });
                      checkpoint(
                        "images",
                        Math.floor((completed / Math.max(1, total)) * 75),
                        detail,
                      );
                      reportStage(
                        "images",
                        label,
                        counts().image,
                        chapters.length,
                        `${chapter.title} · ${detail}`,
                        s.imageAPIOptions?.concurrency ?? 2,
                      );
                    },
                  });
                  updateJob(job.id, {
                    sceneErrors: errors.map((error) => ({
                      ...error,
                      sceneId: p.chapters.find((c) => c.id === error.chapterId)!
                        .scenes[0].id,
                      sceneIndex: 0,
                      stage: "CHAPTER_IMAGE",
                      requestId: p.chapters.find(
                        (c) => c.id === error.chapterId,
                      )?.apiImage?.requestId,
                    })),
                  });
                  for (const chapter of chapters) {
                    const validScenes = await Promise.all(
                      chapter.scenes
                        .filter((scene) => scenes.includes(scene))
                        .map((scene) => valid(scene, "image")),
                    );
                    const masterFailed = errors.some(
                      (error) => error.chapterId === chapter.id,
                    );
                    if (masterFailed) failed++;
                    if (validScenes.every(Boolean)) {
                      finishKey(chapter.id + ":image");
                      if (masterFailed) recoveredImageFailures++;
                    } else if (!masterFailed) failed++;
                  }
                  updateJob(job.id, {
                    completedItems: [...completedItems],
                    counts: counts(),
                  });
                  continue;
                }
                for (const scene of scenes) {
                  const loopKey = scene.id + ":" + type;
                  if (handledThisRun.has(loopKey)) continue;
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
                    const start = scenes.findIndex(
                      (item) => item.id === scene.id,
                    );
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
                        s.ttsProvider === "vieneu-local"
                          ? (await vieneuHealth()).maxStreams
                          : providerConcurrency(s.ttsProvider || "cloud");
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
                        group.map((item, index) => [item.id, { item, index }]),
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
                            chapterId: p.chapters.find((c) =>
                              c.scenes.some((x) => x.id === item.id),
                            )?.id,
                          })),
                          s,
                          {
                            onError: (id, error) => {
                              const item = byId.get(id)?.item;
                              if (item) {
                                item.audioError = error.message;
                                item.audioStatus = "error";
                                saveProject();
                              }
                            },
                            onRequestProgress: (event) => {
                              const current = get<Job>(job.id, "job");
                              if (
                                ["paused", "cancelled"].includes(current.status)
                              )
                                return;
                              updateJob(job.id, {
                                ttsRequests: {
                                  ...current.ttsRequests,
                                  [event.sceneId || "unknown"]: event,
                                },
                                waitingResource:
                                  event.state === "waiting"
                                    ? "Đang chờ lượt VieNeu"
                                    : undefined,
                              });
                            },
                            shouldStop: () => {
                              const status = get<Job>(job.id, "job").status;
                              return (
                                status === "paused" || status === "cancelled"
                              );
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
                          if (
                            !durations.has(item.id) &&
                            !completedItems.has(item.id + ":audio")
                          )
                            throw Error(
                              "Engine giọng đọc thiếu audio trong batch.",
                            );
                        }
                        continue;
                      } catch (error) {
                        const message =
                          error instanceof Error
                            ? error.message
                            : String(error);
                        if (message === "PAUSED" || message === "CANCELLED")
                          throw error;
                        for (const item of group) {
                          if (completedItems.has(item.id + ":audio")) continue;
                          item.audioStatus = "error";
                          item.audioError ||= message;
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
                      p.chapters.find((c) =>
                        c.scenes.some((x) => x.id === scene.id),
                      )?.title +
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
                    }
                    scene[(type + "Status") as "audioStatus"] = "done";
                    scene.approved = !s.humanCheck;
                    saveProject();
                    finishKey(key);
                  } catch (e) {
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
              if (failed > recoveredImageFailures) {
                const message = `${failed} tài nguyên lỗi. Thử lại chỉ xử lý tài nguyên lỗi hoặc còn thiếu. ${scenes.flatMap((scene) => [scene.audioError, scene.imageError, scene.motionError]).find(Boolean) || ""}`;
                if (kind !== "pipeline" || job.outputMode !== "merged")
                  throw Error(message);
                const readyChapters = new Set<string>();
                for (const chapter of p.chapters.filter((chapter) =>
                  job.chapterIds.includes(chapter.id),
                )) {
                  if (
                    (
                      await Promise.all(
                        chapter.scenes.map(
                          async (scene) =>
                            (s.audioEnabled === false ||
                              (await valid(scene, "audio"))) &&
                            !!(await resolveSceneImage(scene, s)) &&
                            (!usesMotion(scene, s) ||
                              (await valid(scene, "motion"))),
                        ),
                      )
                    ).every(Boolean)
                  )
                    readyChapters.add(chapter.id);
                }
                scenes = scenes.filter((scene) =>
                  p.chapters.some(
                    (chapter) =>
                      readyChapters.has(chapter.id) &&
                      chapter.scenes.includes(scene),
                  ),
                );
                if (!scenes.length) throw Error(message);
                partialResourceError = message;
              }
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
                  throw Error(
                    "Ảnh động đã bật nhưng cảnh chưa có clip Wan hợp lệ.",
                  );
                await verifyVideo(path.join(assets, scene.motion), false);
              }
              if (scene.audio && assetExists(scene.audio))
                scene.duration = await duration(path.join(assets, scene.audio));
              else if (s.audioEnabled !== false)
                throw Error("Cảnh chưa có lời đọc thật.");
              if (!Number.isFinite(scene.duration) || scene.duration <= 0)
                throw Error("Tệp lời đọc không có thời lượng hợp lệ.");
            }
            if (s.humanCheck && scenes.some((scene) => !scene.approved)) {
              updateJob(job.id, {
                status: "paused",
                message:
                  "Tài nguyên đã lưu. Duyệt cảnh bên dưới rồi nhấn Tiếp tục.",
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
                  throw Error(
                    `Không tìm thấy MP4 của ${chapter.title} sau khi xuất.`,
                  );
                await verifyVideo(path.join(assets, result.output));

                const child: Job = {
                  ...job,
                  id:
                    chapters.length === 1 ? job.id : `${job.id}:${chapter.id}`,
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
                      image: chapters.length,
                      imageTotal: chapters.length,
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
                verified:
                  outputs.length === chapters.length && outputs.length > 0,
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
            await createVideoRecord(
              {
                ...finished,
                chapterIds: p.chapters
                  .filter((chapter) =>
                    chapter.scenes.some((scene) => scenes.includes(scene)),
                  )
                  .map((chapter) => chapter.id),
              },
              p,
            );
            if (partialResourceError)
              updateJob(job.id, {
                status: "error",
                error: partialResourceError,
                message:
                  "Đã lưu video các chương thành công; một số chương cần thử lại.",
              });
          } catch (e) {
            let error =
              e instanceof Error
                ? `${e instanceof ImagePipelineError ? e.code + ": " : ""}${e.message}`
                : String(e);
            if (
              get<Job>(job.id, "job").status === "rendering" &&
              !/^FLOW_|VIDEO_RENDER_FAILED/.test(error)
            )
              error = "VIDEO_RENDER_FAILED: " + error;
            if (error !== "PAUSED" && error !== "CANCELLED")
              updateJob(job.id, {
                status: "error",
                finishedAt: new Date().toISOString(),
                error,
                message:
                  "Video này xử lý thất bại — các video khác vẫn tiếp tục",
              });
          }
        },
      ).finally(() => running.delete(task));
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
