import http from "node:http";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "@playwright/test";

const HOST = "127.0.0.1";
const PORT = Number(new URL(process.env.FLOW_BRIDGE_URL || "http://127.0.0.1:7865").port || 7865);
const PROFILE_DIR = path.resolve(process.env.FLOW_PROFILE_DIR || "data/flow-profile");
const DIAG_DIR = path.resolve("data/flow-diagnostics");
const DEFAULT_URL = process.env.FLOW_PROJECT_URL || "https://flow.google.com/";
const MODEL = process.env.FLOW_MODEL_LABEL || "Nano Banana Pro";
const GENERATION_TIMEOUT = Number(process.env.FLOW_GENERATION_TIMEOUT_MS || 420000);

let context: BrowserContext | undefined;
let page: Page | undefined;
let generationQueue: Promise<void> = Promise.resolve();

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function body(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function isFlowUrl(value?: string) {
  try {
    return new URL(value || "").hostname === "flow.google.com";
  } catch {
    return false;
  }
}

async function ensureBrowser(targetUrl = DEFAULT_URL) {
  await mkdir(PROFILE_DIR, { recursive: true });
  await mkdir(DIAG_DIR, { recursive: true });

  if (!context) {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chrome",
      headless: false,
      viewport: null,
      acceptDownloads: true,
      args: ["--start-maximized"],
    });
    context.on("close", () => {
      context = undefined;
      page = undefined;
    });
  }

  if (!page || page.isClosed()) {
    page = context.pages()[0] || (await context.newPage());
  }

  const wanted = targetUrl && isFlowUrl(targetUrl) ? targetUrl : DEFAULT_URL;
  if (!isFlowUrl(page.url()) && !page.url().startsWith("https://accounts.google.com/")) {
    await page.goto(wanted, { waitUntil: "domcontentloaded", timeout: 120000 });
  } else if (
    isFlowUrl(wanted) &&
    wanted !== "https://flow.google.com/" &&
    !page.url().startsWith(wanted)
  ) {
    await page.goto(wanted, { waitUntil: "domcontentloaded", timeout: 120000 });
  }

  return page;
}

async function health() {
  const current = page && !page.isClosed() ? page : undefined;
  const currentUrl = current?.url() || "";
  const title = current ? await current.title().catch(() => "") : "";
  const browserOpen = !!current;
  const connected =
    browserOpen &&
    isFlowUrl(currentUrl) &&
    !currentUrl.includes("/signin") &&
    !currentUrl.includes("accounts.google.com");

  return {
    status: "ok" as const,
    engine: "flow" as const,
    bridgeReady: true,
    browserOpen,
    connected,
    projectConfigured: !!process.env.FLOW_PROJECT_URL,
    currentUrl: currentUrl || undefined,
    title: title || undefined,
    model: MODEL,
    message: !browserOpen
      ? "Flow Bridge sẵn sàng. Hãy mở Flow và đăng nhập một lần."
      : connected
        ? "Đã kết nối Google Flow bằng hồ sơ Chrome cục bộ."
        : "Trình duyệt Flow đang mở nhưng cần bạn đăng nhập hoặc mở project.",
  };
}

async function diagnostic(p: Page, label: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await p
    .screenshot({
      path: path.join(DIAG_DIR, `${stamp}-${label}.png`),
      fullPage: true,
    })
    .catch(() => {});
  await writeFile(
    path.join(DIAG_DIR, `${stamp}-${label}.html`),
    await p.content().catch(() => ""),
    "utf8",
  ).catch(() => {});
}

