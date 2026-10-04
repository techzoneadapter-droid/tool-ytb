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
    const message = type.includes("application/json")
      ? (await response.json().catch(() => null))?.error
      : await response.text().catch(() => "");
    throw Error(message || `Flow Worker lỗi HTTP ${response.status}.`);
  }
  if (type.includes("application/json")) return response.json() as Promise<T>;
  return (await response.arrayBuffer()) as T;
}

export type FlowHealth = {
  status: "ok";
  engine: "flow";
  bridgeReady: boolean;
  browserOpen: boolean;
  connected: boolean;
  projectConfigured: boolean;
  currentUrl?: string;
  title?: string;
  model?: string;
  cdpUrl?: string;
  pages?: number;
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
      cdpUrl: process.env.FLOW_CDP_URL || "http://127.0.0.1:9222",
      message:
        "Flow Worker chưa chạy. Bấm Kết nối Flow để gắn vào Chrome đang mở.",
    };
  }
}

export async function openFlowBrowser() {
  return call<FlowHealth>(
    "/open",
    {
      method: "POST",
      body: JSON.stringify({
        projectUrl: process.env.FLOW_PROJECT_URL || "",
        cdpUrl: process.env.FLOW_CDP_URL || "http://127.0.0.1:9222",
      }),
    },
    30000,
  );
}

export async function generateWithFlow(
  prompt: string,
  aspect: "16:9" | "9:16",
) {
  const response = await fetch(new URL("/generate", bridgeURL()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      aspect,
      projectUrl: process.env.FLOW_PROJECT_URL || "",
      model: process.env.FLOW_MODEL_LABEL || "Nano Banana Pro",
      cdpUrl: process.env.FLOW_CDP_URL || "http://127.0.0.1:9222",
    }),
    signal: AbortSignal.timeout(
      Number(process.env.FLOW_GENERATION_TIMEOUT_MS || 420000) + 30000,
    ),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw Error(
      body?.error ||
        `Google Flow không tạo được ảnh (HTTP ${response.status}).`,
    );
  }
  const mime = response.headers.get("content-type") || "image/png";
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
}
