import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { flowHealth, flowFailure, waitForFlowSession } from "../modules/providers/flow-browser";
import { startService, FLOW_PROTOCOL } from "../modules/providers/services";
import { list, put, updateJob } from "../modules/project/store";
import type { Project, Job, Scene } from "../modules/project/types";
import { processProjectFlowScenes } from "../modules/pipeline/flow-runtime";
import { createVideoRecord } from "../modules/videoLibrary";
import { assets, render } from "../modules/videoRender";
import { verifyVideo } from "../modules/videoRender/process";

export async function smokeFlowScene() {
  const current = await flowHealth();
  const cookieFile = path.resolve(
    process.env.FLOW_COOKIES_FILE || "cookies.json",
  );
  // Preserve an older worker's RAM session: do not kill it when no restorable cookie exists.
  if (current.protocol !== FLOW_PROTOCOL && !existsSync(cookieFile)) {
    throw flowFailure(
      {
        code: "FLOW_LOGIN_REQUIRED",
        stage: "FLOW_SESSION_RESTORE",
        error:
          "Worker hiện tại dùng phiên RAM của bản cũ; chưa có cookie file để nạp vào worker mới. Phiên cũ được giữ nguyên.",
      },
      "",
    );
  }
  await startService("flow");
  const health = await waitForFlowSession();
  if (!health.sessionReady)
    throw flowFailure(
      {
        code: "FLOW_LOGIN_REQUIRED",
        stage: "FLOW_AUTH",
        error: health.lastError || "Chưa có phiên Flow được xác thực.",
      },
      "",
    );
  if (!health.generationReady)
    throw flowFailure(
      {
        code: "FLOW_COMPOSER_NOT_FOUND",
        stage: health.lastStage,
        error: health.lastError || "Flow chưa có composer sẵn sàng.",
      },
      "",
    );
  const source = list<Project>("project").find(
    (project) =>
      project.settings.imageProvider === "flow-browser" &&
      project.chapters.some((chapter) => chapter.scenes.length),
  );
  if (!source)
    throw Error(
      "SCENE_SOURCE_NOT_FOUND: Chưa có project Flow với cảnh thật để smoke test.",
    );
  const first = source.chapters.flatMap((chapter) => chapter.scenes)[0];
  const scene: Scene = {
    id: randomUUID(),
    text: first.text,
    prompt: first.prompt,
    duration: first.duration,
    approved: false,
  };
  const chapterId = randomUUID();
  const project: Project = {
    id: randomUUID(),
    name: "Flow live smoke · 1 cảnh",
    createdAt: new Date().toISOString(),
    settings: {
      ...structuredClone(source.settings),
      imageEnabled: true,
      audioEnabled: !process.argv.includes("--without-audio"),
      humanCheck: false,
      motionMode: "off",
      fallbackOnImageError: false,
    },
    chapters: [
      {
        id: chapterId,
        title: "Live smoke 1 cảnh",
        text: scene.text,
        scenes: [scene],
      },
    ],
  };
  const job: Job = {
    id: randomUUID(),
    projectId: project.id,
    chapterIds: [chapterId],
    sceneIds: [scene.id],
    kind: "pipeline",
    status: "audio",
    progress: 0,
    message: "Live smoke 1 cảnh",
    createdAt: new Date().toISOString(),
    snapshot: { settings: project.settings },
  };
  const oldImages = new Set(
    (await readdir(assets)).filter((name) => /\.(png|jpe?g)$/i.test(name)),
  );
  put("project", project);
  put("job", job);
  try {
    const errors = await processProjectFlowScenes(
      project,
      job,
      [scene],
      (event) => {
        updateJob(job.id, {
          status:
            event.status === "tts"
              ? "audio"
              : event.status === "rendering"
                ? "rendering"
                : "images",
          message: event.detail,
        });
        process.stdout.write(
          JSON.stringify({
            scene: 1,
            status: event.status,
            stage: event.stage,
            detail: event.detail,
          }) + "\n",
        );
      },
    );
    if (errors.length) {
      updateJob(job.id, { sceneErrors: errors });
      throw flowFailure(
        {
          code: errors[0].code,
          stage: errors[0].stage,
          error: errors[0].message,
        },
        "",
      );
    }
    updateJob(job.id, {
      status: "rendering",
      message: "Ghép MP4 và phụ đề cho cảnh live smoke",
    });
    const result = await render([scene], project.settings, () => {});
    await verifyVideo(path.join(assets, result.output));
    const unexpected = (await readdir(assets)).filter(
      (name) => /\.(png|jpe?g)$/i.test(name) && !oldImages.has(name),
    );
    if (unexpected.length)
      throw Error(
        "SCENE_DISK_IMAGE_FOUND: Smoke test detected intermediate image files.",
      );
    const finished = updateJob(job.id, {
      ...result,
      status: "done",
      verified: true,
      progress: 100,
      finishedAt: new Date().toISOString(),
      message: "Live Flow → Buffer → FFmpeg → MP4 thành công",
    });
    const video = await createVideoRecord(finished, project);
    process.stdout.write(
      JSON.stringify({
        ok: true,
        projectId: project.id,
        sceneId: scene.id,
        sceneVideo: scene.flow?.videoPath,
        videoId: video.id,
        output: result.output,
        intermediateImages: 0,
      }) + "\n",
    );
    return { ok: true, projectId: project.id, sceneId: scene.id, videoId: video.id, output: result.output, intermediateImages: 0 };
  } catch (error) {
    updateJob(job.id, {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      finishedAt: new Date().toISOString(),
      message: "Live smoke thất bại; các MP4 đã hoàn thành được giữ nguyên",
    });
    throw error;
  }
}
if (path.basename(process.argv[1] || "") === "smoke-flow-scene.ts") smokeFlowScene().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      ok: false,
      code: error.code || "SCENE_SMOKE_FAILED",
      stage: error.stage || "SCENE_SMOKE",
      message: error.message,
    }) + "\n",
  );
  process.exitCode = 1;
});
