import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { Settings } from "../project/types";
import { duration, run } from "../videoRender/process";
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
  if (!Array.isArray(data))
    throw Error("VieNeu Cloud trả danh sách giọng không hợp lệ.");
  return data.filter(
    (voice): voice is ModalVoice =>
      !!voice &&
      typeof voice.id === "string" &&
      voice.id.trim().length > 0,
  );
}

async function finalizeWav(
  bytes: Buffer,
  file: string,
  settings: Settings,
) {
  await mkdir(path.dirname(file), { recursive: true });
  const raw = file.endsWith(".wav") ? file + ".source.wav" : file + ".raw.wav";
  try {
    await writeFile(raw, bytes);
    const factor = Math.pow(2, settings.pitch / 12);
    await run([
      "-y",
      "-i",
      raw,
      "-vn",
      "-af",
      `asetrate=${48000 * factor},aresample=48000,atempo=${1 / factor},atempo=${settings.speed},volume=${settings.volume},apad=pad_dur=${settings.pause}`,
      "-ar",
      "48000",
      "-ac",
      "1",
      file,
    ]);
    const seconds = await duration(file);
    if (!(seconds > 0))
      throw Error("VieNeu Cloud tạo audio không có thời lượng hợp lệ.");
    return seconds;
  } catch (error) {
    await unlink(file).catch(() => {});
    throw error;
  } finally {
    await unlink(raw).catch(() => {});
  }
}

export async function speakModal(
  text: string,
  file: string,
  settings: Settings,
  options: { preview?: boolean } = {},
) {
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
  )
    throw Error("VieNeu Cloud không trả WAV hợp lệ.");
  return finalizeWav(bytes, file, settings);
}

export async function speakModalBatch(
  items: { id: string; text: string; file: string }[],
  settings: Settings,
) {
  if (!items.length) return new Map<string, number>();
  if (items.length > 32) throw Error("VieNeu Cloud nhận tối đa 32 đoạn mỗi batch.");
  const response = await modalFetch(
    "tts",
    "/v1/audio/batch",
    {
      method: "POST",
      body: JSON.stringify({
        items: items.map(({ id, text }) => ({ id, text })),
        voice: settings.voice,
        batch_size: Math.min(16, items.length),
      }),
    },
    1_800_000,
  );
  const body = await response.json();
  if (!Array.isArray(body?.data))
    throw Error("VieNeu Cloud batch trả dữ liệu không hợp lệ.");
  const byId = new Map<string, { audio_wav_base64?: string }>(
    body.data.map((item: { id: string; audio_wav_base64?: string }) => [
      item.id,
      item,
    ]),
  );
  const durations = new Map<string, number>();
  for (const item of items) {
    const result = byId.get(item.id);
    if (!result?.audio_wav_base64)
      throw Error("VieNeu Cloud thiếu audio cho một cảnh trong batch.");
    const bytes = Buffer.from(result.audio_wav_base64, "base64");
    durations.set(item.id, await finalizeWav(bytes, item.file, settings));
  }
  return durations;
}
