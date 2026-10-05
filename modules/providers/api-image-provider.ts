import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  validateImageBaseURL,
  type ImageAPIOptions,
} from "./image-api-options";

export class ImagePipelineError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}
export function imageCapabilities(
  provider: string,
  model: string,
  options: ImageAPIOptions = {},
) {
  const nativeReference =
    (provider === "gemini" && /^gemini-.*image/.test(model)) ||
    (provider === "openai" && /^(gpt-image-|chatgpt-image-)/.test(model));
  return {
    supportsReferenceImages:
      provider === "api-compatible"
        ? options.supportsReferenceImages === true
        : nativeReference || (provider === "stability" && model === "ultra"),
    supportsMultiImageInput:
      provider === "api-compatible"
        ? options.supportsMultiImageInput === true
        : nativeReference,
    supportsSeed:
      provider === "api-compatible"
        ? options.supportsSeed === true
        : provider === "stability",
    supportsNegativePrompt:
      provider === "api-compatible"
        ? options.supportsNegativePrompt === true
        : provider === "stability",
  };
}
export type APIImageInput = {
  options?: ImageAPIOptions;
  negativePrompt?: string;
  references?: { bytes: Buffer; mime: string; name: string }[];
  requestId?: string;
  onRetry?: (attempt: number, status?: number) => void;
};
export type APIImageResult = {
  bytes: Buffer;
  engine: string;
  model: string;
  metadata: {
    requestId?: string;
    attempts: number;
    usage?: Record<string, number>;
  };
};
const active = new Map<string, number>();
const queues = new Map<string, (() => void)[]>();
export async function withImageSlot<T>(
  provider: string,
  limit: number,
  action: () => Promise<T>,
): Promise<T> {
  // A single shared gate also bounds parallel chapter jobs in this worker.
  while ((active.get(provider) || 0) >= limit)
    await new Promise<void>((resolve) => {
      const queue = queues.get(provider) || [];
      queue.push(resolve);
      queues.set(provider, queue);
    });
  active.set(provider, (active.get(provider) || 0) + 1);
  try {
    return await action();
  } finally {
    active.set(provider, (active.get(provider) || 1) - 1);
    queues.get(provider)?.shift()?.();
  }
}
export async function requestImage(
  url: string,
  headers: Record<string, string>,
  body: BodyInit,
  input: APIImageInput,
) {
  const retries = Math.min(5, Math.max(0, input.options?.retries ?? 0));
  const timeout =
    Math.min(600, Math.max(10, input.options?.timeoutSeconds ?? 240)) * 1000;
  const requestId = input.requestId || randomUUID();
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { ...headers, "X-Client-Request-Id": requestId },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      /* Never echo upstream transport messages containing credential URLs. */
    }
    if (response?.ok) return { response, attempts: attempt + 1 };
    const status = response?.status;
    const retryable =
      !response || status === 429 || (status !== undefined && status >= 500);
    if (!retryable || attempt >= retries) {
      throw new ImagePipelineError(
        "IMAGE_API_FAILED",
        response
          ? `API tạo ảnh thất bại (HTTP ${status}). ${status === 401 || status === 403 ? "Kiểm tra API key và quyền model." : status === 429 || status === 402 ? "Kiểm tra hạn mức/số dư hoặc giới hạn tốc độ." : "Kiểm tra model, prompt và trạng thái nhà cung cấp."}`
          : "API tạo ảnh mất kết nối hoặc quá thời gian chờ.",
        status,
      );
    }
    await response?.body?.cancel().catch(() => {});
    input.onRetry?.(attempt + 1, status);
    const retryAfter = Number(response?.headers.get("retry-after"));
    await delay(
      Math.min(
        30000,
        Math.max(
          1000 * 2 ** attempt,
          Number.isFinite(retryAfter) ? retryAfter * 1000 : 0,
        ),
      ),
    );
  }
}
export async function downloadImage(url: string, baseURL?: string) {
  try {
    const asset = new URL(url);
    validateImageBaseURL(asset.origin);
    if (asset.username || asset.password) throw Error("credentials");
    if (
      asset.protocol !== "https:" &&
      asset.origin !== new URL(baseURL || "https://api.openai.com").origin
    )
      throw Error("origin");
    const response = await fetch(asset.href, {
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.startsWith("image/")
    )
      throw Error("invalid image");
    const reader = response.body?.getReader();
    if (!reader) throw Error("empty");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > 40000000) throw Error("too large");
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!size) throw Error("empty");
    return Buffer.concat(chunks);
  } catch {
    throw new ImagePipelineError(
      "IMAGE_DOWNLOAD_FAILED",
      "Không tải được ảnh API về bộ nhớ nội bộ (URL, định dạng hoặc thời gian chờ không hợp lệ).",
    );
  }
}
export function numericUsage(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const safe = Object.fromEntries(
    Object.entries(value).filter(
      ([key, item]) =>
        /^[a-z_]{1,50}$/i.test(key) &&
        typeof item === "number" &&
        Number.isFinite(item) &&
        item >= 0,
    ),
  );
  return Object.keys(safe).length
    ? (safe as Record<string, number>)
    : undefined;
}
