import path from "node:path";
import { mkdir, rename, unlink } from "node:fs/promises";
import type { Scene, Settings } from "../project/types";
import { run, verifyVideo } from "./process";

export function chapterMotionFilter(
  width: number,
  height: number,
  seconds: number,
  index: number,
) {
  const frames = Math.max(2, Math.ceil(seconds * 25));
  const progress = `min(1,on/${frames - 1})`;
  const presets = [
    { z: `1+0.08*${progress}`, x: "iw/2-iw/zoom/2" },
    { z: "1.08", x: `(iw-iw/zoom)*${progress}` },
    { z: `1.08-0.08*${progress}`, x: "iw/2-iw/zoom/2" },
    { z: "1.08", x: `(iw-iw/zoom)*(1-${progress})` },
    { z: `1.03+0.05*${progress}`, x: "iw/2-iw/zoom/2" },
  ];
  const preset =
    presets[((index % presets.length) + presets.length) % presets.length];
  return `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,crop=${width * 2}:${height * 2},setsar=1,zoompan=z='${preset.z}':x='${preset.x}':y='ih/2-ih/zoom/2':d=${frames}:s=${width}x${height}:fps=25,format=yuv420p`;
}

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
  const filter = chapterMotionFilter(
    w,
    h,
    scene.duration,
    scene.chapterSceneIndex || 0,
  );
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
