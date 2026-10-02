import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { root } from "./store";
import type { Scene, Job } from "./types";
export function assetExists(name?: string) {
  try {
    return (
      !!name &&
      /^[a-f0-9-]+\.(png|jpg|jpeg|webp|wav|mp3|mp4|srt|vtt)$/.test(name) &&
      existsSync(path.join(root, "assets", name)) &&
      statSync(path.join(root, "assets", name)).size > 0
    );
  } catch {
    return false;
  }
}
export function verifiedScene(scene: Scene): Scene {
  const s = { ...scene };
  if (s.motion && !assetExists(s.motion)) {
    s.motion = undefined;
    s.motionStatus = "error";
    s.motionError =
      "Không tìm thấy tệp ảnh động. Có thể tạo lại hoặc dùng ảnh tĩnh.";
  }
  if (s.audio && (!s.audioSource || !assetExists(s.audio))) {
    s.audio = undefined;
    s.audioStatus = "error";
    s.audioError = "Tệp lời đọc chưa được xác minh hoặc không còn trên máy.";
    s.approved = false;
  }
  if (s.image && (!s.imageSource || !assetExists(s.image))) {
    s.image = undefined;
    s.imageStatus = "error";
    s.imageError = "Tệp ảnh chưa được xác minh hoặc không còn trên máy.";
    s.approved = false;
  }
  return s;
}
export function requireSceneMedia(scene: Scene) {
  if (!scene.audioSource || !assetExists(scene.audio))
    throw Error("Cảnh chưa có tệp lời đọc thật. Hãy tạo lại lời đọc.");
  if (!scene.imageSource || !assetExists(scene.image))
    throw Error("Cảnh chưa có tệp ảnh thật. Hãy tạo hoặc tải ảnh lên.");
}
export function verifiedJob(job: Job): Job {
  if (job.status === "done" && (!job.verified || !assetExists(job.output)))
    return {
      ...job,
      status: "error",
      progress: 0,
      output: undefined,
      error: "Không tìm thấy MP4 đã được xác minh. Cần xuất lại video.",
      message: "Video chưa hợp lệ",
    };
  return job;
}
