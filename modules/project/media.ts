import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { root } from "./store";
import type { Scene, Job, Settings } from "./types";
import sharp from "sharp";
import { cachedSceneVideo } from "../videoRender/scene-cache";
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
const decoded = new Map<string, { stamp: string; valid: boolean }>();
export async function validImage(name?: string): Promise<boolean> {
  if (!name || !/\.(png|jpg|jpeg|webp)$/.test(name) || !assetExists(name))
    return false;
  const file = path.join(root, "assets", name);
  const stat = statSync(file);
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  if (decoded.get(name)?.stamp === stamp) return decoded.get(name)!.valid;
  let valid = false;
  try {
    const meta = await sharp(file).metadata();
    await sharp(file).stats();
    valid = !!meta.width && !!meta.height;
  } catch {}
  decoded.set(name, { stamp, valid });
  return valid;
}
/** One resolver for preflight, review, motion and final FFmpeg input. Never copies the shared asset. */
export async function resolveSceneImage(
  scene: Scene,
  settings?: Settings,
): Promise<string | undefined> {
  // Legacy jobs sometimes copied the common image into scene.image. Respect a changed/removed setting.
  const legacyShared = scene.imageSource === "shared";
  if (!legacyShared && scene.imageSource && (await validImage(scene.image)))
    return scene.image;
  if (
    settings &&
    (settings.imageEnabled === false ||
      settings.fallbackOnImageError === true) &&
    (await validImage(settings.fallbackImage))
  )
    return settings.fallbackImage;
  return undefined;
}
export async function requireSceneMedia(scene: Scene, settings?: Settings) {
  if (settings && cachedSceneVideo(scene, settings)) return;
  if (
    settings?.audioEnabled !== false &&
    (!scene.audioSource || !assetExists(scene.audio))
  )
    throw Error("Cảnh chưa có tệp lời đọc thật. Hãy tạo lại lời đọc.");
  if (!(await resolveSceneImage(scene, settings)))
    throw Error("Cảnh chưa có tệp ảnh thật. Hãy tạo hoặc tải ảnh lên.");
}
export function verifiedJob(job: Job): Job {
  if (job.status !== "done") return job;
  if (job.outputs?.length) {
    const valid =
      job.verified &&
      job.outputs.every((item) => item.verified && assetExists(item.output));
    if (valid) return job;
    return {
      ...job,
      status: "error",
      progress: 0,
      verified: false,
      error:
        "Một hoặc nhiều MP4 trong lô không còn hợp lệ. Cần xuất lại video.",
      message: "Lô video chưa hợp lệ",
    };
  }
  if (!job.verified || !assetExists(job.output))
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
