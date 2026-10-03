import { createHash, randomUUID } from "node:crypto";
import { mkdir, copyFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { speak as speakCloud } from "./cloud";
import { speakLocal, vieneuURL } from "./local";
import {
  localProviderIds,
  localVoiceId,
  localVoiceNames,
  type TTSProvider,
} from "./local-voices";
import { requireTTS, ttsConfig } from "../providers/config";
import { duration } from "../videoRender/process";
import type { Settings } from "../project/types";
import { publishGenerated } from "../providers/local-workers";

export function defaultTTSProvider(): TTSProvider {
  const p = process.env.DEFAULT_TTS_PROVIDER || "vieneu-local";
  if (p !== "cloud" && !localProviderIds.includes(p as never))
    throw Error("DEFAULT_TTS_PROVIDER không hợp lệ.");
  return p as TTSProvider;
}
export function resolveTTS(s: Settings): Settings {
  // Existing projects retain their cloud voice until the user chooses a local engine.
  return { ...s, ttsProvider: s.ttsProvider || "cloud" };
}
export function assertTTS(s: Settings) {
  const p = resolveTTS(s).ttsProvider!;
  if (p === "cloud") {
    requireTTS(s.voice);
    return;
  }
  if (p === "tts-studio-local")
    throw Error("Vietnamese TTS Studio - Clone giọng local - đang phát triển");
  const id = localVoiceId(s.voice);
  if (
    !s.voice.trim() ||
    s.voice.length > 100 ||
    (p === "korva-local" && !Object.hasOwn(localVoiceNames, id))
  )
    throw Error("Giọng không thuộc engine local đã chọn.");
}
export function ttsSource(s: Settings) {
  return resolveTTS(s).ttsProvider === "cloud"
    ? ttsConfig().provider
    : s.ttsProvider!;
}
const pending = new Map<string, Promise<number>>();
export async function speak(
  text: string,
  file: string,
  settings: Settings,
  options: { preview?: boolean } = {},
): Promise<number> {
  const s = resolveTTS(settings);
  assertTTS(s);
  if (!text.trim()) throw Error("Nội dung lời đọc đang trống.");
  const c = s.ttsProvider === "cloud" ? requireTTS(s.voice) : undefined;
  const identity =
    s.ttsProvider === "vieneu-local"
      ? vieneuURL()
      : s.ttsProvider === "korva-local"
        ? process.env.KORVATTS_BIN || "korvatts"
        : [c?.provider, c?.voiceId, c?.region, process.env.TTS_MODEL];
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        "tts-cache-v2",
        ...(options.preview ? ["preview-12-steps"] : []),
        identity,
        s.ttsProvider,
        s.voice,
        text,
        s.speed,
        s.pitch,
        s.volume,
        s.pause,
        path.extname(file),
      ]),
    )
    .digest("hex");
  const cache = path.join(path.dirname(file), hash + path.extname(file));
  await mkdir(path.dirname(file), { recursive: true });
  let task = pending.get(cache);
  if (!task) {
    task = (async () => {
      try {
        const d = await duration(cache);
        if (Number.isFinite(d) && d > 0) return d;
      } catch {
        /* missing or invalid cache */
      }
      const temporary = path.join(
        path.dirname(file),
        randomUUID() + path.extname(file),
      );
      try {
        const seconds =
          s.ttsProvider === "cloud"
            ? await speakCloud(text, temporary, s)
            : await speakLocal(text, temporary, s, options);
        await rename(temporary, cache);
        return seconds;
      } finally {
        await unlink(temporary).catch(() => {});
      }
    })();
    pending.set(cache, task);
  }
  try {
    const seconds = await task;
    if (path.resolve(file) !== path.resolve(cache)) await copyFile(cache, file);
    await publishGenerated(file, "audio");
    return seconds;
  } finally {
    if (pending.get(cache) === task) pending.delete(cache);
  }
}
