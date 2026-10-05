import { startService, flowTimeout } from "./services";
import { randomUUID } from "node:crypto";

function bridgeURL() {
  const raw = process.env.FLOW_BRIDGE_URL || "http://127.0.0.1:7865";
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("Flow Worker phải chạy bằng HTTP trên máy cục bộ.");
  return url;
}

export function flowFailure(
  body: {
    error?: string;
    code?: string;
    stage?: string;
    diagnostics?: Record<string, unknown>;
  } | null,
  fallback: string,
) {
  const label = [body?.code, body?.stage]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(" | ");
  const artifacts = body?.diagnostics
    ? "\nDiagnostic: " + JSON.stringify(body.diagnostics)
    : "";
  return Object.assign(
    new Error(
      (label ? `[${label}] ` : "") + (body?.error || fallback) + artifacts,
    ),
    {
      code: body?.code || "FLOW_REQUEST_FAILED",
      stage: body?.stage || body?.code || "FLOW_GENERATE",
    },
  );
}

async function call<T>(
  path: string,
  init: RequestInit = {},
  timeout = 5000,
): Promise<T> {
  const url = new URL(path, bridgeURL());
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(timeout),
    cache: "no-store",
  });
  const type = response.headers.get("content-type") || "";
  if (!response.ok) {
    const body = type.includes("application/json")
      ? await response.json().catch(() => null)
      : { error: await response.text().catch(() => "") };
    throw flowFailure(body, `Flow Worker lỗi HTTP ${response.status}.`);
  }
  if (type.includes("application/json")) return response.json() as Promise<T>;
  return (await response.arrayBuffer()) as T;
}

export type FlowHealth = {
  status: "ok";
  protocol?: number;
  engine: "flow";
  bridgeReady: boolean;
  browserOpen: boolean;
  connected: boolean;
  sessionReady?: boolean;
  composerReady?: boolean;
  generationReady?: boolean;
  lastStage?: string;
  currentRequestId?: string;
  state?:
    | "disconnected"
    | "connecting"
    | "starting"
    | "restoring"
    | "login_required"
    | "project_required"
    | "ready"
    | "generating"
    | "error";
  background?: boolean;
  projectConfigured: boolean;
  currentUrl?: string;
  title?: string;
  model?: string;
  connectionMode?: string;
  lastError?: string;
  lastErrorCode?: string;
  backgroundRestore?: boolean;
  message: string;
};

export async function flowHealth(): Promise<FlowHealth> {
  try {
    return await call<FlowHealth>("/health", {}, 400);
  } catch (error) {
    return {
      status: "ok",
      engine: "flow",
      bridgeReady: false,
      browserOpen: false,
      connected: false,
      projectConfigured: !!process.env.FLOW_PROJECT_URL,
      model: process.env.FLOW_MODEL_LABEL || "Nano Banana Pro",
      message:
        "Dán JSON Cookie EditThisCookie và URL dự án để kết nối Flow chạy ẩn.",
    };
  }
}

export async function initializeFlowSession(
  cookieJson: string,
  projectUrl: string,
) {
  return call<FlowHealth>(
    "/session",
    { method: "POST", body: JSON.stringify({ cookieJson, projectUrl }) },
    160000,
  );
}

