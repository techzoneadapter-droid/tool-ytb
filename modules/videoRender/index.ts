import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { root } from "../project/store";
import type { Scene, Settings } from "../project/types";
import { subtitles } from "../subtitle";
import { run, duration } from "./process";
import { encodeWithFallback } from "./encoder";
import { usesMotion } from "../providers/local-workers";
import { assetExists, resolveSceneImage } from "../project/media";
import { cachedSceneVideo } from "./scene-cache";
export const assets = path.join(root, "assets");
export async function render(
  scenes: Scene[],
  s: Settings,
  checkpoint: (n: number) => void,
) {
  const id = randomUUID(),
    work = path.join(root, "work", id);
  await mkdir(work, { recursive: true });
  const [w, h] = s.aspect === "16:9" ? [1280, 720] : [720, 1280];
  const segments: string[] = [];
  const normal = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=25,format=yuv420p`;
  async function bumper(asset: string, label: string) {
    const input = path.join(assets, asset);
    const d = await duration(input);
    await encodeWithFallback(
      (videoArgs) => [
        "-y",
        "-i",
        input,
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=24000:cl=mono",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-vf",
        normal,
        "-t",
        String(d),
        ...videoArgs,
        "-c:a",
        "aac",
        "-ar",
        "24000",
        "-ac",
        "1",
        `${label}.mp4`,
      ],
      work,
      undefined,
      true,
    );
    segments.push(`${label}.mp4`);
    return d;
  }
  let introDuration = 0;
  if (s.intro) introDuration = await bumper(s.intro, "intro");
  for (let i = 0; i < scenes.length; i++) {
    checkpoint((i / scenes.length) * 0.6);
    const scene = scenes[i];
    const cached = cachedSceneVideo(scene, s, assets);
    if (cached) {
      segments.push(path.join(assets, cached).replaceAll("\\", "/"));
      continue;
    }
    const image = await resolveSceneImage(scene, s);
    if (!image) throw Error("Cảnh chưa có ảnh hợp lệ hoặc ảnh dùng chung.");
    const motion =
      usesMotion(scene, s) &&
      scene.motionStatus === "done" &&
      assetExists(scene.motion)
        ? scene.motion
        : undefined;
    await encodeWithFallback(
      (videoArgs) => [
        "-y",
        ...(motion
          ? ["-stream_loop", "-1"]
          : ["-loop", "1", "-framerate", "25"]),
        "-i",
        path.join(assets, motion || image),
        ...(s.audioEnabled === false
          ? ["-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono"]
          : ["-i", path.join(assets, scene.audio!)]),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-vf",
        normal,
        "-t",
        String(scene.duration),
        ...videoArgs,
        "-c:a",
        "aac",
        "-ar",
        "24000",
        "-ac",
        "1",
        `scene-${i}.mp4`,
      ],
      work,
      {
        seconds: scene.duration,
        onProgress: (n) => checkpoint(((i + n) / scenes.length) * 0.6),
      },
      true,
    );
    segments.push(`scene-${i}.mp4`);
  }
  if (s.outro) await bumper(s.outro, "outro");
  await writeFile(
    path.join(work, "concat.txt"),
    segments.map((f) => `file '${f}'`).join("\n"),
  );
  await run(
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "concat.txt",
      "-c",
      "copy",
      "joined.mp4",
    ],
    work,
  );
  const subtitleScenes = introDuration
    ? [{ ...scenes[0], text: "", duration: introDuration }, ...scenes]
    : scenes;
  if (s.burnSubtitles) {
    const srt = subtitles(subtitleScenes),
      vtt = subtitles(subtitleScenes, true);
    await writeFile(path.join(work, "subtitles.srt"), srt);
    await writeFile(path.join(assets, `${id}.srt`), srt);
    await writeFile(path.join(assets, `${id}.vtt`), vtt);
  }
  const args = ["-y", "-i", "joined.mp4"];
  let index = 1;
  let musicIndex = -1,
    logoIndex = -1;
  if (s.music) {
    musicIndex = index++;
    args.push("-stream_loop", "-1", "-i", path.join(assets, s.music));
  }
  if (s.logo) {
    logoIndex = index++;
    args.push("-i", path.join(assets, s.logo));
  }
  const filters: string[] = [];
  let video = "0:v",
    audio = "0:a";
  if (s.burnSubtitles) {
    const color =
      "&H00" + s.color.slice(5, 7) + s.color.slice(3, 5) + s.color.slice(1, 3);
    filters.push(
      `[${video}]subtitles=subtitles.srt:force_style='PlayResX=${w},PlayResY=${h},FontName=${s.font},FontSize=${s.aspect === "16:9" ? 32 : 38},PrimaryColour=${color},Outline=${s.outline},Alignment=${s.position === "top" ? 8 : 2},MarginV=${s.aspect === "16:9" ? 32 : 90}'[sub]`,
    );
    video = "sub";
  }
  if (logoIndex >= 0) {
    const margin = 24;
    const logoPercent = Math.max(5, Math.min(100, Number(s.logoWidthPercent ?? 18) || 18));
    const logoWidth = Math.round(w * logoPercent / 100);
    const opacity = Math.max(0, Math.min(1, Number(s.logoOpacity ?? 1)));
    let overlayExpr = `W-w-${margin}:${margin}`;
    const pos = s.logoPosition || "top-right";
    if (pos === "top-left") overlayExpr = `${margin}:${margin}`;
    else if (pos === "bottom-left") overlayExpr = `${margin}:H-h-${margin}`;
    else if (pos === "bottom-right") overlayExpr = `W-w-${margin}:H-h-${margin}`;
    filters.push(
      `[${logoIndex}:v]format=rgba,scale=${logoWidth}:-1:flags=lanczos,colorchannelmixer=aa=${opacity}[logo]`,
      `[${video}][logo]overlay=${overlayExpr}[branded]`,
    );
    video = "branded";
  }
  if (musicIndex >= 0) {
    const totalSeconds = await duration(path.join(work, "joined.mp4"));
    const fade = Math.max(0, Math.min(totalSeconds / 2, Number(s.musicFadeSeconds ?? 2) || 0));
    const fadeFilter = fade > 0 ? `,afade=t=out:st=${Math.max(0, totalSeconds - fade)}:d=${fade}` : "";
    filters.push(
      `[${musicIndex}:a]atrim=duration=${totalSeconds},asetpts=PTS-STARTPTS,volume=${Math.max(0, Math.min(1, Number(s.musicVolume) || 0))}${fadeFilter}[bg]`,
      `[0:a][bg]amix=inputs=2:duration=first:normalize=0[mix]`,
    );
    audio = "mix";
  }
  if (filters.length) args.push("-filter_complex", filters.join(";"));
  const tail = [
    "-map",
    video.includes(":") ? video : `[${video}]`,
    "-map",
    audio.includes(":") ? audio : `[${audio}]`,
    "-c:a", "aac",
    "-movflags", "+faststart",
    "-shortest",
    path.join(assets, `${id}.mp4`),
  ];
  checkpoint(0.65);
  const runtime = {
    seconds: await duration(path.join(work, "joined.mp4")),
    onProgress: (n: number) => checkpoint(0.65 + n * 0.34),
  };
  if (!filters.length) {
    // No subtitles/branding/music: segments already contain H.264 + AAC.
    // Avoid an expensive second full-length encoding altogether.
    await run([...args, "-c", "copy", "-movflags", "+faststart", tail[tail.length - 1]], work, false, runtime);
    checkpoint(0.99);
  } else {
    await encodeWithFallback((videoArgs) => [
      ...args,
      "-map", video.includes(":") ? video : `[${video}]`,
      "-map", audio.includes(":") ? audio : `[${audio}]`,
      ...videoArgs,
      "-c:a", "aac",
      "-movflags", "+faststart",
      "-shortest",
      path.join(assets, `${id}.mp4`),
    ], work, runtime);
  }
  return {
    output: `${id}.mp4`,
    srt: s.burnSubtitles ? `${id}.srt` : undefined,
    vtt: s.burnSubtitles ? `${id}.vtt` : undefined,
  };
}
