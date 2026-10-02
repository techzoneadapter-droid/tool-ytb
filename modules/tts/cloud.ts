import { writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Settings } from "../project/types";
import { requireTTS } from "../providers/config";
import { run, duration } from "../videoRender/process";
import { chunks } from "../project/parser";
const xml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export async function speak(text: string, file: string, s: Settings) {
  const c = requireTTS(s.voice);
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  if (c.provider === "azure") {
    if (!/^[a-z0-9]+$/.test(c.region)) throw Error("Vùng Azure không hợp lệ.");
    const voices = await fetch(
      "https://" +
        c.region +
        ".tts.speech.microsoft.com/cognitiveservices/voices/list",
      {
        headers: { "Ocp-Apim-Subscription-Key": c.key! },
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!voices.ok)
      throw Error(
        "Không xác minh được danh mục giọng Azure (" + voices.status + ").",
      );
    const catalog = await voices.json();
    if (
      !Array.isArray(catalog) ||
      !catalog.some((v) => v.ShortName === c.voiceId)
    )
      throw Error(
        "Mã giọng không có trong danh mục Azure của vùng đã cấu hình.",
      );
  }
  const temporary: string[] = [];
  try {
    for (const part of chunks(text, 1800)) {
      const response =
        c.provider === "azure"
          ? await fetch(
              "https://" +
                c.region +
                ".tts.speech.microsoft.com/cognitiveservices/v1",
              {
                method: "POST",
                headers: {
                  "Ocp-Apim-Subscription-Key": c.key!,
                  "Content-Type": "application/ssml+xml",
                  "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
                  "User-Agent": "StoryFlow",
                },
                body:
                  '<speak version="1.0" xml:lang="vi-VN"><voice name="' +
                  xml(c.voiceId) +
                  '"><prosody rate="' +
                  Math.round((s.speed - 1) * 100) +
                  '%">' +
                  xml(part) +
                  "</prosody></voice></speak>",
                signal: AbortSignal.timeout(120000),
              },
            )
          : await fetch("https://api.openai.com/v1/audio/speech", {
              method: "POST",
              headers: {
                Authorization: "Bearer " + c.key,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: process.env.TTS_MODEL || "tts-1",
                voice: c.voiceId,
                input: part,
                response_format: "mp3",
                speed: s.speed,
              }),
              signal: AbortSignal.timeout(120000),
            });
      if (!response.ok)
        throw Error(
          "API TTS thất bại (" +
            response.status +
            "). Kiểm tra khóa, mã giọng và hạn mức dịch vụ.",
        );
      const raw = path.join(directory, randomUUID() + ".mp3");
      temporary.push(raw);
      await writeFile(raw, Buffer.from(await response.arrayBuffer()));
      const seconds = await duration(raw);
      if (!Number.isFinite(seconds) || seconds <= 0)
        throw Error("API TTS không trả về âm thanh hợp lệ.");
    }
    if (!temporary.length) throw Error("Nội dung lời đọc đang trống.");
    const concat = path.join(directory, randomUUID() + ".txt");
    temporary.push(concat);
    await writeFile(
      concat,
      temporary
        .slice(0, -1)
        .map((f) => "file '" + path.basename(f) + "'")
        .join("\n"),
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
        path.basename(concat),
        "-af",
        `aresample=24000,asetrate=${24000 * factor},aresample=24000,atempo=${1 / factor},volume=${s.volume},apad=pad_dur=${s.pause}`,
        "-ac",
        "1",
        file,
      ],
      directory,
    );
    const seconds = await duration(file);
    if (!Number.isFinite(seconds) || seconds <= 0)
      throw Error("Tệp âm thanh không hợp lệ.");
    return seconds;
  } catch (e) {
    await unlink(file).catch(() => {});
    throw e;
  } finally {
    for (const f of temporary) await unlink(f).catch(() => {});
  }
}
