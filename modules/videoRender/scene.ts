import path from "node:path";
import { mkdir, rename, unlink } from "node:fs/promises";
import type { Scene, Settings } from "../project/types";
import { run, verifyVideo } from "./process";

export async function renderSceneBuffer({
  imageBuffer,
  scene,
  settings,
  audioPath,
  outputPath,
  onProgress,
}: {
  imageBuffer: Buffer;
  scene: Scene;
  settings: Settings;
  audioPath?: string;
  outputPath: string;
  onProgress?: (fraction: number) => void;
}) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length)
    throw Error("SCENE_IMAGE_BUFFER_INVALID: Không có Buffer ảnh.");
  if (!Number.isFinite(scene.duration) || scene.duration <= 0)
    throw Error("SCENE_DURATION_INVALID: Thời lượng cảnh không hợp lệ.");
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = outputPath + ".partial.mp4";
  const [w, h] = settings.aspect === "16:9" ? [1280, 720] : [720, 1280];
  // image2pipe cannot seek/loop stdin; tpad repeats the decoded frame until -t.
  const filter = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=25,format=yuv420p,tpad=stop_mode=clone:stop_duration=${scene.duration}`;
  try {
    await run(
      [
        "-y",
        "-f",
        "image2pipe",
        "-framerate",
        "25",
        "-i",
        "pipe:0",
        ...(audioPath
          ? ["-i", audioPath]
          : ["-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono"]),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-vf",
        filter,
        "-t",
        String(scene.duration),
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        "-ar",
        "24000",
        "-ac",
        "1",
        "-movflags",
        "+faststart",
        temporary,
      ],
      undefined,
      false,
      { seconds: scene.duration, onProgress: onProgress || (() => {}) },
      imageBuffer,
    );
    await verifyVideo(temporary);
    await rename(temporary, outputPath);
    return outputPath;
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
