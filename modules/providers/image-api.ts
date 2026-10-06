import {
  imageAPIOptions,
  isImageAPIProvider,
  validateImageBaseURL,
  validImageModelID,
  type ImageAPIOptions,
} from "./image-api-options";
import { readImageAPI, type ImageAPIModel } from "./image-api-settings";
import sharp from "sharp";
import {
  imageCapabilities,
  requestImage,
  downloadImage,
  numericUsage,
  withImageSlot,
  ImagePipelineError,
  type APIImageInput,
  type APIImageResult,
} from "./api-image-provider";

export function imageConfig(provider = process.env.IMAGE_PROVIDER || "openai") {
  const saved = isImageAPIProvider(provider)
    ? readImageAPI(provider)
    : undefined;
  if (saved)
    return {
      provider,
      key: saved.key,
      model: saved.model,
      baseURL: saved.baseURL,
    };
  if (provider === "api-compatible")
    return {
      provider,
      key: process.env.API_IMAGE_KEY,
      model: process.env.API_IMAGE_MODEL || "",
      baseURL: process.env.API_IMAGE_BASE_URL,
    };
  if (provider === "gemini")
    return {
      provider,
      key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
      model: process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image",
    };
  if (provider === "stability")
    return {
      provider,
      key: process.env.STABILITY_API_KEY,
      model: process.env.STABILITY_IMAGE_MODEL || "core",
    };
  return {
    provider,
    key:
      provider === "openai"
        ? process.env.IMAGE_API_KEY || process.env.OPENAI_API_KEY
        : undefined,
    model:
      process.env.OPENAI_IMAGE_MODEL ||
      process.env.IMAGE_MODEL ||
      "gpt-image-1",
  };
}

export function requireImage(provider?: string) {
  const config = imageConfig(provider);
  const option = imageAPIOptions.find(
    (option) => option.id === config.provider,
  );
  if (!option || !config.key?.trim())
    throw Error(
      `Chưa cấu hình API tạo ảnh${option ? `: ${option.label}. Nhập API key và kết nối trong phần Engine ảnh (${option.keyEnv}).` : "."}`,
    );
  if (!validImageModelID(config.model, config.provider))
    throw Error(`${option.modelEnv} không phải mã model hợp lệ.`);
  if (config.provider === "api-compatible")
    validateImageBaseURL(config.baseURL || "");
  if (
    config.provider === "stability" &&
    !["core", "ultra"].includes(config.model)
  )
    throw Error("STABILITY_IMAGE_MODEL chỉ hỗ trợ core hoặc ultra.");
  return config;
}

export function imageAPIStatus() {
  return Object.fromEntries(
    imageAPIOptions.map((option) => {
      const config = imageConfig(option.id);
      const saved = readImageAPI(option.id);
      let configured = false;
      try {
        requireImage(option.id);
        configured = true;
      } catch {
        /* Metadata only. */
      }
      return [
        option.id,
        {
          label: option.label,
          model: config.model,
          baseURL: configured ? config.baseURL : undefined,
          configured,
          keyEnv: option.keyEnv,
          connected: configured && saved?.connected === true,
          models: saved?.models || [],
          checkedAt: saved?.checkedAt,
          catalogSource: saved?.catalogSource,
        },
      ];
    }),
  ) as Record<
    (typeof imageAPIOptions)[number]["id"],
    {
      label: string;
      model: string;
      baseURL?: string;
      configured: boolean;
      keyEnv: string;
      connected: boolean;
      models: ImageAPIModel[];
      checkedAt?: string;
      catalogSource?: string;
    }
  >;
}

function decodeImage(data: unknown, label: string) {
  if (
    typeof data !== "string" ||
    !data.length ||
    data.length > 54_000_000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  )
    throw new ImagePipelineError(
      data === undefined ? "IMAGE_API_FAILED" : "IMAGE_DOWNLOAD_FAILED",
      `${label} không trả về dữ liệu ảnh base64 hợp lệ. Model có thể không hỗ trợ tạo ảnh hoặc yêu cầu đã bị từ chối.`,
    );
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length) throw Error(`${label} trả về ảnh rỗng.`);
  return bytes;
}

