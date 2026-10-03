import { createHash, randomUUID } from "node:crypto";
import { mkdir, copyFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { speak as speakCloud } from "./cloud";
import { speakLocal, vieneuHealth, vieneuURL } from "./local";
import { speakModal, speakModalBatch } from "./modal";
import { speakPollinations } from "./pollinations";
import { pollinationsConfigured } from "../providers/free-cloud";
import {
  localProviderIds,
  localVoiceId,
  localVoiceNames,
  type TTSProvider,
} from "./local-voices";
import { requireTTS, ttsConfig } from "../providers/config";
import { modalConfigured } from "../providers/modal/client";
import { duration } from "../videoRender/process";
import type { Settings } from "../project/types";
import { publishGenerated } from "../providers/local-workers";

export function defaultTTSProvider(): TTSProvider {
  const fallback = modalConfigured("tts") ? "modal-vieneu" : "vieneu-local";
  const p = process.env.DEFAULT_TTS_PROVIDER || fallback;
  if (
    p !== "modal-vieneu" &&
    p !== "pollinations" &&
    p !== "cloud" &&
    !localProviderIds.includes(p as never)
  )
    throw Error("DEFAULT_TTS_PROVIDER không hợp lệ.");
  return p as TTSProvider;
}

export function resolveTTS(s: Settings): Settings {
  return { ...s, ttsProvider: s.ttsProvider || "cloud" };
}

export function assertTTS(s: Settings) {
  const p = resolveTTS(s).ttsProvider!;
  if (p === "modal-vieneu") {
    if (!modalConfigured("tts"))
      throw Error("Chưa cấu hình VieNeu Cloud. Thiết lập MODAL_TTS_URL trước.");
    if (!s.voice.trim()) throw Error("Chưa chọn giọng VieNeu Cloud.");
    return;
  }
  if (p === "pollinations") {
    if (!pollinationsConfigured())
      throw Error(
        "Pollinations chưa có API key. Đặt POLLINATIONS_API_KEY trong .env.local.",
      );
    if (!s.voice.trim()) throw Error("Chưa chọn giọng Pollinations.");
    return;
  }
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
  const provider = resolveTTS(s).ttsProvider;
  return provider === "cloud" ? ttsConfig().provider : provider!;
}

function identity(s: Settings) {
  if (s.ttsProvider === "modal-vieneu") return process.env.MODAL_TTS_URL;
  if (s.ttsProvider === "vieneu-local") return vieneuURL();
  if (s.ttsProvider === "korva-local")
    return process.env.KORVATTS_BIN || "korvatts";
  if (s.ttsProvider === "pollinations")
    return [
      "pollinations",
      process.env.POLLINATIONS_TTS_MODEL || "catalog",
      process.env.POLLINATIONS_API_KEY ? "configured" : "missing",
    ];
  const c = requireTTS(s.voice);
  return [c.provider, c.voiceId, c.region, process.env.TTS_MODEL];
}

function cacheFile(
  text: string,
  file: string,
  s: Settings,
  options: { preview?: boolean } = {},
) {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        "tts-cache-v4",
        ...(options.preview ? ["preview-short"] : []),
        identity(s),
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
  return path.join(path.dirname(file), hash + path.extname(file));
}

async function validDuration(file: string) {
  try {
    const seconds = await duration(file);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
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

  const cache = cacheFile(text, file, s, options);
  await mkdir(path.dirname(file), { recursive: true });
  let task = pending.get(cache);
  if (!task) {
    task = (async () => {
      const cached = await validDuration(cache);
      if (cached) return cached;
      const temporary = path.join(
        path.dirname(file),
        randomUUID() + path.extname(file),
      );
      try {
        const seconds =
          s.ttsProvider === "modal-vieneu"
            ? await speakModal(text, temporary, s, options)
            : s.ttsProvider === "pollinations"
              ? await speakPollinations(text, temporary, s)
              : s.ttsProvider === "cloud"
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

export async function speakBatch(
  items: { id: string; text: string; file: string }[],
  settings: Settings,
) {
  const s = resolveTTS(settings);
  assertTTS(s);
  if (s.ttsProvider === "vieneu-local") {
    const output = new Map<string, number>();
    const health = await vieneuHealth().catch(() => ({
      backend: "unknown",
      maxStreams: 1,
      active: 0,
      waiting: 0,
    }));
    // VieNeu's server already implements continuous batching on GPU and a
    // bounded queue on CPU. Keep a conservative ceiling for older 4 GB GPUs.
    const limit = Math.max(
      1,
      Math.min(4, health.maxStreams, Math.max(1, health.maxStreams - health.active)),
    );
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (true) {
          const index = cursor++;
          if (index >= items.length) return;
          const item = items[index];
          output.set(item.id, await speak(item.text, item.file, s));
        }
      },
    );
    await Promise.all(workers);
    return output;
  }

  if (s.ttsProvider !== "modal-vieneu") {
    const output = new Map<string, number>();
    for (const item of items)
      output.set(item.id, await speak(item.text, item.file, s));
    return output;
  }

  const output = new Map<string, number>();
  const missing: {
    id: string;
    text: string;
    file: string;
    cache: string;
    temporary: string;
  }[] = [];

  for (const item of items) {
    const cache = cacheFile(item.text, item.file, s);
    const cached = await validDuration(cache);
    if (cached) {
      if (path.resolve(cache) !== path.resolve(item.file))
        await copyFile(cache, item.file);
      await publishGenerated(item.file, "audio");
      output.set(item.id, cached);
      continue;
    }
    missing.push({
      ...item,
      cache,
      temporary: path.join(
        path.dirname(item.file),
        randomUUID() + path.extname(item.file),
      ),
    });
  }

  for (let offset = 0; offset < missing.length; offset += 16) {
    const batch = missing.slice(offset, offset + 16);
    const durations = await speakModalBatch(
      batch.map((item) => ({
        id: item.id,
        text: item.text,
        file: item.temporary,
      })),
      s,
    );
    for (const item of batch) {
      const seconds = durations.get(item.id);
      if (!seconds) throw Error("VieNeu Cloud batch thiếu thời lượng audio.");
      await rename(item.temporary, item.cache);
      if (path.resolve(item.cache) !== path.resolve(item.file))
        await copyFile(item.cache, item.file);
      await publishGenerated(item.file, "audio");
      output.set(item.id, seconds);
    }
  }
  return output;
}
