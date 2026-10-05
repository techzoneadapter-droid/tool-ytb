import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type {
  Scene,
  Settings,
  Chapter,
  ChapterImageJob,
  ChapterRuntimeContext,
} from "../project/types";
import { sceneRenderKey, cachedSceneVideo } from "../videoRender/scene-cache";

export function configuredLimit(
  name: string,
  fallback: number,
  maximum: number,
) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value)
    ? Math.max(1, Math.min(maximum, Math.floor(value)))
    : fallback;
}

export class ConcurrencyGate {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private limit: () => number) {}
  private drain() {
    while (this.waiting.length && this.active < this.limit()) {
      this.active++;
      this.waiting.shift()!();
    }
  }
  async run<T>(action: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
      this.drain();
    });
    try {
      return await action();
    } finally {
      this.active--;
      this.drain();
    }
  }
}

// One session has one active generation; rendering uses its own bounded slots.
const flowSlots = new ConcurrencyGate(() => 1);
const renderSlots = new ConcurrencyGate(() =>
  configuredLimit("FLOW_RENDER_CONCURRENCY", 2, 4),
);
const chapterSlots = new ConcurrencyGate(() => 2);
// Keep at most two unfinished chapters warm for an explicit retry in this worker.
// Completed chapters drop their buffer immediately; restart naturally clears this cache.
const warmMasters = new Map<
  string,
  { context: ChapterRuntimeContext; job: ChapterImageJob; model: string }
>();
function discardMaster(key: string) {
  const cached = warmMasters.get(key);
  if (cached) cached.context.masterImageBuffer = undefined;
  warmMasters.delete(key);
}

export type FlowSceneEvent = {
  scene: Scene;
  index: number;
  status: NonNullable<Scene["flow"]>["status"];
  detail: string;
  stage?: string;
  fraction?: number;
  chapterId?: string;
  chapterImage?: ChapterImageJob;
};
export type FlowSceneDependencies = {
  assets: string;
  ensureVoice: (scene: Scene) => Promise<void>;
  generate: (
    prompt: string,
    aspect: Settings["aspect"],
    onStage: (stage: string) => void,
    mapping?: ChapterImageJob,
  ) => Promise<{ bytes: Buffer; model: string; mime?: string; generationCount?: number; imageCount?: number; submitCount?: number }>;
  render: (
    scene: Scene,
    buffer: Buffer,
    output: string,
    onProgress: (fraction: number) => void,
  ) => Promise<void>;
  verify: (output: string) => Promise<void>;
  persist: () => void | Promise<void>;
  publish: (scene: Scene, chapterId: string) => Promise<string>;
  shouldStop?: () => "PAUSED" | "CANCELLED" | undefined;
  onProgress?: (event: FlowSceneEvent) => void;
};
export type FlowSceneTarget = {
  scene: Scene;
  chapterId: string;
  prompt: string;
  chapter?: Chapter;
  projectId?: string;
  chapterIndex?: number;
};

