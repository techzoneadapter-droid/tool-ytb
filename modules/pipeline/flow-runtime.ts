import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Job, Project, Scene } from "../project/types";
import { get, mergeProjectChapters, updateJob } from "../project/store";
import { assetExists } from "../project/media";
import { speak, ttsSource } from "../tts";
import { makeFlowImageBuffer } from "../imagePrompt";
import {
  buildChapterImagePrompt,
  ensureCharacterBible,
} from "../imagePrompt/chapter";
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
  ensureCharacterBible(project);
  const persist = () => {
    mergeProjectChapters(project, job.chapterIds);
  };
  return processFlowScenes(
    scenes.map((scene) => {
      const chapter = project.chapters.find((item) =>
        item.scenes.some((candidate) => candidate.id === scene.id),
      )!;
      return {
        scene,
        chapter,
        projectId: project.id,
        chapterIndex: project.chapters.indexOf(chapter),
        chapterId: chapter.id,
        prompt: buildChapterImagePrompt(project, chapter, settings),
      };
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
          {
            sceneId: scene.id,
            chapterId: project.chapters.find((c) =>
              c.scenes.some((s) => s.id === scene.id),
            )?.id,
            onRequestProgress: (event) => {
              const current = get<Job>(job.id, "job");
              if (["paused", "cancelled"].includes(current.status)) return;
              updateJob(job.id, {
                ttsRequests: { ...current.ttsRequests, [scene.id]: event },
                waitingResource:
                  event.state === "waiting"
                    ? "Đang chờ lượt VieNeu"
                    : undefined,
              });
            },
          },
        );
        scene.audio = file;
        scene.audioSource = ttsSource(settings);
        scene.audioStatus = "done";
        scene.audioError = undefined;
        persist();
      },
      generate: (prompt, aspect, onStage, mapping) =>
        makeFlowImageBuffer(prompt, { ...settings, aspect }, onStage, mapping),
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
    },
  );
}
