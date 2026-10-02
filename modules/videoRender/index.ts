import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { root } from "../project/store";
import type { Scene, Settings } from "../project/types";
import { subtitles } from "../subtitle";
import { run, duration } from "./process";
import { usesMotion } from "../providers/local-workers";
import { assetExists } from "../project/media";
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
    await run(
      [
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
        `${label}.mp4`,
      ],
      work,
    );
    segments.push(`${label}.mp4`);
    return d;
  }
  let introDuration = 0;
  if (s.intro) introDuration = await bumper(s.intro, "intro");
  for (let i = 0; i < scenes.length; i++) {
    checkpoint((i / scenes.length) * 0.6);
    const scene = scenes[i];
    const motion =
      usesMotion(scene, s) &&
      scene.motionStatus === "done" &&
      assetExists(scene.motion)
        ? scene.motion
        : undefined;
    const frames = Math.ceil(scene.duration * 25);
    const vf = `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2},zoompan=z='min(zoom+0.0005,1.08)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=${frames}:s=${w}x${h}:fps=25,fade=t=in:st=0:d=0.25,fade=t=out:st=${Math.max(0, scene.duration - 0.25)}:d=0.25,format=yuv420p`;
    await run(
      [
        "-y",
        ...(motion ? ["-stream_loop", "-1"] : []),
        "-i",
        path.join(assets, motion || scene.image!),
        "-i",
        path.join(assets, scene.audio!),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-vf",
        motion ? normal : vf,
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
        `scene-${i}.mp4`,
      ],
      work,
      false,
      {
        seconds: scene.duration,
        onProgress: (n) => checkpoint(((i + n) / scenes.length) * 0.6),
      },
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
  const srt = subtitles(subtitleScenes),
    vtt = subtitles(subtitleScenes, true);
  await writeFile(path.join(work, "subtitles.srt"), srt);
  await writeFile(path.join(assets, `${id}.srt`), srt);
  await writeFile(path.join(assets, `${id}.vtt`), vtt);
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
    filters.push(
      `[${logoIndex}:v]scale=100:-1[logo]`,
      `[${video}][logo]overlay=W-w-24:24[branded]`,
    );
    video = "branded";
  }
  if (musicIndex >= 0) {
    filters.push(
      `[${musicIndex}:a]volume=${s.musicVolume}[bg]`,
      `[0:a][bg]amix=inputs=2:duration=first:normalize=0[mix]`,
    );
    audio = "mix";
  }
  if (filters.length) args.push("-filter_complex", filters.join(";"));
  args.push(
    "-map",
    video.includes(":") ? video : `[${video}]`,
    "-map",
    audio.includes(":") ? audio : `[${audio}]`,
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    "-shortest",
    path.join(assets, `${id}.mp4`),
  );
  checkpoint(0.65);
  await run(args, work, false, {
    seconds: await duration(path.join(work, "joined.mp4")),
    onProgress: (n) => checkpoint(0.65 + n * 0.34),
  });
  return { output: `${id}.mp4`, srt: `${id}.srt`, vtt: `${id}.vtt` };
}