export async function processFlowScenes(
  targets: FlowSceneTarget[],
  settings: Settings,
  deps: FlowSceneDependencies,
) {
  const errors: {
    sceneId: string;
    chapterId: string;
    sceneIndex: number;
    code: string;
    stage: string;
    message: string;
    requestId?: string;
  }[] = [];
  const checkStop = () => {
    const stop = deps.shouldStop?.();
    if (stop) throw Error(stop);
  };
  const groups = new Map<string, FlowSceneTarget[]>();
  for (const target of targets) {
    const group = groups.get(target.chapterId) || [];
    group.push(target);
    groups.set(target.chapterId, group);
  }
  // At most two chapter buffers in RAM. Flow chapter N+1 can run while N renders.
  const chapters = await Promise.allSettled(
    [...groups.values()].map((group) =>
      chapterSlots.run(async () => {
        checkStop();
        const first = group[0];
        const chapter = first.chapter;
        const cacheKey = createHash("sha256")
          .update(
            JSON.stringify([
              first.projectId,
              first.chapterId,
              first.prompt,
              settings.aspect,
            ]),
          )
          .digest("hex");
        const pending: FlowSceneTarget[] = [];
        const emit = (
          target: FlowSceneTarget,
          detail: string,
          stage?: string,
          fraction?: number,
        ) =>
          deps.onProgress?.({
            scene: target.scene,
            index: targets.indexOf(target),
            status: target.scene.flow!.status,
            detail,
            stage,
            fraction,
            chapterId: first.chapterId,
            chapterImage: chapter?.masterImage,
          });
        const fail = async (
          target: FlowSceneTarget,
          error: unknown,
          stage: string,
        ) => {
          const message =
            error instanceof Error ? error.message : String(error);
          if (["PAUSED", "CANCELLED"].includes(message)) throw error;
          const typed = error as { code?: string; stage?: string; requestId?: string };
          const code =
            typed.code ||
            /\[(FLOW_[A-Z_]+)/.exec(message)?.[1] ||
            stage + "_FAILED";
          const scene = target.scene;
          scene.flow!.status = "error";
          Object.assign(scene.flow!, {
            errorCode: code,
            errorMessage: message,
            errorStage: typed.stage || stage,
            updatedAt: new Date().toISOString(),
          });
          errors.push({
            sceneId: scene.id,
            chapterId: first.chapterId,
            sceneIndex: targets.indexOf(target) + 1,
            code,
            stage: typed.stage || stage,
            message,
            requestId: typed.requestId || chapter?.masterImage?.requestId || scene.chapterMasterImage,
          });
          await deps.persist();
          emit(target, code + ": " + message, typed.stage || stage);
        };
        // Verify existing clips before changing prompts: completed clips survive the migration/resume.
        for (const target of group) {
          const scene = target.scene;
          const cached = cachedSceneVideo(scene, settings, deps.assets);
          scene.flow = {
            ...scene.flow,
            sceneId: scene.id,
            chapterId: first.chapterId,
            prompt: first.prompt,
            status: "pending",
            updatedAt: new Date().toISOString(),
            errorCode: undefined,
            errorMessage: undefined,
            errorStage: undefined,
          };
          if (cached) {
            try {
              await deps.verify(cached);
            } catch {
              scene.flow.videoPath = undefined;
              scene.flow.renderKey = undefined;
            }
            if (scene.flow.videoPath) {
              try {
                scene.flow.status = "done";
                scene.flow.videoRecordId = await deps.publish(
                  scene,
                  first.chapterId,
                );
                await deps.persist();
                emit(target, "Giữ nguyên MP4 đã hoàn thành");
              } catch (e) {
                await fail(target, e, "SCENE_PUBLISH");
              }
              continue;
            }
          }
          scene.chapterId = first.chapterId;
          scene.chapterSceneIndex ??= chapter
            ? chapter.scenes.indexOf(scene)
            : group.indexOf(target);
          scene.finalImagePrompt = first.prompt;
          pending.push(target);
        }
        if (!pending.length) {
          discardMaster(cacheKey);
          return;
        }
        const warm = warmMasters.get(cacheKey);
        warmMasters.delete(cacheKey);
        const job: ChapterImageJob = warm?.job || {
          requestId: "flow_" + randomUUID(),
          projectId: first.projectId || "runtime",
          chapterId: first.chapterId,
          chapterIndex: first.chapterIndex || 0,
          prompt: first.prompt,
          status: "preparing",
          startedAt: new Date().toISOString(),
        };
        if (chapter) {
          chapter.masterImage = job;
          chapter.chapterImageGenerationCount = warm ? 1 : 0;
        }
        const context: ChapterRuntimeContext = warm?.context || {
          chapterId: first.chapterId,
        };
        let model = warm?.model || "project-current";
        try {
          for (const { scene } of pending) {
            scene.flow!.status = "image";
            scene.flow!.imageGenerated = !!warm;
            scene.imageStatus = "working";
            scene.imageError = undefined;
          }
          await deps.persist();
          emit(pending[0], "Đang tạo ảnh master của chương", "FLOW_PREPARE");
          try {
            const generated = warm
              ? {
                  bytes: context.masterImageBuffer!,
                  model,
                  mime: context.masterImageMime,
                  generationCount: job.generationCount,
                  submitCount: job.submitCount,
                  imageCount: job.imageCount,
                }
              : await flowSlots.run(async () => {
                  checkStop();
                  job.status = "submitting";
                  if (chapter) chapter.chapterImageGenerationCount = 1;
                  await deps.persist();
                  return deps.generate(
                    first.prompt,
                    settings.aspect,
                    (stage) => {
                      job.status = /RESULT/.test(stage)
                        ? "capturing"
                        : /GENERAT/.test(stage)
                          ? "generating"
                          : "submitting";
                      emit(pending[0], "Flow: " + stage, stage);
                    },
                    job,
                  );
                });
            context.masterImageBuffer = generated.bytes;
            context.masterImageMime = generated.mime;
            model = generated.model;
            job.generationCount = generated.generationCount;
            job.submitCount = generated.submitCount;
            job.imageCount = generated.imageCount;
            job.status = "ready";
            job.completedAt = new Date().toISOString();
            for (const { scene } of pending) {
              scene.chapterMasterImage = job.requestId;
              scene.imageStatus = "done";
              scene.imageError = undefined;
              scene.image = undefined;
              scene.imageEngine = scene.imageSource = "flow-browser";
              scene.imageModel = generated.model;
              // Compatibility flag denotes availability; there is no scene generation job.
              scene.flow!.imageGenerated = true;
            }
            await deps.persist();
            emit(pending[0], "Ảnh master sẵn sàng", "FLOW_RESULT_READY");
          } catch (error) {
            const typed = error as {
              code?: string;
              stage?: string;
              message?: string;
            };
            job.status = "error";
            job.errorCode = typed.code || "FLOW_RESULT_NOT_FOUND";
            job.errorMessage = typed.message || String(error);
            job.errorStage = typed.stage || "FLOW_GENERATION_WAIT";
            for (const { scene } of pending) {
              scene.imageStatus = "error";
              scene.imageError = job.errorMessage;
            }
            // One image failure per chapter, not N failed image assets.
            await fail(pending[0], error, "FLOW_GENERATION_WAIT");
            return;
          }
          emit(
            pending[0],
            "Dựng các cảnh từ ảnh master",
            "CHAPTER_RENDER_START",
          );
          const renders = await Promise.allSettled(
            pending.map((target) =>
              renderSlots.run(async () => {
                const scene = target.scene;
                try {
                  checkStop();
                  scene.flow!.status = "tts";
                  await deps.persist();
                  emit(target, "Chuẩn bị lời đọc");
                  await deps.ensureVoice(scene);
                  scene.flow!.voiceStatus =
                    settings.audioEnabled === false ? "skipped" : "done";
                  checkStop();
                  scene.flow!.status = "rendering";
                  await deps.persist();
                  const output = randomUUID() + ".mp4";
                  // A transient encode error retries with the very same master Buffer.
                  for (let attempt = 0; ; attempt++) {
                    try {
                      await deps.render(
                        scene,
                        context.masterImageBuffer!,
                        path.join(deps.assets, output),
                        (n) =>
                          emit(
                            target,
                            "FFmpeg đang encode",
                            "SCENE_RENDER_" + (scene.chapterSceneIndex! + 1),
                            n,
                          ),
                      );
                      break;
                    } catch (error) {
                      if (attempt >= 1) throw error;
                      checkStop();
                    }
                  }
                  scene.flow!.videoPath = output;
                  scene.flow!.renderKey = sceneRenderKey(scene, settings);
                  scene.flow!.status = "done";
                  scene.approved = !settings.humanCheck;
                  await deps.persist();
                  emit(target, "MP4 đã checkpoint");
                  scene.flow!.videoRecordId = await deps.publish(
                    scene,
                    first.chapterId,
                  );
                  await deps.persist();
                  emit(target, "MP4 đã xuất hiện trong Quản lý video");
                } catch (error) {
                  if (scene.flow!.status === "tts") {
                    scene.audioStatus = "error";
                    scene.audioError = String(error);
                  }
                  await fail(
                    target,
                    error,
                    scene.flow!.status === "tts"
                      ? "SCENE_TTS"
                      : scene.flow!.status === "done"
                        ? "SCENE_PUBLISH"
                        : "SCENE_RENDER",
                  );
                }
              }),
            ),
          );
          const stopped = renders.find(
            (r): r is PromiseRejectedResult => r.status === "rejected",
          );
          if (stopped) throw stopped.reason;
          emit(
            pending[0],
            "Đã xử lý các cảnh của chương",
            "CHAPTER_RENDER_DONE",
          );
        } finally {
          if (
            context.masterImageBuffer &&
            pending.some((t) => t.scene.flow?.status !== "done")
          ) {
            while (warmMasters.size >= 2)
              discardMaster(warmMasters.keys().next().value!);
            warmMasters.set(cacheKey, { context, job, model });
          } else {
            context.masterImageBuffer = undefined;
            context.masterImageMime = undefined;
          }
        }
      }),
    ),
  );
  const stopped = chapters.find(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  if (stopped) throw stopped.reason;
  return errors.sort((a, b) => a.sceneIndex - b.sceneIndex);
}
