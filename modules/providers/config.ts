import { vietnameseVoices, legacyOpenAIVoices } from "../tts/voices";
import { localStatus } from "../tts/local";
import { localVoiceNames, type TTSProvider } from "../tts/local-voices";
import { modalVoices } from "../tts/modal";
import { modalConfigured, modalHealth } from "./modal/client";
import { runtimeStatus } from "./runtime-status";
import { pollinationsAudioCatalog, pollinationsConfigured } from "./free-cloud";
import { edgeVoices } from "../tts/edge";
import { flowHealth } from "./flow-browser";
import { imageConfig, imageAPIStatus } from "./image-api";
export { imageConfig, requireImage } from "./image-api";

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

export async function providerStatus() {
  const [local, runtime, modalTTS, modalImage, pollinations, flow] = await Promise.all([
    localStatus(),
    runtimeStatus(),
    modalHealth("tts"),
    modalHealth("image"),
    pollinationsAudioCatalog(),
    flowHealth(),
  ]);
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

  const modalVoiceList = modalTTS.ready
    ? await modalVoices().catch(() => [])
    : [];

  return {
    local,
    runtime,
    modal: {
      tts: {
        ...modalTTS,
        configured: modalConfigured("tts"),
      },
      image: {
        ...modalImage,
        configured: modalConfigured("image"),
      },
    },
    tts: { provider: t.provider, configured: t.configured },
    image: {
      provider: imageConfig().provider,
      configured: !!imageAPIStatus()[imageConfig().provider as keyof ReturnType<typeof imageAPIStatus>]?.configured,
    },
    imageAPIs: imageAPIStatus(),
    flow: {
      ...flow,
      configured: !!process.env.FLOW_PROJECT_URL,
    },
    freeCloud: {
      aiHorde: {
        configured: true,
        ready: true,
        message: process.env.AI_HORDE_API_KEY
          ? "Đã cấu hình API key riêng"
          : "Anonymous miễn phí · ưu tiên thấp",
      },
      pollinations: {
        configured: pollinationsConfigured(),
        ready: pollinations.ready,
        ttsReady: pollinations.ready,
        imageReady: true,
        model: pollinations.model,
        message: pollinationsConfigured()
          ? pollinations.ready
            ? "TTS và ảnh cloud sẵn sàng"
            : "Ảnh dùng được; TTS chưa tìm thấy model"
          : "Ảnh anonymous dùng được; TTS cần POLLINATIONS_API_KEY",
      },
    },
    voices: [
      ...edgeVoices.map((voice) => ({
        ...voice,
        provider: "edge-online" as TTSProvider,
        key: "edge-online:" + voice.id,
        configured: true,
        voiceId: voice.id,
        status: "Miễn phí · không cần API key · dùng Microsoft Edge Read Aloud",
      })),
      ...pollinations.voices.map((voice) => ({
        id: voice,
        name: "Pollinations · " + voice,
        description: "Giọng cloud qua Pollinations API.",
        gender: "Không phân loại",
        categories: ["Cloud"],
        provider: "pollinations" as TTSProvider,
        key: "pollinations:" + voice,
        configured: pollinations.ready,
        voiceId: voice,
        status: pollinations.ready ? "Sẵn sàng" : "Chưa cấu hình",
      })),
      ...modalVoiceList.map((v) => ({
        ...v,
        name: v.name || v.id,
        provider: "modal-vieneu" as TTSProvider,
        key: "modal-vieneu:" + v.id,
        configured: modalTTS.ready,
        voiceId: v.id,
        status: modalTTS.message,
      })),
      ...local.korva.voices.map((v) => ({
        ...v,
        name: localVoiceNames[v.id] || v.name || v.id,
        provider: "korva-local" as TTSProvider,
        key: "korva-local:" + v.id,
        configured: local.korva.ready,
        voiceId: v.id,
        status: local.korva.message,
      })),
      ...local.vieneu.voices.map((v) => ({
        ...v,
        name: v.name || v.id,
        provider: "vieneu-local" as TTSProvider,
        key: "vieneu-local:" + v.id,
        configured: local.vieneu.ready,
        voiceId: v.id,
        status: local.vieneu.message,
      })),
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
    ].sort((a, b) => {
      const order = (provider: string) =>
        provider === "modal-vieneu"
          ? 0
          : provider === "edge-online"
            ? 1
            : provider === "pollinations"
              ? 2
              : provider === "vieneu-local"
                ? 3
                : provider === "korva-local"
                  ? 4
                  : 5;
      return order(a.provider) - order(b.provider);
    }),
  };
}
