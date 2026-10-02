import { vietnameseVoices, legacyOpenAIVoices } from "../tts/voices";
import { localStatus, hasVieneuVoice } from "../tts/local";
import { localVoices, type TTSProvider } from "../tts/local-voices";
export function ttsConfig() {
  const provider = process.env.TTS_PROVIDER || "openai";
  const key =
    provider === "azure"
      ? process.env.AZURE_SPEECH_KEY
      : process.env.TTS_API_KEY || process.env.OPENAI_API_KEY;
  const region = process.env.AZURE_SPEECH_REGION || "";
  let mapping: Record<string, string> = {};
  try {
    mapping = JSON.parse(process.env.TTS_VOICE_MAP || "{}");
  } catch {
    throw Error("TTS_VOICE_MAP phải là đối tượng JSON hợp lệ.");
  }
  if (
    !mapping ||
    Array.isArray(mapping) ||
    typeof mapping !== "object" ||
    Object.values(mapping).some((v) => typeof v !== "string")
  )
    throw Error("TTS_VOICE_MAP phải chứa tên cấu hình và mã giọng dạng chữ.");
  return {
    provider,
    key,
    region,
    mapping,
    configured:
      !!key && (provider === "openai" || (provider === "azure" && !!region)),
  };
}
export function requireTTS(voice: string) {
  const c = ttsConfig();
  if (!c.configured) throw Error("Chưa cấu hình API TTS");
  const id =
    c.mapping[voice] ||
    (c.provider === "openai" && legacyOpenAIVoices.includes(voice)
      ? voice
      : undefined);
  if (!id)
    throw Error(
      "Giọng này chưa có mã giọng thật từ nhà cung cấp. Vui lòng cấu hình TTS_VOICE_MAP.",
    );
  return { ...c, voiceId: id };
}
export function imageConfig() {
  return {
    provider: process.env.IMAGE_PROVIDER || "openai",
    key: process.env.IMAGE_API_KEY || process.env.OPENAI_API_KEY,
    model: process.env.IMAGE_MODEL || "gpt-image-1",
  };
}
export function requireImage() {
  const c = imageConfig();
  if (c.provider !== "openai" || !c.key)
    throw Error("Chưa cấu hình API tạo ảnh");
  return c;
}
export async function providerStatus() {
  const local = await localStatus();
  let t;
  try {
    t = ttsConfig();
  } catch {
    t = {
      provider: "",
      configured: false,
      mapping: {} as Record<string, string>,
    };
  }
  return {
    local,
    tts: { provider: t.provider, configured: t.configured },
    image: {
      provider: imageConfig().provider,
      configured: imageConfig().provider === "openai" && !!imageConfig().key,
    },
    voices: [
      ...localVoices.map((v) => ({
        ...v,
        provider: "korva-local" as TTSProvider,
        key: "korva-local:" + v.id,
        configured: local.korva.ready,
        voiceId: v.id,
        status: local.korva.message,
      })),
      {
        ...localVoices[0],
        name: "Ngọc Huyền",
        description: "Giọng dựng sẵn của VieNeu-TTS v3 Turbo, chạy trên máy.",
        provider: "vieneu-local" as TTSProvider,
        key: "vieneu-local:ngoc_huyen",
        configured:
          local.vieneu.ready &&
          hasVieneuVoice(local.vieneu.voices, "Ngọc Huyền"),
        voiceId: "Ngọc Huyền",
        status: !local.vieneu.ready
          ? local.vieneu.message
          : hasVieneuVoice(local.vieneu.voices, "Ngọc Huyền")
            ? "Engine đang chạy; có preset Ngọc Huyền"
            : "Engine chưa có preset Ngọc Huyền",
      },
      ...[
        ...vietnameseVoices,
        ...legacyOpenAIVoices.map((id) => ({
          id,
          name: "OpenAI · " + id,
          description:
            "Giọng có sẵn của OpenAI, hỗ trợ đọc văn bản đa ngôn ngữ.",
          gender: "Không phân loại" as const,
          categories: [],
        })),
      ].map((v) => ({
        ...v,
        provider: "cloud" as TTSProvider,
        key: "cloud:" + v.id,
        status: !t.configured
          ? "Chưa cấu hình API TTS"
          : "Cần mã giọng hợp lệ từ nhà cung cấp",
        configured:
          !!t.configured &&
          !!(
            t.mapping[v.id] ||
            (t.provider === "openai" && legacyOpenAIVoices.includes(v.id))
          ),
        voiceId:
          t.mapping[v.id] ||
          (t.provider === "openai" && legacyOpenAIVoices.includes(v.id)
            ? v.id
            : null),
      })),
    ],
  };
}