export async function waitForFlowSession(onStage?: (stage: string) => void): Promise<FlowHealth> {
  const deadline = Date.now() + flowTimeout("FLOW_RESTORE_TIMEOUT_MS", 180000);
  let lastStage = "";
  while (Date.now() < deadline) {
    const health = await flowHealth();
    if (health.generationReady) { onStage?.("FLOW_READY"); return health; }
    if (["login_required", "project_required", "error", "disconnected"].includes(health.state || "") || (health.state === "ready" && !health.generationReady)) {
      const code = health.lastErrorCode || health.lastError?.match(/^\[([^\]]+)\]/)?.[1] ||
        (health.state === "login_required" || health.state === "disconnected" ? "FLOW_LOGIN_REQUIRED" : health.state === "project_required" ? "FLOW_PROJECT_INVALID" : health.state === "ready" ? "FLOW_COMPOSER_NOT_FOUND" : "FLOW_SESSION_RESTORE_FAILED");
      throw flowFailure({ code, stage: health.lastStage || "FLOW_SESSION_RESTORE", error: health.lastError || health.message }, "");
    }
    const stage = health.lastStage || "FLOW_SESSION_RESTORE";
    if (stage !== lastStage) { onStage?.(stage); lastStage = stage; }
    await new Promise(r => setTimeout(r, 200));
  }
  throw flowFailure({ code: "FLOW_SESSION_RESTORE_FAILED", stage: "FLOW_SESSION_RESTORE", error: "Hết thời gian chờ khôi phục phiên Flow." }, "");
}

export async function generateWithFlow(
  prompt: string,
  aspect: "16:9" | "9:16",
  onStage?: (stage: string) => void,
) {
  onStage?.("FLOW_SERVICE_START");
  try {
    await startService("flow");
  } catch (error) {
    if (error instanceof Error && "code" in error && "stage" in error) throw error;
    throw flowFailure(
      {
        code: "FLOW_SERVICE_START_FAILED",
        stage: "FLOW_SERVICE_START",
        error: error instanceof Error ? error.message : String(error),
      },
      "",
    );
  }
  await waitForFlowSession(onStage);
  const requestId = randomUUID();
  const progressController = new AbortController();
  let progressError: unknown;
  let active = true;
  let polling = false;
  const timer = onStage
    ? setInterval(() => {
        if (polling) return;
        polling = true;
        void flowHealth()
          .then((health) => {
            if (
              active &&
              health.currentRequestId === requestId &&
              health.lastStage
            )
              try {
                onStage(health.lastStage);
              } catch (error) {
                progressError = error;
                progressController.abort();
              }
          })
          .finally(() => {
            polling = false;
          });
      }, 1000)
    : undefined;
  try {
    const response = await fetch(new URL("/generate", bridgeURL()), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        requestId,
        aspect,
        projectUrl: process.env.FLOW_PROJECT_URL || "",
        model: process.env.FLOW_MODEL_LABEL || "Nano Banana Pro",
      }),
      signal: AbortSignal.any([
        progressController.signal,
        AbortSignal.timeout(
          // Up to four video jobs can share one serialized Flow session.
          (Number(process.env.FLOW_GENERATION_TIMEOUT_MS || 420000) + 60000) *
            4,
        ),
      ]),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw flowFailure(
        body,
        `Google Flow không tạo được ảnh (HTTP ${response.status}).`,
      );
    }
    const mime = response.headers.get("content-type") || "image/png";
    if (
      !mime.startsWith("image/") &&
      !mime.startsWith("application/octet-stream")
    )
      throw flowFailure(
        {
          code: "FLOW_RESULT_DOWNLOAD_FAILED",
          stage: "FLOW_RESULT_DOWNLOAD",
          error: "Flow không trả binary ảnh.",
        },
        "",
      );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw Error("Google Flow không trả ảnh về StoryFlow.");
    return {
      bytes,
      model:
        response.headers.get("x-storyflow-model") ||
        process.env.FLOW_MODEL_LABEL ||
        "Nano Banana Pro",
      mime,
    };
  } catch (error) {
    if (progressError)
      throw Object.assign(
        progressError instanceof Error
          ? progressError
          : new Error(String(progressError)),
        { code: "SCENE_CHECKPOINT_FAILED", stage: "SCENE_PROGRESS" },
      );
    if (error instanceof Error && "code" in error) throw error;
    throw flowFailure(
      {
        code: "FLOW_RESULT_DOWNLOAD_FAILED",
        stage: "FLOW_HTTP",
        error: error instanceof Error ? error.message : String(error),
      },
      "",
    );
  } finally {
    active = false;
    if (timer) clearInterval(timer);
  }
}
