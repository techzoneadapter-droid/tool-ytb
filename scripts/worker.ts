import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });
import { mkdir, unlink, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { acquireLock } from "../modules/providers/services";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  root,
  claim,
  get,
  list,
  put,
  updateJob,
} from "../modules/project/store";
import type { Job, Project } from "../modules/project/types";
import { speak, speakBatch } from "../modules/tts";
import { makeImage, makeStoryImageBatch } from "../modules/imagePrompt";
import {
  sceneVisual,
  ensureVisualProfile,
} from "../modules/imagePrompt/profile";
import { imageConfig } from "../modules/providers/config";
import { ttsSource } from "../modules/tts";
import {
  assetExists,
  requireSceneMedia,
  resolveSceneImage,
} from "../modules/project/media";
import { duration, verifyVideo } from "../modules/videoRender/process";
import { assets, render } from "../modules/videoRender";
import { makeMotion, usesMotion } from "../modules/providers/local-workers";
import { createVideoRecord, mergeVideoRecords } from "../modules/videoLibrary";
const lockPath = path.join(root, "worker.lock");
async function main() {
  await acquireLock(lockPath);
  const heartbeat = () =>
    writeFile(
      path.join(root, "worker.health.json"),
      JSON.stringify({ pid: process.pid, time: Date.now() }),
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
  console.log("StoryFlow: chỉ xử lý API và tài nguyên thật.");
  while (true) {
    const job = claim();
    if (!job) {
      await new Promise((r) => setTimeout(r, 1200));
      continue;
    }
    try {
      const p = get<Project>(job.projectId, "project");
      const s = job.snapshot.settings;
      for (const chapter of p.chapters.filter((c) =>
        job.chapterIds.includes(c.id),
      ))
        ensureVisualProfile(chapter, s);
      put("project", p);
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
        continue;
      }

      if (kind === "motion")
        scenes = scenes.filter((scene) => usesMotion(scene, s));
      if (!scenes.length) throw Error("Không có cảnh để xử lý.");
      const checkpoint = (
        status: Job["status"],
        progress: number,
        message: string,
      ) => {
        if (get<Job>(job.id, "job").status === "paused") throw Error("PAUSED");
        updateJob(job.id, {
          status,
          progress: Math.min(99, progress),
          message,
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
        const valid = async (
          scene: (typeof scenes)[number],
          type: "audio" | "image" | "motion",
        ) => {
          if (!assetExists(scene[type])) return false;
          try {
            if (type === "audio") {
              if (!scene.audioSource) return false;
              const seconds = await duration(path.join(assets, scene.audio!));
              if (!(seconds > 0)) return false;
              scene.duration = seconds;
            } else if (type === "image") {
              if (!scene.imageSource) return false;
              await sharp(path.join(assets, scene.image!)).stats();
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
          total: scenes.length,
          failed,
        });
        for (const type of tasks as ("audio" | "image" | "motion")[]) {
          for (const scene of scenes) {
            if (
              type === "audio" &&
              s.ttsProvider === "modal-vieneu" &&
              !completedItems.has(scene.id + ":audio") &&
              !(await valid(scene, "audio"))
            ) {
              const start = scenes.findIndex((item) => item.id === scene.id);
              const group: typeof scenes = [];
              for (const candidate of scenes.slice(Math.max(0, start))) {
                if (group.length >= 16) break;
                if (
                  !completedItems.has(candidate.id + ":audio") &&
                  !(await valid(candidate, "audio"))
                )
                  group.push(candidate);
              }
              if (group.length) {
                checkpoint(
                  "audio",
                  Math.floor(
                    (completed / Math.max(1, total)) *
                      (kind === "pipeline" ? 75 : 99),
                  ),
                  `VieNeu Cloud đang tạo ${group.length} lời đọc trong một batch`,
                );
                const files = group.map(() =>
                  path.join(assets, randomUUID() + ".mp3"),
                );
                for (const item of group) {
                  item.audioStatus = "working";
                  item.audioError = undefined;
                }
                put("project", p);
                try {
                  const durations = await speakBatch(
                    group.map((item, index) => ({
                      id: item.id,
                      text: item.text,
                      file: files[index],
                    })),
                    s,
                  );
                  for (let index = 0; index < group.length; index++) {
                    const item = group[index];
                    const seconds = durations.get(item.id);
                    if (!seconds) throw Error("VieNeu Cloud thiếu audio trong batch.");
                    item.audio = path.basename(files[index]);
                    item.audioSource = ttsSource(s);
                    item.duration = seconds;
                    item.audioStatus = "done";
                    item.audioError = undefined;
                    item.approved = !s.humanCheck;
                    completedItems.add(item.id + ":audio");
                  }
                  completed++;
                  put("project", p);
                  updateJob(job.id, {
                    completedItems: [...completedItems],
                    counts: counts(),
                  });
                  continue;
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : String(error);
                  for (const item of group) {
                    item.audioStatus = "error";
                    item.audioError = message;
                    failed++;
                  }
                  put("project", p);
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
                put("project", p);
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
                    completedItems.add(item.id + ":image");
                  }
                  completed++;
                  put("project", p);
                  updateJob(job.id, {
                    completedItems: [...completedItems],
                    counts: counts(),
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
                      completedItems.add(item.id + ":image");
                      usedFallback++;
                    } else {
                      failed++;
                    }
                  }
                  if (usedFallback === group.length) completed++;
                  put("project", p);
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
            if(type==='image' && !job.regenerate && completedItems.has(key) && scene.imageError && s.fallbackOnImageError && await resolveSceneImage(scene,s)) {
              completed++;updateJob(job.id,{counts:counts()});continue;
            }
            if (
              (!job.regenerate || completedItems.has(key)) &&
              (await valid(scene, type))
            ) {
              completedItems.add(key);
              scene[(type + "Status") as "audioStatus"] = "done";
              scene[(type + "Error") as "audioError"] = undefined;
              completed++;
              put("project", p);
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
            put("project", p);
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
                put("project", p);
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
              put("project", p);
              completed++;
              completedItems.add(key);
            } catch (e) {
              if (
                type === "image" &&
                s.fallbackOnImageError &&
                (await resolveSceneImage({ ...scene, image: undefined }, s))
              ) {
                scene.imageError = e instanceof Error ? e.message : String(e);
                scene.imageStatus = "error";
                scene.approved = !s.humanCheck;
                completed++;
                completedItems.add(key);
                put("project", p);
                updateJob(job.id, {
                  completedItems: [...completedItems],
                  counts: counts(),
                });
                continue;
              }
              scene[(type + "Status") as "audioStatus"] = "error";
              scene[(type + "Error") as "audioError"] =
                e instanceof Error ? e.message : String(e);
              put("project", p);
              failed++;
            }
            updateJob(job.id, {
              completedItems: [...completedItems],
              counts: counts(),
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
          continue;
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
        continue;
      }
      checkpoint(
        "rendering",
        kind === "pipeline" ? 75 : 0,
        "FFmpeg đang dựng video từ tài nguyên thật",
      );
      let subtitlesReady = false;
      const result = await render(scenes, s, (n) => {
        if (n >= 0.65 && s.burnSubtitles && !subtitlesReady) {
          updateJob(job.id, { subtitlesReady: true });
          subtitlesReady = true;
        }
        checkpoint(
          "rendering",
          Math.floor(
            (kind === "pipeline" ? 75 : 0) +
              n * (kind === "pipeline" ? 24 : 99),
          ),
          "FFmpeg đang mã hóa video",
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
      if (error !== "PAUSED")
        updateJob(job.id, {
          status: "error",
          finishedAt: new Date().toISOString(),
          error,
          message: "Xử lý thất bại — xem chi tiết lỗi",
        });
    }
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
