import { z } from "zod";

type ModalKind = "tts" | "image";

function configured(kind: ModalKind) {
  const url =
    kind === "tts" ? process.env.MODAL_TTS_URL : process.env.MODAL_IMAGE_URL;
  return !!url?.trim();
}

export function modalConfigured(kind: ModalKind) {
  return configured(kind);
}

export function modalURL(kind: ModalKind, pathname: string) {
  const raw =
    kind === "tts" ? process.env.MODAL_TTS_URL : process.env.MODAL_IMAGE_URL;
  if (!raw) throw Error(
    kind === "tts"
      ? "Chưa cấu hình VieNeu Cloud. Thiết lập MODAL_TTS_URL trước."
      : "Chưa cấu hình Story AI Cloud. Thiết lập MODAL_IMAGE_URL trước.",
  );
  const base = new URL(raw);
  if (base.protocol !== "https:" && base.protocol !== "http:")
    throw Error("Endpoint Modal phải dùng HTTP hoặc HTTPS.");
  const path = pathname.startsWith("/") ? pathname : "/" + pathname;
  return new URL(path, base.href.endsWith("/") ? base.href : base.href + "/");
}

function headers(json = false) {
  const out: Record<string, string> = {};
  if (json) out["Content-Type"] = "application/json";
  const token = process.env.MODAL_AUTH_TOKEN || process.env.STORYFLOW_MODAL_TOKEN;
  if (token) out.Authorization = "Bearer " + token;
  return out;
}

export async function modalFetch(
  kind: ModalKind,
  pathname: string,
  init: RequestInit = {},
  timeout = 1_800_000,
) {
  const h = new Headers(headers(!!init.body));
  new Headers(init.headers).forEach((v, k) => h.set(k, v));
  const response = await fetch(modalURL(kind, pathname), {
    ...init,
    headers: h,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 2000);
    throw Error(
      `${kind === "tts" ? "VieNeu Cloud" : "Story AI Cloud"} xử lý thất bại (${response.status}). ${body}`,
    );
  }
  return response;
}

const healthSchema = z.object({
  status: z.string(),
  ready: z.boolean().optional(),
  model: z.string().optional(),
  backend: z.string().optional(),
});

export async function modalHealth(kind: ModalKind) {
  if (!configured(kind))
    return { ready: false, message: "Chưa cấu hình endpoint Modal" };
  try {
    const response = await modalFetch(kind, "/health", {}, 5000);
    const data = healthSchema.parse(await response.json());
    const ready = data.ready ?? data.status === "ok";
    return {
      ready,
      message: ready
        ? `Sẵn sàng${data.model ? " · " + data.model : ""}`
        : "Service chưa sẵn sàng",
    };
  } catch (error) {
    return {
      ready: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
