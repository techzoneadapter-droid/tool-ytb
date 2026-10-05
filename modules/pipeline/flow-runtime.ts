import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Job, Project, Scene } from "../project/types";
import { get, mergeProjectChapters } from "../project/store";
import { assetExists, resolveSceneImage } from "../project/media";
import { speak, ttsSource } from "../tts";
import { makeFlowImageBuffer } from "../imagePrompt";
import { sceneVisual } from "../imagePrompt/profile";
import { assets } from "../videoRender";
import { renderSceneBuffer } from "../videoRender/scene";
import { duration, verifyVideo } from "../videoRender/process";
import { createSceneVideoRecord } from "../videoLibrary";
import { processFlowScenes, type FlowSceneEvent } from "./flow-scenes";

export function processProjectFlowScenes(
  project: Project,
  job: Job,
  scenes: Scene[],
  onProgress?: (event: FlowSceneEvent) => void,
) {
  const settings = job.snapshot.settings;
  const persist = () => {
    mergeProjectChapters(project, job.chapterIds);
  };
  return processFlowScenes(
    scenes.map((scene) => {
      const chapter = project.chapters.find((item) =>
        item.scenes.some((candidate) => candidate.id === scene.id),
      )!;
      const visual = sceneVisual(chapter, scene, settings);
      scene.imageSeed = visual.seed;
      return { scene, chapterId: chapter.id, prompt: visual.prompt };
    }),
    settings,
    {
      assets,
      persist,
      onProgress,
      shouldStop: () => {
        const status = get<Job>(job.id, "job").status;
        return status === "paused"
          ? "PAUSED"
          : status === "cancelled"
            ? "CANCELLED"
            : undefined;
      },
      ensureVoice: async (scene) => {
        if (settings.audioEnabled === false) return;
        if (scene.audioSource && assetExists(scene.audio)) {
          try {
            const seconds = await duration(path.join(assets, scene.audio!));
            if (seconds > 0) {
              scene.duration = seconds;
              scene.audioStatus = "done";
              scene.audioError = undefined;
              return;
            }
          } catch {
            /* A corrupt audio file must be recreated through the existing TTS engine. */
          }
        }
        scene.audioStatus = "working";
        persist();
        const file = randomUUID() + ".mp3";
        scene.duration = await speak(
          scene.text,
          path.join(assets, file),
          settings,
        );
        scene.audio = file;
        scene.audioSource = ttsSource(settings);
        scene.audioStatus = "done";
        scene.audioError = undefined;
        persist();
      },
      generate: (prompt, aspect, onStage) =>
        makeFlowImageBuffer(prompt, { ...settings, aspect }, onStage),
      existingImage: async (scene) => {
        if (scene.imageSource !== "upload") return undefined;
        const image = await resolveSceneImage(scene);
        return image ? readFile(path.join(assets, image)) : undefined;
      },
      render: async (scene, buffer, outputPath, onProgress) => {
        await renderSceneBuffer({
          imageBuffer: buffer,
          scene,
          settings,
          outputPath,
          audioPath:
            settings.audioEnabled !== false && scene.audio
              ? path.join(assets, scene.audio)
              : undefined,
          onProgress,
        });
      },
      verify: async (output) => {
        await verifyVideo(path.join(assets, output));
      },
      publish: async (scene, chapterId) =>
        (await createSceneVideoRecord(scene, chapterId, project, job.id)).id,
      fallback: settings.fallbackOnImageError
        ? async (scene) => {
            const image = await resolveSceneImage(
              { ...scene, image: undefined },
              settings,
            );
            return image ? readFile(path.join(assets, image)) : undefined;
          }
        : undefined,
    },
  );
}
