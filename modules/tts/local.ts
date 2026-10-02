import { spawn } from "node:child_process";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Settings } from "../project/types";
import { chunks } from "../project/parser";
import { run, duration } from "../videoRender/process";
import { localVoiceId, localVoiceNames } from "./local-voices";

export const vieneuMissing =
  "Chưa chạy VieNeu-TTS local. Hãy mở VieNeu-TTS và chạy: uv run python -m apps.openai_speech";
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
export async function vieneuVoices() {
  const base = vieneuURL();
  try {
    const [health, voices] = await Promise.all([
      fetch(base + "/health", {
        signal: AbortSignal.timeout(3000),
        redirect: "error",
        cache: "no-store",
      }),
      fetch(base + "/v1/voices", {
        signal: AbortSignal.timeout(3000),
        redirect: "error",
        cache: "no-store",
      }),
    ]);
    if (!health.ok || !voices.ok) throw Error(vieneuMissing);
    const h = await health.json();
    const v = await voices.json();
    if (h.status !== "ok" || !Array.isArray(v.data)) throw Error(vieneuMissing);
    return v.data as { id: string; name?: string; aliases?: string[] }[];
  } catch {
    throw Error(vieneuMissing);
  }
}
let healthCache:
  | { until: number; promise: Promise<Awaited<ReturnType<typeof checkLocal>>> }
  | undefined;
async function checkLocal() {
  const [v, k] = await Promise.allSettled([
    vieneuVoices(),
    korva(["--help"], 5000),
  ]);
  return {
    vieneu: {
      ready: v.status === "fulfilled",
      voices: v.status === "fulfilled" ? v.value : [],
      message:
        v.status === "rejected" ? String(v.reason.message) : "Engine đang chạy",
    },
    korva: {
      ready: k.status === "fulfilled",
      message:
        k.status === "rejected"
          ? String(k.reason.message)
          : "Đã cài CLI; mô hình được kiểm tra khi tạo audio",
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
export async function speakLocal(text: string, file: string, s: Settings) {
  if (s.ttsProvider === "tts-studio-local")
    throw Error("Vietnamese TTS Studio - Clone giọng local - đang phát triển");
  const voice = localVoiceId(s.voice);
  if (
    !Object.hasOwn(localVoiceNames, voice) ||
    (s.ttsProvider === "vieneu-local" && voice !== "ngoc_huyen")
  )
    throw Error("Giọng không thuộc engine local đã chọn.");
  if (
    s.ttsProvider === "vieneu-local" &&
    !hasVieneuVoice(await vieneuVoices(), localVoiceNames[voice])
  )
    throw Error(
      "VieNeu-TTS chưa có preset " +
        localVoiceNames[voice] +
        ". Kiểm tra /v1/voices.",
    );
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary: string[] = [];
  try {
    const normalized: string[] = [];
    for (const part of chunks(text, 1500)) {
      const raw = path.join(directory, randomUUID() + ".wav");
      const clean = path.join(directory, randomUUID() + ".wav");
      temporary.push(raw, clean);
      if (s.ttsProvider === "vieneu-local") {
        let response: Response;
        try {
          response = await fetch(vieneuURL() + "/v1/audio/speech", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            redirect: "error",
            body: JSON.stringify({
              model: "vieneu-v3-turbo",
              input: part,
              voice: localVoiceNames[voice],
              response_format: "wav",
            }),
            signal: AbortSignal.timeout(600000),
          });
        } catch {
          throw Error(vieneuMissing);
        }
        if (!response.ok)
          throw Error(
            "VieNeu-TTS trả lỗi HTTP " +
              response.status +
              ". Kiểm tra cửa sổ engine.",
          );
        const bytes = Buffer.from(await response.arrayBuffer());
        if (
          bytes.toString("ascii", 0, 4) !== "RIFF" ||
          bytes.toString("ascii", 8, 12) !== "WAVE"
        )
          throw Error("VieNeu-TTS không trả về tệp WAV hợp lệ.");
        await writeFile(raw, bytes);
      } else {
        // A leading space prevents CLI option parsing of user text starting with '-'.
        await korva([
          "synth",
          " " + part,
          "-v",
          voice,
          "-o",
          raw,
          "--speed",
          "1",
        ]);
      }
      // Normalize streaming WAV headers before probing duration or concatenating.
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
        clean,
      ]);
      normalized.push(clean);
    }
    if (!normalized.length) throw Error("Nội dung lời đọc đang trống.");
    const list = path.join(directory, randomUUID() + ".txt");
    temporary.push(list);
    await writeFile(
      list,
      normalized.map((f) => "file '" + path.basename(f) + "'").join("\n"),
    );
    const factor = Math.pow(2, s.pitch / 12);
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
    throw e;
  } finally {
    await Promise.all(temporary.map((f) => unlink(f).catch(() => {})));
  }
}
