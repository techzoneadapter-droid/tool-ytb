import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Scene, Settings } from "../project/types";
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

// Hold the Flow slot until encoding finishes, bounding all in-memory images
// across every concurrent chapter job, not just requests to /generate.
const flowSlots = new ConcurrencyGate(() =>
  configuredLimit("FLOW_CONCURRENCY", 1, 2),
);
const renderSlots = new ConcurrencyGate(() =>
  configuredLimit("FLOW_RENDER_CONCURRENCY", 2, 4),
);

export type FlowSceneEvent = {
  scene: Scene;
  index: number;
  status: NonNullable<Scene["flow"]>["status"];
  detail: string;
  stage?: string;
  fraction?: number;
};
export type FlowSceneDependencies = {
  assets: string;
  ensureVoice: (scene: Scene) => Promise<void>;
  generate: (
    prompt: string,
    aspect: Settings["aspect"],
    onStage: (stage: string) => void,
  ) => Promise<{ bytes: Buffer; model: string }>;
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
  existingImage?: (scene: Scene) => Promise<Buffer | undefined>;
  fallback?: (scene: Scene, error: unknown) => Promise<Buffer | undefined>;
};

export async function processFlowScenes(
  targets: { scene: Scene; chapterId: string; prompt: string }[],
  settings: Settings,
  deps: FlowSceneDependencies,
) {
  let next = 0;
  const errors: {
    sceneId: string;
    chapterId: string;
    sceneIndex: number;
    code: string;
    stage: string;
    message: string;
  }[] = [];
  const checkStop = () => {
    const stop = deps.shouldStop?.();
    if (stop) throw Error(stop);
  };
  async function processOne(index: number) {
    const { scene, chapterId, prompt } = targets[index];
    const emit = (detail: string, stage?: string, fraction?: number) =>
      deps.onProgress?.({
        scene,
        index,
        status: scene.flow!.status,
        detail,
        stage,
        fraction,
      });
    const persistStatus = async (
      status: NonNullable<Scene["flow"]>["status"],
      detail: string,
    ) => {
      scene.flow!.status = status;
      scene.flow!.updatedAt = new Date().toISOString();
      await deps.persist();
      emit(detail);
    };
    checkStop();
    scene.finalImagePrompt = prompt;
    scene.flow = {
      ...scene.flow,
      sceneId: scene.id,
      chapterId,
      prompt,
      status: "pending",
      errorCode: undefined,
      errorMessage: undefined,
      errorStage: undefined,
      updatedAt: new Date().toISOString(),
    };
    try {
      // Even a previous interrupted publish can reuse a verified MP4.
      const cached = cachedSceneVideo(scene, settings, deps.assets);
      if (cached) {
        try {
          await deps.verify(cached);
        } catch {
          scene.flow.videoPath = undefined;
          scene.flow.renderKey = undefined;
        }
        if (scene.flow.videoPath) {
          scene.flow.videoRecordId = await deps.publish(scene, chapterId);
          await persistStatus("done", "MP4 đã có; giữ nguyên cảnh hoàn thành");
          return;
        }
      }
      await persistStatus("tts", "Chuẩn bị lời đọc");
      await deps.ensureVoice(scene);
      scene.flow.voiceStatus =
        settings.audioEnabled === false ? "skipped" : "done";
      checkStop();
      await flowSlots.run(async () => {
        checkStop();
        let buffer: Buffer | undefined;
        let generated: { bytes: Buffer; model: string } | undefined;
        try {
          scene.imageStatus = "working";
          scene.imageError = undefined;
          scene.flow!.imageGenerated = false;
          await persistStatus("image", "Flow: đang xếp hàng gửi prompt");
          try {
            buffer = await deps.existingImage?.(scene);
            if (buffer) {
              scene.imageEngine = "upload";
              emit("Dùng ảnh tải lên đã chọn; không gửi prompt Flow");
            } else {
              generated = await deps.generate(
                prompt,
                settings.aspect,
                (stage) => emit("Flow: " + stage, stage),
              );
              buffer = generated.bytes;
              scene.imageModel = generated.model;
              scene.imageEngine = "flow-browser";
            }
          } catch (error) {
            buffer = await deps.fallback?.(scene, error);
            if (!buffer) throw error;
            scene.imageEngine = "shared";
            scene.imageError =
              error instanceof Error ? error.message : String(error);
          }
          scene.flow!.imageGenerated = true;
          scene.imageStatus = "done";
          if (scene.imageEngine !== "upload") scene.image = undefined;
          scene.imageSource = scene.imageEngine;
          scene.flow!.voiceStatus =
            settings.audioEnabled === false ? "skipped" : "done";
          await persistStatus(
            "rendering",
            `Ảnh ✓ · ${settings.audioEnabled === false ? "Lời đọc: tắt" : "Lời đọc ✓"} · FFmpeg đang encode`,
          );
          const output = randomUUID() + ".mp4";
          await renderSlots.run(() =>
            deps.render(
              scene,
              buffer!,
              path.join(deps.assets, output),
              (fraction) =>
                emit("FFmpeg đang encode", "SCENE_RENDER", fraction),
            ),
          );
          buffer = undefined;
          generated = undefined;
          // Persist the actual MP4 before publishing. Restart cannot lose this checkpoint.
          scene.flow!.videoPath = output;
          scene.flow!.renderKey = sceneRenderKey(scene, settings);
          scene.approved = !settings.humanCheck;
          await persistStatus("done", "MP4 đã render và kiểm tra");
          scene.flow!.videoRecordId = await deps.publish(scene, chapterId);
          await deps.persist();
          emit("MP4 đã xuất hiện trong Quản lý video");
        } finally {
          buffer = undefined;
          generated = undefined;
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "PAUSED" || message === "CANCELLED") throw error;
      const typed = error as { code?: string; stage?: string };
      const stage =
        typed.stage ||
        (scene.flow.status === "done"
          ? "SCENE_PUBLISH"
          : scene.flow.status === "rendering"
            ? "SCENE_RENDER"
            : scene.flow.status === "tts"
              ? "SCENE_TTS"
              : "FLOW_GENERATE");
      const code =
        typed.code ||
        /\[(FLOW_[A-Z_]+)/.exec(message)?.[1] ||
        (scene.flow.status === "done"
          ? "SCENE_PUBLISH_FAILED"
          : scene.flow.status === "tts"
            ? "SCENE_TTS_FAILED"
            : scene.flow.status === "rendering"
              ? "SCENE_RENDER_FAILED"
              : "FLOW_UI_CHANGED");
      scene.flow.errorCode = code;
      scene.flow.errorMessage = message;
      scene.flow.errorStage = stage;
      if (scene.flow.status === "tts") {
        scene.audioStatus = "error";
        scene.audioError = message;
        scene.flow.voiceStatus = "error";
      }
      if (scene.flow.status === "image") {
        scene.imageStatus = "error";
        scene.imageError = message;
      }
      errors.push({
        sceneId: scene.id,
        chapterId,
        sceneIndex: index + 1,
        code,
        stage,
        message,
      });
      await persistStatus("error", code + ": " + message);
    }
  }
  const results = await Promise.allSettled(
    Array.from(
      {
        length: Math.min(
          targets.length,
          configuredLimit("FLOW_CONCURRENCY", 1, 2),
        ),
      },
      async () => {
        while (next < targets.length) {
          const index = next++;
          await processOne(index);
        }
      },
    ),
  );
  const stopped = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (stopped) throw stopped.reason;
  return errors.sort((a, b) => a.sceneIndex - b.sceneIndex);
}