export async function generateAPIImage(
  provider: string | undefined,
  prompt: string,
  aspect: "16:9" | "9:16",
  seed = 0,
  selectedModel?: string,
  input: APIImageInput = {},
): Promise<APIImageResult> {
  const config = requireImage(provider);
  if (selectedModel) {
    if (
      !validImageModelID(selectedModel, config.provider) ||
      (config.provider === "stability" &&
        !["core", "ultra"].includes(selectedModel))
    )
      throw Error("Model ảnh không hợp lệ.");
    config.model = selectedModel;
  }
  if (!isImageAPIProvider(config.provider))
    throw Error("Nhà cung cấp ảnh không hợp lệ.");
  const label = imageAPIOptions.find(
    (option) => option.id === config.provider,
  )!.label;
  // Experiential is a Chat Completions gateway, not an OpenAI Images endpoint.
  const isExperientialGateway =
    config.provider === "api-compatible" &&
    /^https:\/\/api\.experientiallabs\.ai\/(?:api\/)?v1\/?$/.test(
      config.baseURL || "",
    );
  const capabilities = imageCapabilities(
    config.provider,
    config.model,
    isExperientialGateway
      ? {
          ...input.options,
          supportsReferenceImages: true,
          supportsMultiImageInput: true,
        }
      : input.options,
  );
  const references =
    capabilities.supportsReferenceImages && input.options?.references !== false
      ? (input.references || []).slice(
          0,
          capabilities.supportsMultiImageInput ? 10 : 1,
        )
      : [];
  const referenceMap = references.length
    ? `REFERENCE IDENTITIES (input order): ${references.map((reference, index) => `${index + 1} = ${reference.name.replace(/\.[^.]+$/, "")}`).join("; ")}. Use these images only to lock each named character's identity; render the new chapter event.\n`
    : "";
  const composed = `${referenceMap}${prompt} Compose for ${aspect} with important subjects inside the central crop.${input.negativePrompt && !capabilities.supportsNegativePrompt ? ` Avoid: ${input.negativePrompt}` : ""}`;
  const size =
    input.options?.size && input.options.size !== "auto"
      ? input.options.size
      : aspect === "9:16"
        ? "1024x1536"
        : "1536x1024";
  let url: string;
  let body: BodyInit;
  const headers: Record<string, string> = {};
  if (config.provider === "stability") {
    url = `https://api.stability.ai/v2beta/stable-image/generate/${config.model}`;
    const form = new FormData();
    form.set("prompt", composed);
    form.set("aspect_ratio", aspect);
    form.set("output_format", "png");
    if (input.options?.seedMode !== "off")
      form.set("seed", String(Math.abs(Math.trunc(seed)) % 4294967295));
    if (input.negativePrompt) form.set("negative_prompt", input.negativePrompt);
    if (references.length && config.model === "ultra") {
      const reference = await sharp(references[0].bytes)
        .resize(
          aspect === "16:9" ? 1280 : 720,
          aspect === "16:9" ? 720 : 1280,
          { fit: "contain", background: "#dddddd" },
        )
        .png()
        .toBuffer();
      form.set(
        "image",
        new Blob([new Uint8Array(reference)], { type: "image/png" }),
        references[0].name,
      );
      form.set(
        "strength",
        String(
          Math.min(1, Math.max(0, input.options?.referenceStrength ?? 0.65)),
        ),
      );
    }
    body = form;
    headers.Authorization = `Bearer ${config.key}`;
    headers.Accept = "image/*";
  } else {
    headers["Content-Type"] = "application/json";
    if (config.provider === "gemini") {
      url = "https://generativelanguage.googleapis.com/v1beta/interactions";
      headers["x-goog-api-key"] = config.key!;
      body = JSON.stringify({
        model: config.model,
        input: references.length
          ? [
              ...references.map((ref) => ({
                type: "image",
                mime_type: ref.mime,
                data: ref.bytes.toString("base64"),
              })),
              { type: "text", text: composed },
            ]
          : composed,
        store: false,
        response_format: {
          type: "image",
          mime_type: "image/jpeg",
          aspect_ratio: aspect,
          image_size: "1K",
          delivery: "inline",
        },
      });
    } else if (isExperientialGateway) {
      // The gateway documents Chat Completions and Responses, not /images/*.
      // Omit unsupported sampling fields (notably modalities and seed).
      url = `${validateImageBaseURL(config.baseURL || "")}/chat/completions`;
      headers.Authorization = `Bearer ${config.key}`;
      body = JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "user",
            content: references.length
              ? [
                  { type: "text", text: composed },
                  ...references.map((ref) => ({
                    type: "image_url",
                    image_url: {
                      url: `data:${ref.mime};base64,${ref.bytes.toString("base64")}`,
                    },
                  })),
                ]
              : composed,
          },
        ],
      });
    } else {
      const baseURL =
        config.provider === "api-compatible"
          ? validateImageBaseURL(config.baseURL!)
          : "https://api.openai.com/v1";
      url = `${baseURL}/images/${references.length ? "edits" : "generations"}`;
      headers.Authorization = `Bearer ${config.key}`;
      const payload: Record<string, string | number> = {
        model: config.model,
        prompt: composed,
        size,
        n: 1,
      };
      if (config.provider === "openai") payload.output_format = "png";
      if (capabilities.supportsSeed && input.options?.seedMode !== "off")
        payload.seed = seed;
      if (capabilities.supportsNegativePrompt && input.negativePrompt)
        payload.negative_prompt = input.negativePrompt;
      if (references.length) {
        const form = new FormData();
        for (const [key, value] of Object.entries(payload))
          form.set(key, String(value));
        for (const ref of references)
          form.append(
            references.length > 1 ? "image[]" : "image",
            new Blob([new Uint8Array(ref.bytes)], { type: ref.mime }),
            ref.name,
          );
        delete headers["Content-Type"];
        body = form;
      } else body = JSON.stringify(payload);
    }
  }
  return withImageSlot(
    config.provider,
    Math.min(4, Math.max(1, input.options?.concurrency ?? 2)),
    async () => {
      const { response, attempts } = await requestImage(
        url,
        headers,
        body,
        input,
      );
      let bytes: Buffer;
      let usage: Record<string, number> | undefined;
      if (config.provider === "stability") {
        if (!response.headers.get("content-type")?.startsWith("image/"))
          throw Error(`${label} không trả về ảnh hợp lệ.`);
        bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > 40_000_000)
          throw Error(`${label}: kích thước ảnh không hợp lệ.`);
      } else {
        const result = await response.json().catch(() => {
          throw Error(`${label} không trả về JSON hợp lệ.`);
        });
        usage = numericUsage(result.usage);
        if (config.provider === "gemini") {
          // Only final model_output images; never use interim thought images.
          const parts = (result.steps || [])
            .filter((step: { type?: string }) => step.type === "model_output")
            .flatMap(
              (step: {
                content?: {
                  type?: string;
                  data?: string;
                  mime_type?: string;
                }[];
              }) => step.content || [],
            );
          const image = parts.find(
            (part: { type?: string; data?: string; mime_type?: string }) =>
              part.type === "image" &&
              part.mime_type?.startsWith("image/") &&
              part.data,
          );
          bytes = decodeImage(image?.data, label);
        } else if (isExperientialGateway) {
          // OpenAI-compatible image-enabled chat responses may carry image_url
          // in message.images or message.content; text alone is never a result.
          const message = result.choices?.[0]?.message;
          const parts = [
            ...(Array.isArray(message?.images) ? message.images : []),
            ...(Array.isArray(message?.content) ? message.content : []),
          ];
          const source = parts
            .map(
              (part: {
                image_url?: string | { url?: string };
                url?: string;
                data?: string;
                mime_type?: string;
              } | null) =>
                typeof part?.image_url === "string"
                  ? part.image_url
                  : part?.image_url?.url ||
                    part?.url ||
                    (part?.data && part.mime_type?.startsWith("image/")
                      ? `data:${part.mime_type};base64,${part.data}`
                      : undefined),
            )
            .find((item: string | undefined) => !!item);
          if (!source)
            throw new ImagePipelineError(
              "IMAGE_API_FAILED",
              "Experiential trả về nội dung nhưng không có ảnh. Gateway hoặc model có thể chưa hỗ trợ xuất ảnh qua Chat Completions; hãy kiểm tra model bằng một request thử trước khi chạy hàng loạt.",
            );
          if (source.startsWith("data:")) {
            const match =
              /^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
                source,
              );
            bytes = decodeImage(match?.[1], label);
          } else bytes = await downloadImage(source, config.baseURL);
        } else
          bytes = result.data?.[0]?.url
            ? await downloadImage(result.data[0].url, config.baseURL)
            : decodeImage(result.data?.[0]?.b64_json, label);
      }
      return {
        bytes,
        engine: config.provider,
        model: config.model,
        metadata: {
          requestId: response.headers.get("x-request-id") || undefined,
          attempts,
          usage,
        },
      };
    },
  );
}
