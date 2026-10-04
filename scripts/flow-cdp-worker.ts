import http from "node:http";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";

const HOST = "127.0.0.1";
const BRIDGE_URL = process.env.FLOW_BRIDGE_URL || "http://127.0.0.1:7865";
const PORT = Number(new URL(BRIDGE_URL).port || 7865);
const CDP_URL = process.env.FLOW_CDP_URL || "http://127.0.0.1:9222";
const PROJECT_URL = process.env.FLOW_PROJECT_URL || "https://flow.google.com/";
const MODEL = process.env.FLOW_MODEL_LABEL || "Nano Banana Pro";
const GENERATION_TIMEOUT = Number(process.env.FLOW_GENERATION_TIMEOUT_MS || 420000);
const FLOW_PROTOCOL = 4;

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let flowPage: Page | undefined;
let connectTarget = CDP_URL;
let generationQueue: Promise<void> = Promise.resolve();

function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(payload.length),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function isFlowURL(value?: string) {
  try {
    return new URL(value || "").hostname === "flow.google.com";
  } catch {
    return false;
  }
}

async function disconnect() {
  flowPage = undefined;
  context = undefined;
  if (browser) {
    try {
      await browser.close();
    } catch {}
  }
  browser = undefined;
}

async function connectToChrome(target = CDP_URL) {
  if (browser?.isConnected() && context) return;

  await disconnect();
  connectTarget = target || CDP_URL;

  try {
    browser = await chromium.connectOverCDP(connectTarget, {
      timeout: 15000,
    });
  } catch (error) {
    throw Error(
      "Không kết nối được Chrome đang mở qua DevTools tại " +
        connectTarget +
        ". Hãy bật Remote Debugging cho đúng Chrome đang đăng nhập Flow Plus rồi thử lại. " +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  context = browser.contexts()[0];
  if (!context) {
    await disconnect();
    throw Error("Chrome đã kết nối nhưng không tìm thấy browser context đang hoạt động.");
  }

  flowPage = context.pages().find((page) => isFlowURL(page.url()));
}

async function ensureFlowPage(projectUrl = PROJECT_URL) {
  await connectToChrome(connectTarget);
  if (!context) throw Error("Chrome context chưa sẵn sàng.");

  if (!flowPage || flowPage.isClosed() || !isFlowURL(flowPage.url())) {
    flowPage = context.pages().find((page) => isFlowURL(page.url()));
  }

  if (!flowPage) {
    flowPage = await context.newPage();
    await flowPage.goto(projectUrl || PROJECT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
  }

  if (
    projectUrl &&
    isFlowURL(projectUrl) &&
    flowPage.url() !== projectUrl &&
    !flowPage.url().startsWith(projectUrl)
  ) {
    await flowPage.goto(projectUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
  }

  try {
    await flowPage.bringToFront();
  } catch {}

  return flowPage;
}

async function health() {
  const connected = !!browser?.isConnected() && !!context;
  let currentUrl = "";
  let title = "";
  let pages = 0;
  if (connected && context) {
    pages = context.pages().length;
    const candidate =
      (flowPage && !flowPage.isClosed() ? flowPage : undefined) ||
      context.pages().find((page) => isFlowURL(page.url()));
    if (candidate) {
      currentUrl = candidate.url();
      title = await candidate.title().catch(() => "");
      flowPage = candidate;
    }
  }

  return {
    status: "ok" as const,
    engine: "flow" as const,
    protocol: FLOW_PROTOCOL,
    bridgeReady: true,
    browserOpen: connected,
    connected: connected && !!flowPage && isFlowURL(currentUrl),
    projectConfigured: !!process.env.FLOW_PROJECT_URL,
    currentUrl: currentUrl || undefined,
    title: title || undefined,
    model: MODEL,
    cdpUrl: connectTarget,
    pages,
    message: connected
      ? flowPage
        ? "Đã kết nối trực tiếp Chrome đang mở và tìm thấy tab Google Flow."
        : "Đã kết nối Chrome đang mở nhưng chưa có tab Google Flow."
      : "Flow Worker sẵn sàng. Bấm Kết nối Flow để gắn vào Chrome đang mở.",
  };
}

async function visiblePromptBox(page: Page) {
  const selectors = [
    'textarea[placeholder*="Bạn muốn tạo"]',
    'textarea[placeholder*="What do you want"]',
    '[contenteditable="true"][role="textbox"]',
    "textarea",
    '[contenteditable="true"]',
  ];
  for (const selector of selectors) {
    const items = page.locator(selector);
    const count = await items.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index--) {
      const item = items.nth(index);
      if (
        (await item.isVisible().catch(() => false)) &&
        (await item.isEnabled().catch(() => false))
      )
        return item;
    }
  }
  throw Error(
    "Không tìm thấy ô nhập prompt trên Flow. Hãy mở đúng project Flow rồi thử lại.",
  );
}

async function largeImageSources(page: Page) {
  return page.evaluate(() =>
    Array.from(document.images)
      .filter(
        (img) =>
          img.complete &&
          img.naturalWidth >= 512 &&
          img.naturalHeight >= 512 &&
          !!(img.currentSrc || img.src),
      )
      .map((img) => img.currentSrc || img.src),
  );
}

async function trySetAspect(page: Page, aspect: "16:9" | "9:16") {
  const exact = page.getByText(aspect, { exact: true });
  const count = await exact.count().catch(() => 0);
  for (let index = count - 1; index >= 0; index--) {
    const item = exact.nth(index);
    if (await item.isVisible().catch(() => false)) {
      await item.click({ timeout: 1500 }).catch(() => {});
      return;
    }
  }
}

async function submitPrompt(
  page: Page,
  prompt: string,
  aspect: "16:9" | "9:16",
) {
  const box = await visiblePromptBox(page);
  await box.click();
  await box.fill(prompt).catch(async () => {
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(prompt, { delay: 2 });
  });
  await trySetAspect(page, aspect);

  const labels = [/^Tạo$/i, /^Generate$/i, /^Gửi$/i, /^Send$/i];
  for (const name of labels) {
    const buttons = page.getByRole("button", { name });
    const count = await buttons.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index--) {
      const button = buttons.nth(index);
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

async function pageWarning(page: Page) {
  const body = await page.locator("body").innerText().catch(() => "");
  const value = body.toLowerCase();
  for (const phrase of [
    "hết tín dụng",
    "tín dụng google flow",
    "too many requests",
    "rate limit",
    "try again later",
    "thử lại sau",
  ])
    if (value.includes(phrase)) return phrase;
  return "";
}

async function waitForNewImage(page: Page, before: string[]) {
  const known = new Set(before);
  const deadline = Date.now() + GENERATION_TIMEOUT;

  while (Date.now() < deadline) {
    if (!browser?.isConnected())
      throw Error("Chrome đã ngắt kết nối khỏi StoryFlow.");

    const current = await largeImageSources(page).catch(() => []);
    const fresh = current.filter((src) => !known.has(src));
    if (fresh.length) return fresh[fresh.length - 1];

    const warning = await pageWarning(page);
    if (warning)
      throw Error("Google Flow đang báo giới hạn/tín dụng: " + warning);

    await page.waitForTimeout(1500);
  }

  throw Error(
    "Flow chưa trả ảnh trong thời gian chờ. Hãy kiểm tra tab Flow rồi chạy lại riêng cảnh này.",
  );
}

async function imageBytes(page: Page, src: string) {
  if (!context) throw Error("Chrome context chưa sẵn sàng.");

  if (!src.startsWith("blob:") && !src.startsWith("data:")) {
    const response = await context.request
      .get(src, { timeout: 120000 })
      .catch(() => null);
    if (response?.ok()) {
      const bytes = Buffer.from(await response.body());
      if (bytes.length > 10000) return bytes;
    }
  }

  const dataUrl = await page.evaluate(async (url) => {
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
  if (comma < 0) throw Error("Không đọc được dữ liệu ảnh từ Flow.");
  return Buffer.from(dataUrl.slice(comma + 1), "base64");
}

async function generate(payload: {
  prompt?: string;
  aspect?: "16:9" | "9:16";
  projectUrl?: string;
  cdpUrl?: string;
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
    if (payload.cdpUrl && payload.cdpUrl !== connectTarget) {
      await disconnect();
      connectTarget = payload.cdpUrl;
    }
    const page = await ensureFlowPage(payload.projectUrl || PROJECT_URL);
    const before = await largeImageSources(page);
    await submitPrompt(page, prompt, payload.aspect || "16:9");
    const src = await waitForNewImage(page, before);
    const bytes = await imageBytes(page, src);
    if (bytes.length < 10000) throw Error("Ảnh Flow tải về không hợp lệ.");
    return bytes;
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
      const payload = await readBody(req);
      const target =
        typeof payload.cdpUrl === "string" && payload.cdpUrl
          ? payload.cdpUrl
          : CDP_URL;
      await connectToChrome(target);
      await ensureFlowPage(
        typeof payload.projectUrl === "string" && payload.projectUrl
          ? payload.projectUrl
          : PROJECT_URL,
      );
      return json(res, 200, await health());
    }

    if (req.method === "POST" && url.pathname === "/disconnect") {
      await disconnect();
      return json(res, 200, await health());
    }

    if (req.method === "POST" && url.pathname === "/generate") {
      const payload = await readBody(req);
      const bytes = await generate(payload);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": String(bytes.length),
        "Cache-Control": "no-store",
        "X-StoryFlow-Model": MODEL,
      });
      return res.end(bytes);
    }

    return json(res, 404, { error: "Không tìm thấy Flow Worker endpoint." });
  } catch (error) {
    return json(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`StoryFlow Flow CDP Worker: http://${HOST}:${PORT}`);
  console.log(`Chrome DevTools target mặc định: ${CDP_URL}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await disconnect();
    server.close(() => process.exit(0));
  });
