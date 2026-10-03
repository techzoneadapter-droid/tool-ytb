import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { Settings } from "../project/types";
import { duration, run } from "../videoRender/process";
import { pollinationsSpeech } from "../providers/free-cloud";

export async function speakPollinations(
  text: string,
  file: string,
  settings: Settings,
) {
  await mkdir(path.dirname(file), { recursive: true });
  const raw = file + ".pollinations.wav";
  try {
    const bytes = await pollinationsSpeech(text, settings.voice);
    await writeFile(raw, bytes);
    const factor = Math.pow(2, settings.pitch / 12);
    await run([
      "-y",
      "-i",
      raw,
      "-vn",
      "-af",
      `asetrate=24000*${factor},aresample=24000,atempo=${1 / factor},atempo=${settings.speed},volume=${settings.volume},apad=pad_dur=${settings.pause}`,
      "-ar",
      "24000",
      "-ac",
      "1",
      file,
    ]);
    const seconds = await duration(file);
    if (!(seconds > 0))
      throw Error("Pollinations TTS tạo audio không có thời lượng hợp lệ.");
    return seconds;
  } catch (error) {
    await unlink(file).catch(() => {});
    throw error;
  } finally {
    await unlink(raw).catch(() => {});
  }
}
