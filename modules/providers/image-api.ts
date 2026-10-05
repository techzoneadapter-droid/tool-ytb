import { imageAPIOptions, isImageAPIProvider } from "./image-api-options";
import { readImageAPI, type ImageAPIModel } from "./image-api-settings";

export function imageConfig(provider = process.env.IMAGE_PROVIDER || "openai") {
  const saved = isImageAPIProvider(provider) ? readImageAPI(provider) : undefined;
  if (saved) return { provider, key: saved.key, model: saved.model };
  if (provider === "gemini") return {
    provider, key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    model: process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image",
  };
  if (provider === "stability") return {
    provider, key: process.env.STABILITY_API_KEY,
    model: process.env.STABILITY_IMAGE_MODEL || "core",
  };
  return {
    provider,
    key: provider === "openai" ? process.env.IMAGE_API_KEY || process.env.OPENAI_API_KEY : undefined,
    model: process.env.OPENAI_IMAGE_MODEL || process.env.IMAGE_MODEL || "gpt-image-1",
  };
}

export function requireImage(provider?: string) {
  const config = imageConfig(provider);
  const option = imageAPIOptions.find(option => option.id === config.provider);
  if (!option || !config.key?.trim())
    throw Error(`Chưa cấu hình API tạo ảnh${option ? `: ${option.label}. Nhập API key và kết nối trong phần Engine ảnh (${option.keyEnv}).` : "."}`);
  if (!/^[a-zA-Z0-9._-]+$/.test(config.model))
    throw Error(`${option.modelEnv} không phải mã model hợp lệ.`);
  if (config.provider === "stability" && !["core", "ultra"].includes(config.model))
    throw Error("STABILITY_IMAGE_MODEL chỉ hỗ trợ core hoặc ultra.");
  return config;
}

export function imageAPIStatus() {
  return Object.fromEntries(imageAPIOptions.map(option => {
    const config = imageConfig(option.id);
    const saved = readImageAPI(option.id);
    let configured = false;
    try { requireImage(option.id); configured = true; } catch { /* Metadata only. */ }
    return [option.id, { label: option.label, model: config.model, configured, keyEnv: option.keyEnv, connected: configured && saved?.connected === true, models: saved?.models || [], checkedAt: saved?.checkedAt, catalogSource: saved?.catalogSource }];
  })) as Record<(typeof imageAPIOptions)[number]["id"], { label: string; model: string; configured: boolean; keyEnv: string; connected: boolean; models: ImageAPIModel[]; checkedAt?: string; catalogSource?: string }>;
}

function decodeImage(data: unknown, label: string) {
  if (typeof data !== "string" || !data.length || data.length > 54_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
    throw Error(`${label} không trả về dữ liệu ảnh base64 hợp lệ. Model có thể không hỗ trợ tạo ảnh hoặc yêu cầu đã bị từ chối.`);
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length) throw Error(`${label} trả về ảnh rỗng.`);
  return bytes;
}

// No automatic retry/fallback here: a repeated paid request can incur extra charges.
export async function generateAPIImage(provider: string | undefined, prompt: string, aspect: "16:9" | "9:16", seed = 0, selectedModel?: string) {
  const config = requireImage(provider);
  if (selectedModel) {
    if (!/^[a-zA-Z0-9._-]+$/.test(selectedModel) || (config.provider === "stability" && !["core", "ultra"].includes(selectedModel))) throw Error("Model ảnh không hợp lệ.");
    config.model = selectedModel;
  }
  if (!isImageAPIProvider(config.provider)) throw Error("Nhà cung cấp ảnh không hợp lệ.");
  const label = imageAPIOptions.find(option => option.id === config.provider)!.label;
  const composed = `${prompt} Compose for ${aspect} with important subjects inside the central crop.`;
  let url: string;
  let body: BodyInit;
  const headers: Record<string, string> = {};
  if (config.provider === "stability") {
    url = `https://api.stability.ai/v2beta/stable-image/generate/${config.model}`;
    const form = new FormData();
    form.set("prompt", composed);
    form.set("aspect_ratio", aspect);
    form.set("output_format", "png");
    form.set("seed", String(Math.abs(Math.trunc(seed)) % 4294967295));
    body = form;
    headers.Authorization = `Bearer ${config.key}`;
    headers.Accept = "image/*";
  } else {
    headers["Content-Type"] = "application/json";
    if (config.provider === "gemini") {
      url = "https://generativelanguage.googleapis.com/v1beta/interactions";
      headers["x-goog-api-key"] = config.key!;
      body = JSON.stringify({
        model: config.model, input: composed, store: false,
        response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: aspect, image_size: "1K", delivery: "inline" },
      });
    } else {
      url = "https://api.openai.com/v1/images/generations";
      headers.Authorization = `Bearer ${config.key}`;
      body = JSON.stringify({ model: config.model, prompt: composed, size: aspect === "9:16" ? "1024x1536" : "1536x1024", n: 1, output_format: "png" });
    }
  }
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(240000) });
  } catch {
    throw Error(`${label}: mất kết nối hoặc quá thời gian chờ. Kiểm tra trạng thái yêu cầu trước khi thử lại.`);
  }
  if (!response.ok) {
    const reason = response.status === 401 || response.status === 403 ? "Kiểm tra API key và quyền truy cập model."
      : response.status === 429 || response.status === 402 ? "Kiểm tra hạn mức, số dư hoặc giới hạn tốc độ."
      : response.status === 400 || response.status === 422 ? "Kiểm tra model, prompt và chính sách nội dung."
      : "Nhà cung cấp chưa xử lý được yêu cầu.";
    // Do not expose upstream error bodies, which can echo keys or request data.
    throw Error(`${label}: API tạo ảnh thất bại (HTTP ${response.status}). ${reason}`);
  }
  let bytes: Buffer;
  if (config.provider === "stability") {
    if (!response.headers.get("content-type")?.startsWith("image/"))
      throw Error(`${label} không trả về ảnh hợp lệ.`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 40_000_000) throw Error(`${label}: kích thước ảnh không hợp lệ.`);
  } else {
    const result = await response.json().catch(() => { throw Error(`${label} không trả về JSON hợp lệ.`); });
    if (config.provider === "gemini") {
      // Only final model_output images; never use interim thought images.
      const parts = (result.steps || []).filter((step: { type?: string }) => step.type === "model_output")
        .flatMap((step: { content?: { type?: string; data?: string; mime_type?: string }[] }) => step.content || []);
      const image = parts.find((part: { type?: string; data?: string; mime_type?: string }) => part.type === "image" && part.mime_type?.startsWith("image/") && part.data);
      bytes = decodeImage(image?.data, label);
    } else bytes = decodeImage(result.data?.[0]?.b64_json, label);
  }
  return { bytes, engine: config.provider, model: config.model };
}
