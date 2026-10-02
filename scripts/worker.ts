import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });
import { mkdir, open, unlink } from "node:fs/promises";
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
import { speak } from "../modules/tts";
import { makeImage } from "../modules/imagePrompt";
import { imageConfig } from "../modules/providers/config";
import { ttsSource } from "../modules/tts";
import { assetExists, requireSceneMedia } from "../modules/project/media";
import { duration, verifyVideo } from "../modules/videoRender/process";
import { assets, render } from "../modules/videoRender";
import { makeMotion, usesMotion } from "../modules/providers/local-workers";
const lockPath = path.join(root, "worker.lock");
async function main() {
  const lock = await open(lockPath, "wx").catch(() => {
    throw Error(
      "Tiến trình xử lý khác đang chạy hoặc còn khóa cũ. Xem README.",
    );
  });
  await lock.writeFile(String(process.pid));
  await lock.close();
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
      // Project order is authoritative even if the request selected IDs in reverse order.
      let scenes = p.chapters
        .filter((c) => job.chapterIds.includes(c.id))
        .flatMap((c) => c.scenes)
        .filter((scene) => !job.sceneIds || job.sceneIds.includes(scene.id));
      const kind = job.kind || (job.prepare ? "prepare" : "render");
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
      if (kind !== "render") {
        let completed = 0;
        const tasks =
          kind === "prepare"
            ? s.imageEnabled === false
              ? ["audio"]
              : ["audio", "image"]
            : [kind];
        const total = scenes.length * tasks.length;
        for (const scene of scenes) {
          for (const type of tasks as ("audio" | "image" | "motion")[]) {
            checkpoint(
              type === "audio" ? "audio" : "images",
              Math.floor((completed / total) * 99),
              "Đang tạo " +
                (type === "audio"
                  ? "lời đọc"
                  : type === "motion"
                    ? "ảnh động"
                    : "ảnh") +
                " cảnh " +
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
                await makeImage(scene.prompt, path.join(assets, file), s);
                scene.image = file;
                scene.imageSource = s.imageProvider || imageConfig().provider;
                scene.motion = undefined;
                scene.motionStatus = undefined;
                scene.motionError = undefined;
              }
              scene[(type + "Status") as "audioStatus"] = "done";
              scene.approved = false;
              put("project", p);
              completed++;
            } catch (e) {
              scene[(type + "Status") as "audioStatus"] = "error";
              scene[(type + "Error") as "audioError"] =
                e instanceof Error ? e.message : String(e);
              put("project", p);
              throw e;
            }
          }
        }
        checkpoint(
          "ready",
          99,
          "Tài nguyên thật đã lưu. Có thể nghe, xem và duyệt cảnh.",
        );
        updateJob(job.id, { status: "ready", progress: 0 });
        continue;
      }
      for (const scene of scenes) {
        requireSceneMedia(scene);
        scene.duration = await duration(path.join(assets, scene.audio!));
        if (!Number.isFinite(scene.duration) || scene.duration <= 0)
          throw Error("Tệp lời đọc không có thời lượng hợp lệ.");
      }
      checkpoint("rendering", 0, "FFmpeg đang dựng video từ tài nguyên thật");
      const result = await render(scenes, s, (n) =>
        checkpoint("rendering", Math.floor(n * 99), "FFmpeg đang mã hóa video"),
      );
      if (!assetExists(result.output))
        throw Error("Không tìm thấy MP4 sau khi xuất.");
      await verifyVideo(path.join(assets, result.output));
      checkpoint("rendering", 99, "Đã kiểm tra tệp video");
      updateJob(job.id, {
        ...result,
        status: "done",
        progress: 100,
        verified: true,
        message: "MP4 đã xuất và kiểm tra thành công",
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (error !== "PAUSED")
        updateJob(job.id, {
          status: "error",
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
