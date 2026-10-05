import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Project, Scene, Settings } from "../project/types";

export function recoverInterruptedFlowScenes(project: Project) {
  let changed = false;
  for (const chapter of project.chapters)
    for (const scene of chapter.scenes) {
      if (
        scene.flow &&
        ["tts", "image", "rendering"].includes(scene.flow.status)
      ) {
        scene.flow.status = "pending";
        scene.flow.errorCode = "SCENE_INTERRUPTED";
        scene.flow.errorMessage =
          "Worker đã khởi động lại; cảnh có thể retry, MP4 đã hoàn thành được giữ nguyên.";
        scene.flow.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
  return changed;
}

export function sceneRenderKey(scene: Scene, settings: Settings) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "flow-scene-v1",
        scene.text,
        scene.prompt,
        scene.finalImagePrompt,
        scene.audio,
        scene.audioSource,
        scene.duration,
        settings.aspect,
        settings.imageProvider,
        settings.ttsProvider,
        settings.voice,
        settings.speed,
        settings.pitch,
        settings.volume,
        settings.pause,
        settings.audioEnabled,
      ]),
    )
    .digest("hex");
}

export function cachedSceneVideo(
  scene: Scene,
  settings: Settings,
  directory = path.resolve("data/assets"),
) {
  const checkpoint = scene.flow;
  if (
    !checkpoint?.videoPath ||
    checkpoint.renderKey !== sceneRenderKey(scene, settings) ||
    !/^[a-f0-9-]+\.mp4$/.test(checkpoint.videoPath)
  )
    return undefined;
  try {
    const file = path.join(directory, checkpoint.videoPath);
    if (existsSync(file) && statSync(file).size > 0)
      return checkpoint.videoPath;
  } catch {
    /* Missing checkpoint files are retryable. */
  }
  return undefined;
}
