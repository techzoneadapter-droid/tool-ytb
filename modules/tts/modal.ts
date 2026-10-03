import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { Settings } from "../project/types";
import { duration } from "../videoRender/process";
import { modalFetch } from "../providers/modal/client";

export type ModalVoice = {
  id: string;
  name?: string;
  description?: string;
  gender?: string;
  aliases?: string[];
};

export async function modalVoices(): Promise<ModalVoice[]> {
  const response = await modalFetch("tts", "/v1/voices", {}, 10000);
  const body = await response.json();
  const data = Array.isArray(body) ? body : body?.data;
  if (!Array.isArray(data)) throw Error("VieNeu Cloud trả danh sách giọng không hợp lệ.");
  return data.filter(
    (voice): voice is ModalVoice =>
      !!voice &&
      typeof voice.id === "string" &&
      voice.id.trim().length > 0,
  );
}

export async function speakModal(
  text: string,
  file: string,
  settings: Settings,
  options: { preview?: boolean } = {},
) {
  await mkdir(path.dirname(file), { recursive: true });
  const response = await modalFetch(
    "tts",
    "/v1/audio/speech",
    {
      method: "POST",
      body: JSON.stringify({
        model: "vieneu-v3-turbo",
        input: text,
        voice: settings.voice,
        response_format: "wav",
        sample_rate: 48000,
        preview: !!options.preview,
      }),
    },
    900000,
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length < 44 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw Error("VieNeu Cloud không trả WAV hợp lệ.");
  }
  const raw = file.endsWith(".wav") ? file : file + ".raw.wav";
  try {
    await writeFile(raw, bytes);
    if (raw !== file) {
      const { run } = await import("../videoRender/process");
      await run([
        "-y",
        "-i",
        raw,
        "-vn",
        "-af",
        `atempo=${settings.speed},volume=${settings.volume},apad=pad_dur=${settings.pause}`,
        "-ac",
        "1",
        file,
      ]);
    }
    const seconds = await duration(file);
    if (!(seconds > 0)) throw Error("VieNeu Cloud tạo audio không có thời lượng hợp lệ.");
    return seconds;
  } catch (error) {
    await unlink(file).catch(() => {});
    throw error;
  } finally {
    if (raw !== file) await unlink(raw).catch(() => {});
  }
}