async function promptBox(p: Page) {
  const selectors = [
    'textarea[placeholder*="Bạn muốn tạo"]',
    'textarea[placeholder*="What do you want"]',
    '[contenteditable="true"][role="textbox"]',
    'textarea',
    '[contenteditable="true"]',
  ];
  for (const selector of selectors) {
    const locators = p.locator(selector);
    const count = await locators.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i--) {
      const candidate = locators.nth(i);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  throw Error(
    "Không tìm thấy ô nhập prompt của Google Flow. Hãy mở đúng project Flow và thử lại.",
  );
}

async function largeImageSources(p: Page) {
  return p.evaluate(() =>
    Array.from(document.images)
      .filter(
        (img) =>
          img.complete &&
          img.naturalWidth >= 512 &&
          img.naturalHeight >= 512 &&
          !!img.src,
      )
      .map((img) => img.src),
  );
}

async function trySetAspect(p: Page, aspect: string) {
  const exact = p.getByText(aspect, { exact: true });
  const count = await exact.count().catch(() => 0);
  for (let i = count - 1; i >= 0; i--) {
    const item = exact.nth(i);
    if (await item.isVisible().catch(() => false)) {
      await item.click({ timeout: 1500 }).catch(() => {});
      return;
    }
  }
}

async function submitPrompt(
  p: Page,
  prompt: string,
  aspect: "16:9" | "9:16",
) {
  const box = await promptBox(p);
  await box.click();
  await box.fill(prompt);
  await trySetAspect(p, aspect);

  const buttons = [
    /gửi/i,
    /send/i,
    /tạo/i,
    /generate/i,
  ];
  for (const name of buttons) {
    const candidate = p.getByRole("button", { name });
    const count = await candidate.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i--) {
      const button = candidate.nth(i);
      if (
        (await button.isVisible().catch(() => false)) &&
        (await button.isEnabled().catch(() => false))
      ) {
        await button.click();
        return;
      }
    }
  }

  await box.press("Enter");
}

async function waitForNewImage(p: Page, before: string[]) {
  const deadline = Date.now() + GENERATION_TIMEOUT;
  const known = new Set(before);
  while (Date.now() < deadline) {
    if (p.url().startsWith("https://accounts.google.com/"))
      throw Error("Google Flow yêu cầu đăng nhập lại. Hãy đăng nhập trong cửa sổ Flow.");
    const current = await largeImageSources(p).catch(() => []);
    const fresh = current.filter((src) => !known.has(src));
    if (fresh.length) return fresh[fresh.length - 1];
    await p.waitForTimeout(2000);
  }
  throw Error(
    "Google Flow chưa trả ảnh trong thời gian chờ. Có thể Flow đang hết tín dụng, giới hạn tốc độ hoặc cần thao tác thủ công.",
  );
}

async function fetchVisibleImage(p: Page, src: string) {
  if (!context) throw Error("Flow browser chưa sẵn sàng.");
  if (!src.startsWith("blob:")) {
    const response = await context.request.get(src, { timeout: 120000 }).catch(() => null);
    if (response?.ok()) return Buffer.from(await response.body());
  }

  const dataUrl = await p.evaluate(async (url) => {
    const response = await fetch(url);
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });
  }, src);
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw Error("Không đọc được ảnh hiển thị trong Flow.");
  return Buffer.from(dataUrl.slice(comma + 1), "base64");
}

async function generate(payload: {
  prompt?: string;
  aspect?: "16:9" | "9:16";
  projectUrl?: string;
}) {
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) throw Error("Prompt Flow đang trống.");

  let release!: () => void;
  const previous = generationQueue;
  generationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});

  try {
    const p = await ensureBrowser(payload.projectUrl || DEFAULT_URL);
    if (p.url().startsWith("https://accounts.google.com/"))
      throw Error(
        "Flow cần đăng nhập. Hãy đăng nhập thủ công trong cửa sổ Chrome StoryFlow rồi chạy lại.",
      );
    if (!isFlowUrl(p.url()))
      throw Error("Hãy mở một project Google Flow trong cửa sổ StoryFlow.");

    const before = await largeImageSources(p);
    await submitPrompt(p, prompt, payload.aspect || "16:9");
    const src = await waitForNewImage(p, before);
    const bytes = await fetchVisibleImage(p, src);
    if (!bytes.length) throw Error("Ảnh Flow tải về rỗng.");
    return bytes;
  } catch (error) {
    if (page && !page.isClosed()) await diagnostic(page, "generate-error");
    throw error;
  } finally {
    release();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, await health());
    }
    if (req.method === "POST" && url.pathname === "/open") {
      const payload = await body(req);
      await ensureBrowser(String(payload.projectUrl || DEFAULT_URL));
      return json(res, 200, await health());
    }
    if (req.method === "POST" && url.pathname === "/generate") {
      const payload = await body(req);
      const bytes = await generate(payload);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": String(bytes.length),
        "Cache-Control": "no-store",
        "X-StoryFlow-Model": MODEL,
      });
      return res.end(bytes);
    }
    return json(res, 404, { error: "Không tìm thấy Flow Bridge endpoint." });
  } catch (error) {
    return json(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`StoryFlow Flow Bridge: http://${HOST}:${PORT}`);
  console.log("Đăng nhập Flow chỉ bằng cửa sổ Chrome riêng; StoryFlow không đọc mật khẩu/cookie.");
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await context?.close().catch(() => {});
    server.close(() => process.exit(0));
  });
