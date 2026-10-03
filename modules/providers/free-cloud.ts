const POLLINATIONS = "https://gen.pollinations.ai";
const HORDE = "https://aihorde.net/api/v2";

export function pollinationsConfigured() {
  return !!process.env.POLLINATIONS_API_KEY?.trim();
}

export async function pollinationsAudioCatalog() {
  try {
    const response = await fetch(POLLINATIONS + "/audio/models", {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { ready: false, model: "", voices: [] as string[] };
    const body = await response.json();
    const rows = Array.isArray(body) ? body : body?.data || body?.models || [];
    const tts = rows.filter((row: any) => {
      const task = String(row?.task || row?.type || row?.category || "").toLowerCase();
      return task.includes("speech") || task.includes("tts") || Array.isArray(row?.voices);
    });
    const preferred =
      tts.find((row: any) => String(row?.id || "").toLowerCase().includes("tts")) ||
      tts[0];
    const model =
      process.env.POLLINATIONS_TTS_MODEL ||
      String(preferred?.id || preferred?.model || "");
    const voices = [
      ...new Set(
        tts.flatMap((row: any) =>
          Array.isArray(row?.voices)
            ? row.voices.map((voice: any) =>
                typeof voice === "string" ? voice : voice?.id || voice?.name,
              )
            : [],
        ).filter(Boolean),
      ),
    ] as string[];
    return {
      ready: pollinationsConfigured() && !!model,
      model,
      voices,
    };
  } catch {
    return { ready: false, model: "", voices: [] as string[] };
  }
}

export async function pollinationsSpeech(
  text: string,
  voice: string,
) {
  const key = process.env.POLLINATIONS_API_KEY;
  if (!key)
    throw Error(
      "Pollinations chưa có API key. Tạo key ở enter.pollinations.ai rồi đặt POLLINATIONS_API_KEY trong .env.local.",
    );
  const catalog = await pollinationsAudioCatalog();
  if (!catalog.model)
    throw Error("Pollinations không trả model TTS khả dụng.");
  const response = await fetch(POLLINATIONS + "/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: catalog.model,
      input: text,
      voice: voice || catalog.voices[0],
      response_format: "wav",
    }),
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok)
    throw Error(
      "Pollinations TTS thất bại (" +
        response.status +
        "). Kiểm tra key/quota Pollen.",
    );
  return Buffer.from(await response.arrayBuffer());
}

export async function pollinationsImage(
  prompt: string,
  aspect: "16:9" | "9:16",
  seed: number,
) {
  const key = process.env.POLLINATIONS_API_KEY;
  const model = process.env.POLLINATIONS_IMAGE_MODEL || "flux";

  if (!key) {
    const [width, height] = aspect === "9:16" ? [768, 1344] : [1344, 768];
    const url =
      "https://image.pollinations.ai/prompt/" +
      encodeURIComponent(prompt) +
      "?" +
      new URLSearchParams({
        model,
        width: String(width),
        height: String(height),
        seed: String(Math.max(0, seed)),
        nologo: "true",
        private: "true",
      }).toString();
    const response = await fetch(url, {
      signal: AbortSignal.timeout(300000),
      redirect: "follow",
      cache: "no-store",
    });
    if (!response.ok)
      throw Error(
        "Pollinations anonymous thất bại (" +
          response.status +
          "). Có thể anonymous đang bị giới hạn; thêm POLLINATIONS_API_KEY để tăng độ ổn định.",
      );
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      model: model + "-anonymous",
    };
  }

  const response = await fetch(POLLINATIONS + "/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      size: aspect === "9:16" ? "768x1344" : "1344x768",
      response_format: "b64_json",
      seed,
      n: 1,
    }),
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok)
    throw Error(
      "Pollinations Image thất bại (" +
        response.status +
        "). Kiểm tra key/quota Pollen.",
    );
  const body = await response.json();
  const encoded = body?.data?.[0]?.b64_json;
  if (!encoded) throw Error("Pollinations không trả dữ liệu ảnh hợp lệ.");
  return {
    bytes: Buffer.from(encoded, "base64"),
    model,
  };
}

export async function aiHordeImage(
  prompt: string,
  aspect: "16:9" | "9:16",
  seed: number,
) {
  const apikey = process.env.AI_HORDE_API_KEY || "0000000000";
  const [width, height] = aspect === "9:16" ? [448, 768] : [768, 448];
  const request = await fetch(HORDE + "/generate/async", {
    method: "POST",
    headers: {
      apikey,
      "Client-Agent": "StoryFlow:1.0:github.com/techzoneadapter-droid/tool-ytb",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      params: {
        sampler_name: "k_euler_a",
        cfg_scale: 7,
        steps: 22,
        width,
        height,
        n: 1,
        seed: String(Math.max(0, seed)),
      },
      nsfw: false,
      censor_nsfw: true,
      slow_workers: true,
      trusted_workers: false,
      r2: true,
      shared: false,
      ...(process.env.AI_HORDE_MODEL
        ? { models: [process.env.AI_HORDE_MODEL] }
        : {}),
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!request.ok)
    throw Error("AI Horde không nhận yêu cầu (" + request.status + ").");
  const submitted = await request.json();
  if (!submitted?.id) throw Error("AI Horde không trả mã yêu cầu.");

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const check = await fetch(HORDE + "/generate/check/" + submitted.id, {
      headers: { apikey },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!check.ok) continue;
    const state = await check.json();
    if (state?.faulted) throw Error("AI Horde báo tác vụ tạo ảnh bị lỗi.");
    if (!state?.done) continue;

    const status = await fetch(HORDE + "/generate/status/" + submitted.id, {
      headers: { apikey },
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    if (!status.ok) throw Error("Không lấy được ảnh từ AI Horde.");
    const body = await status.json();
    const generation = body?.generations?.[0];
    if (!generation?.img) throw Error("AI Horde không trả ảnh.");
    if (/^https?:\/\//i.test(generation.img)) {
      const image = await fetch(generation.img, {
        signal: AbortSignal.timeout(60000),
      });
      if (!image.ok) throw Error("Không tải được ảnh AI Horde.");
      return {
        bytes: Buffer.from(await image.arrayBuffer()),
        model: generation.model || "community",
      };
    }
    return {
      bytes: Buffer.from(generation.img, "base64"),
      model: generation.model || "community",
    };
  }
  throw Error(
    "AI Horde chờ quá 10 phút. Đây là mạng GPU cộng đồng nên anonymous có thể phải xếp hàng lâu.",
  );
}
