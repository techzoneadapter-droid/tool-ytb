import { imageConfig } from "./image-api";
import {
  imageAPIOptions,
  validateImageBaseURL,
  validImageModelID,
  type ImageAPIProvider,
} from "./image-api-options";
import {
  readImageAPI,
  saveImageAPI,
  type ImageAPIModel,
} from "./image-api-settings";

async function query(url: string, headers: Record<string, string>) {
  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(20000),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw Error("Không kết nối được API. Kiểm tra mạng và thử lại.");
  }
  if (!response.ok)
    throw Error(
      `Kết nối API thất bại (HTTP ${response.status}). ${response.status === 401 || response.status === 403 ? "API key không hợp lệ hoặc thiếu quyền truy cập." : response.status === 429 ? "Tài khoản đang bị giới hạn tốc độ hoặc hạn mức." : "Hãy kiểm tra tài khoản nhà cung cấp."}`,
    );
  return response.json().catch(() => {
    throw Error("API trả về dữ liệu không hợp lệ.");
  });
}

export async function fetchImageModels(
  provider: ImageAPIProvider,
  key: string,
  baseURL?: string,
  explicitModel?: string,
) {
  let models: ImageAPIModel[] = [];
  if (provider === "openai" || provider === "api-compatible") {
    const data = await query(
      `${provider === "openai" ? "https://api.openai.com/v1" : validateImageBaseURL(baseURL || "")}/models`,
      { Authorization: `Bearer ${key}` },
    );
    if (!Array.isArray(data.data))
      throw Error("Danh sách model OpenAI không hợp lệ.");
    models = data.data
      .filter(
        (model: { id?: string; output_modalities?: string[] }) =>
          typeof model.id === "string" &&
          (provider === "openai"
            ? /^(gpt-image-|chatgpt-image-)/.test(model.id)
            : model.id === explicitModel ||
              /image|flux|diffusion|sdxl/i.test(model.id) ||
              model.output_modalities?.includes("image")),
      )
      .map((model: { id: string }) => ({ id: model.id, label: model.id }));
  } else if (provider === "gemini") {
    let token = "";
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const url = new URL(
        "https://generativelanguage.googleapis.com/v1beta/models",
      );
      url.searchParams.set("pageSize", "100");
      if (token) url.searchParams.set("pageToken", token);
      const data = await query(url.href, { "x-goog-api-key": key });
      if (!Array.isArray(data.models))
        throw Error("Danh sách model Gemini không hợp lệ.");
      for (const model of data.models) {
        const id =
          typeof model.name === "string"
            ? model.name.replace(/^models\//, "")
            : "";
        if (/^gemini-.*image/.test(id))
          models.push({
            id,
            label:
              typeof model.displayName === "string" ? model.displayName : id,
          });
      }
      token = data.nextPageToken || "";
      if (!token) break;
      if (seen.has(token) || page === 19)
        throw Error("Chưa tải được toàn bộ danh sách model. Hãy kết nối lại.");
      seen.add(token);
    }
  } else {
    // v1 engines/list describes legacy diffusion engines, not v2 Core/Ultra.
    // Verify the key with the account API, then expose supported v2 endpoints.
    await query("https://api.stability.ai/v1/user/account", {
      Authorization: `Bearer ${key}`,
    });
    models = [
      { id: "core", label: "Stable Image Core" },
      { id: "ultra", label: "Stable Image Ultra" },
    ];
  }
  models = [
    ...new Map(
      models
        .filter((model) => validImageModelID(model.id, provider))
        .map((model) => [model.id, model]),
    ).values(),
  ].sort((a, b) => a.id.localeCompare(b.id));
  if (!models.length)
    throw Error(
      "Key kết nối được nhưng API không trả về model tạo ảnh phù hợp.",
    );
  return models;
}

export async function connectImageAPI(
  provider: ImageAPIProvider,
  enteredKey?: string,
  baseURL?: string,
  explicitModel?: string,
) {
  if (explicitModel && !validImageModelID(explicitModel, provider))
    throw Error("Model ảnh không hợp lệ.");
  const config = imageConfig(provider);
  const key = enteredKey?.trim() || config.key?.trim();
  if (!key) throw Error("Nhập API key trước khi kết nối.");
  if (key.length > 1024 || /[\r\n\x00-\x1f]/.test(key))
    throw Error("API key không hợp lệ.");
  const base =
    provider === "api-compatible"
      ? validateImageBaseURL(baseURL || config.baseURL || "")
      : undefined;
  let models: ImageAPIModel[];
  try {
    models = await fetchImageModels(provider, key, base, explicitModel);
  } catch (error) {
    const old = readImageAPI(provider);
    if (old && key === old.key)
      saveImageAPI(provider, { ...old, connected: false });
    throw error;
  }
  if (explicitModel && !models.some((item) => item.id === explicitModel))
    throw Error("Model không có trong danh sách API trả về.");
  const model =
    explicitModel ||
    (models.some((item) => item.id === config.model)
      ? config.model
      : models[0].id);
  const saved = {
    key,
    baseURL: base,
    model,
    models,
    connected: true,
    checkedAt: new Date().toISOString(),
    catalogSource:
      provider === "stability"
        ? ("stability-endpoints" as const)
        : ("api" as const),
  };
  saveImageAPI(provider, saved);
  const { key: _key, ...publicSettings } = saved;
  return publicSettings;
}

export function selectImageModel(provider: ImageAPIProvider, model: string) {
  if (!validImageModelID(model, provider))
    throw Error("Model ảnh không hợp lệ.");
  const saved = readImageAPI(provider);
  if (!saved?.connected)
    throw Error("Kết nối API và tải danh sách model trước khi chọn.");
  if (!saved.models.some((item) => item.id === model))
    throw Error("Model không thuộc danh sách đã tải từ kết nối này.");
  saveImageAPI(provider, { ...saved, model });
  return {
    model,
    label: imageAPIOptions.find((option) => option.id === provider)!.label,
  };
}
