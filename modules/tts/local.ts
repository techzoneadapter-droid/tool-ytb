import { startService, serviceURL } from "../providers/services";
import { spawn } from "node:child_process";
import { mkdir, writeFile, unlink, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { TTSError, safeTTSErrorBody } from "./errors";
import type { Settings } from "../project/types";
import { chunks } from "../project/parser";
import { run, duration } from "../videoRender/process";
import { localVoiceId, localVoiceNames } from "./local-voices";
import { findEngineVoice, type EngineVoice } from "./catalog";

export const vieneuMissing =
  "Chưa kết nối được VieNeu-TTS local. Nhấn Khởi động AI Engine hoặc xem Chi tiết dịch vụ.";
export const korvaMissing =
  "Chưa cài KorvaTTS local. Mở PowerShell và chạy: python -m pip install korvatts";
export function vieneuURL() {
  const u = new URL(process.env.VIENEU_LOCAL_URL || "http://127.0.0.1:8000");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw Error(
      "VIENEU_LOCAL_URL phải là địa chỉ máy cục bộ (localhost hoặc 127.0.0.1).",
    );
  return u.href.replace(/\/$/, "");
}
export function korva(args: string[], timeout = 600000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      /* turbopackIgnore: true */ process.env.KORVATTS_BIN || "korvatts",
      args,
      {
        shell: false,
        windowsHide: true,
      },
    );
    let output = "";
    const timer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { shell: false, windowsHide: true },
        );
        killer.on("error", () => child.kill());
      } else child.kill();
      reject(Error("KorvaTTS xử lý quá lâu. Kiểm tra tải mô hình và thử lại."));
    }, timeout);
    child.stdout.on("data", (d) => {
      output = (output + d).slice(-4000);
    });
    child.stderr.on("data", (d) => {
      output = (output + d).slice(-4000);
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        Error(
          e.code === "ENOENT"
            ? korvaMissing
            : "Không chạy được KorvaTTS. Kiểm tra KORVATTS_BIN và quyền chạy chương trình.",
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(output)
        : reject(
            Error("KorvaTTS báo lỗi (" + code + "): " + output.slice(-1500)),
          );
    });
  });
}
export async function vieneuHealth() {
  const response = await fetch(vieneuURL() + "/health", {
    signal: AbortSignal.timeout(3000),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) throw Error(vieneuMissing);
  const health = await response.json();
  if (health.status !== "ok") throw Error(vieneuMissing);
  return {
    backend: typeof health.backend === "string" ? health.backend : "unknown",
    maxStreams: Math.max(1, Math.min(16, Number(health.max_streams) || 1)),
    active: Math.max(0, Number(health.active) || 0),
    waiting: Math.max(0, Number(health.waiting) || 0),
  };
}
export async function vieneuVoices() {
  const base = vieneuURL();
  try {
    const [health, voices] = await Promise.all([
      vieneuHealth(),
      fetch(base + "/v1/voices", {
        signal: AbortSignal.timeout(3000),
        redirect: "error",
        cache: "no-store",
      }),
    ]);
    if (!voices.ok) throw Error(vieneuMissing);
    const h = health;
    const v = await voices.json();
    if (!h || !Array.isArray(v.data)) throw Error(vieneuMissing);
    return v.data.filter(
      (x: EngineVoice) => typeof x.id === "string" && x.id.length > 0,
    ) as EngineVoice[];
  } catch {
    throw Error(vieneuMissing);
  }
}
let vieneuVoiceCache:
  { until: number; promise: Promise<EngineVoice[]> } | undefined;

async function cachedVieneuVoices(force = false) {
  if (force || !vieneuVoiceCache || vieneuVoiceCache.until < Date.now())
    vieneuVoiceCache = {
      until: Date.now() + 30000,
      promise: vieneuVoices(),
    };
  try {
    return await vieneuVoiceCache.promise;
  } catch (error) {
    vieneuVoiceCache = undefined;
    throw error;
  }
}

let healthCache:
  | { until: number; promise: Promise<Awaited<ReturnType<typeof checkLocal>>> }
  | undefined;
async function checkLocal() {
  const [v, k] = await Promise.allSettled([vieneuVoices(), korvaVoices()]);
  return {
    vieneu: {
      ready: v.status === "fulfilled",
      voices: v.status === "fulfilled" ? v.value : [],
      message:
        v.status === "rejected" ? String(v.reason.message) : "Engine đang chạy",
    },
    korva: {
      ready: k.status === "fulfilled",
      voices: k.status === "fulfilled" ? k.value : [],
      message:
        k.status === "rejected" ? String(k.reason.message) : "Engine đang chạy",
    },
  };
}
export function localStatus() {
  if (!healthCache || healthCache.until < Date.now())
    healthCache = { until: Date.now() + 15000, promise: checkLocal() };
  return healthCache.promise;
}
export function hasVieneuVoice(
  voices: { id: string; name?: string; aliases?: string[] }[],
  name: string,
) {
  return voices.some(
    (v) => v.id === name || v.name === name || v.aliases?.includes(name),
  );
}
export async function korvaVoices(): Promise<EngineVoice[]> {
  const r = await fetch(new URL("/voices", serviceURL("korva")), {
    signal: AbortSignal.timeout(3000),
    redirect: "error",
    cache: "no-store",
  });
  if (!r.ok)
    throw Error(
      "Korva chưa sẵn sàng. Khởi động engine để lấy danh sách giọng.",
    );
  const d = await r.json();
  if (!Array.isArray(d.data))
    throw Error("Danh sách giọng Korva không hợp lệ.");
  return d.data;
}
export async function speakLocal(
  text: string,
  file: string,
  s: Settings,
  options: { preview?: boolean } = {},
) {
  if (s.ttsProvider === "tts-studio-local")
    throw Error("Vietnamese TTS Studio - Clone giọng local - đang phát triển");
  let voice = localVoiceId(s.voice);
  let catalog: EngineVoice[];
  if (s.ttsProvider === "vieneu-local") {
    try {
      catalog = await cachedVieneuVoices();
    } catch {
      await startService("vieneu");
      catalog = await cachedVieneuVoices(true);
    }
  } else {
    await startService("korva");
    catalog = await korvaVoices();
  }
  const selected = findEngineVoice(catalog, s.voice);
  if (!selected)
    throw Error("Giọng không thuộc danh sách thật của engine đã chọn.");
  voice = selected.id;
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary: string[] = [];
  try {
    const normalized: string[] = [];
    const parts =
      s.ttsProvider === "vieneu-local" ? chunks(text, 512) : chunks(text, 1500);
    const factor = Math.pow(2, s.pitch / 12);
    for (const [chunkIndex, part] of parts.entries()) {
      const raw = path.join(directory, randomUUID() + ".wav");
      const clean =
        s.ttsProvider === "vieneu-local"
          ? path.join(
              directory,
              createHash("sha256")
                .update(
                  JSON.stringify(["vieneu-chunk-v1", vieneuURL(), voice, part]),
                )
                .digest("hex") + ".wav",
            )
          : path.join(directory, randomUUID() + ".wav");
      temporary.push(raw);
      const cleanTemporary = path.join(directory, randomUUID() + ".wav");
      temporary.push(cleanTemporary);
      if (s.ttsProvider !== "vieneu-local") temporary.push(clean);
      if (
        s.ttsProvider === "vieneu-local" &&
        (await duration(clean).then(
          (seconds) => seconds > 0,
          () => false,
        ))
      ) {
        normalized.push(clean);
        continue;
      }
      if (s.ttsProvider === "vieneu-local") {
        let response: Response;
        for (let attempt = 0; ; attempt++) {
          try {
            response = await fetch(vieneuURL() + "/v1/audio/speech", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              redirect: "error",
              body: JSON.stringify({
                model: "vieneu-v3-turbo",
                input: part,
                voice,
                response_format: "wav",
                sample_rate: 24000,
                max_chars: 512,
              }),
              signal: AbortSignal.timeout(600000),
            });
          } catch (error) {
            if (attempt < 2) continue;
            throw new TTSError(
              "VieNeu Local",
              voice,
              part.length,
              chunkIndex + 1,
              parts.length,
              error instanceof Error
                ? error.message +
                    (error.cause instanceof Error
                      ? ": " + error.cause.message
                      : "")
                : vieneuMissing,
            );
          }
          if (!response.ok) {
            const body = safeTTSErrorBody(await response.text());
            if (
              attempt < 2 &&
              (response.status === 429 || response.status >= 500)
            ) {
              await new Promise((resolve) =>
                setTimeout(resolve, 500 * (attempt + 1)),
              );
              continue;
            }
            throw new TTSError(
              "VieNeu Local",
              voice,
              part.length,
              chunkIndex + 1,
              parts.length,
              body,
              response.status,
            );
          }
          break;
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (
          bytes.toString("ascii", 0, 4) !== "RIFF" ||
          bytes.toString("ascii", 8, 12) !== "WAVE"
        )
          throw new TTSError(
            "VieNeu Local",
            voice,
            part.length,
            chunkIndex + 1,
            parts.length,
            "Không trả về WAV hợp lệ",
            response.status,
          );
        await writeFile(raw, bytes);
      } else {
        await startService("korva");
        const response = await fetch(
          new URL(
            options.preview ? "/preview" : "/synthesize",
            serviceURL("korva"),
          ),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: part, voice }),
            signal: AbortSignal.timeout(600000),
          },
        );
        if (!response.ok)
          throw Error("KorvaTTS: " + (await response.text()).slice(-1200));
        await writeFile(raw, Buffer.from(await response.arrayBuffer()));
      }
      if (parts.length === 1 && s.ttsProvider !== "vieneu-local") {
        await run([
          "-y",
          "-i",
          raw,
          "-vn",
          "-af",
          `asetrate=${24000 * factor},aresample=24000,atempo=${1 / factor},atempo=${s.speed},volume=${s.volume},apad=pad_dur=${s.pause}`,
          "-ar",
          "24000",
          "-ac",
          "1",
          file,
        ]);
        const seconds = await duration(file);
        if (!Number.isFinite(seconds) || seconds <= 0)
          throw Error("Engine không tạo được tệp audio hợp lệ.");
        return seconds;
      }

      // Multi-part narration still normalizes each streaming WAV before concat.
      await run([
        "-y",
        "-i",
        raw,
        "-vn",
        "-ar",
        "24000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        cleanTemporary,
      ]);
      await rename(cleanTemporary, clean);
      normalized.push(clean);
    }
    if (!normalized.length) throw Error("Nội dung lời đọc đang trống.");
    const list = path.join(directory, randomUUID() + ".txt");
    temporary.push(list);
    await writeFile(
      list,
      normalized.map((f) => "file '" + path.basename(f) + "'").join("\n"),
    );
    await run(
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        path.basename(list),
        "-af",
        `asetrate=${24000 * factor},aresample=24000,atempo=${1 / factor},atempo=${s.speed},volume=${s.volume},apad=pad_dur=${s.pause}`,
        "-ac",
        "1",
        file,
      ],
      directory,
    );
    const seconds = await duration(file);
    if (!Number.isFinite(seconds) || seconds <= 0)
      throw Error("Engine không tạo được tệp audio hợp lệ.");
    return seconds;
  } catch (e) {
    await unlink(file).catch(() => {});
    if (s.ttsProvider === "vieneu-local" && !(e instanceof TTSError))
      throw new TTSError(
        "VieNeu Local",
        voice,
        text.length,
        0,
        0,
        e instanceof Error ? e.message : String(e),
      );
    throw e;
  } finally {
    await Promise.all(temporary.map((f) => unlink(f).catch(() => {})));
  }
}
