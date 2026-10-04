import dotenv from "dotenv";
const localEnvironment = dotenv.config({ path: ".env.local", quiet: true });
// Next's parent process may retain an old URL after editing .env.local.
if (localEnvironment.parsed && Object.hasOwn(localEnvironment.parsed, "FLOW_CDP_URL"))
  process.env.FLOW_CDP_URL = localEnvironment.parsed.FLOW_CDP_URL;
dotenv.config({ quiet: true });
import http from "node:http";
import { type Browser, type BrowserContext, type Page } from "playwright";
import { FLOW_PROTOCOL } from "../modules/providers/services";
import { generationScript } from "../modules/providers/flow-generation";
import { configureFlowImages } from "../modules/providers/flow-controls";
import { attachFlowChrome, flowTabs, isFlowPage, selectFlowTab } from "../modules/providers/flow-session";
import { saveFlowSelection } from "../modules/providers/flow-profiles";

const HOST = "127.0.0.1";
const PORT = Number(
  new URL(process.env.FLOW_BRIDGE_URL || "http://127.0.0.1:7865").port || 7865,
);
const MODEL = process.env.FLOW_MODEL_LABEL || "Nano Banana Pro";
const TIMEOUT = Number(process.env.FLOW_GENERATION_TIMEOUT_MS || 420000);
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
let selectedTab = "";
let selectedProfile = "";
let state:
  | "disconnected"
  | "connecting"
  | "login_required"
  | "ready"
  | "generating"
  | "error" = "disconnected";
let lastError = "";
let queue: Promise<unknown> = Promise.resolve();
let monitoring = false;
let background = false;

function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.catch(() => {});
  return result;
}
function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}
async function body(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Error("Yêu cầu Flow quá lớn.");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
async function closeBrowser() {
  const previous = browser;
  browser = undefined;
  context = undefined;
  page = undefined;
  background = false;
  // CDP browser.close disconnects the transport; never close the user's context.
  await previous?.close();
}
async function ensureBrowser() {
  if (browser?.isConnected()) return browser;
  state = "connecting";
  const attached = await attachFlowChrome();
  browser = attached;
  attached.on("disconnected", () => {
    if (browser === attached) {
      browser = undefined;
      context = undefined;
      page = undefined;
      state = "disconnected";
    }
  });
  return attached;
}
async function editorReady() {
  if (!page || page.isClosed()) return false;
  if (!isFlowPage(page.url())) return false;
  return page
    .locator(
      'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]',
    )
    .filter({ visible: true })
    .count()
    .then((count) => count > 0);
}
async function prepareEditor() {
  if (!page || page.isClosed()) return false;
  await page
    .locator('textarea, [contenteditable="true"], button')
    .filter({ visible: true })
    .first()
    .waitFor({ state: "visible", timeout: 10000 })
    .catch(() => {});
  if (await editorReady()) return true;
  return editorReady();
}
async function completeConnection() {
  if (!(await prepareEditor())) {
    state = "login_required";
    return;
  }
  state = "ready";
  lastError = "";
  background = true;
}
async function connect(tabId: string) {
  const attached = await ensureBrowser();
  page = await selectFlowTab(attached, tabId);
  context = page.context();
  selectedTab = tabId;
  await completeConnection();
}
async function connectProfile(profileId: string, tabId: string) {
  if (!tabId) throw Error("Đọc danh sách và chọn đúng tab Flow đã mở trong profile của bạn.");
  await closeBrowser();
  selectedTab = "";
  selectedProfile = profileId;
  state = "connecting";
  await connect(tabId);
  await saveFlowSelection(profileId, tabId);
}

function health() {
  if (page?.isClosed()) {
    page = undefined;
    context = undefined;
    state = "disconnected";
    background = false;
  }
  return {
    status: "ok",
    engine: "flow",
    protocol: FLOW_PROTOCOL,
    bridgeReady: true,
    browserOpen: !!context,
    connected: ["ready", "generating"].includes(state),
    state,
    background,
    projectConfigured: !!process.env.FLOW_PROJECT_URL,
    currentUrl: page?.url(),
    model: MODEL,
    connectionMode: "existing-chrome",
    selectedTab,
    selectedProfile,
    lastError: lastError || undefined,
    message:
      state === "login_required"
        ? "Mở dự án Flow trong tab Chrome đã chọn. Ứng dụng sẽ kết nối khi ô tạo ảnh sẵn sàng."
        : state === "ready"
          ? "Đã kết nối tab Flow đã chọn. Tác vụ chạy nền, không mở cửa sổ hoặc đưa tab lên trước."
          : state === "generating"
            ? "Đang tạo ảnh trong tab Flow đã chọn."
            : state === "error"
              ? lastError
              : "Chọn profile Chrome đã đăng nhập Flow rồi bấm Kết nối.",
  };
}
async function generate(payload: { prompt?: string; aspect?: string }) {
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) throw Error("Prompt Flow đang trống.");
  if (payload.aspect && !["16:9", "9:16"].includes(payload.aspect))
    throw Error("Tỷ lệ ảnh Flow không hợp lệ.");
  if (state !== "ready" || !(await editorReady())) {
    if (!selectedTab) throw Error("Hãy chọn tab Flow đang mở trong Chrome trước khi tạo ảnh.");
    await connect(selectedTab);
    if (!(await editorReady())) throw Error("Tab Flow chưa sẵn sàng. Mở dự án trong tab Chrome đã chọn.");
  }
  state = "generating";
  try {
    // Explicitly select image creation, never submit into a video composer.
    await configureFlowImages(
      page!,
      MODEL,
      (payload.aspect || "16:9") as "16:9" | "9:16",
    );
    await page!
      .locator(
        'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]',
      )
      .filter({ visible: true })
      .last()
      .fill(prompt);
    const result = (await page!.evaluate(
      `(${generationScript(prompt, (payload.aspect || "16:9") as "16:9" | "9:16", TIMEOUT)})()`,
    )) as { dataUrl?: string; src?: string; mime?: string };
    if (!result.dataUrl && result.src) {
      const asset = new URL(result.src);
      if (
        asset.protocol !== "https:" ||
        !(
          asset.hostname.endsWith(".googleusercontent.com") ||
          asset.hostname.endsWith(".googleapis.com") ||
          ["labs.google", "flow.google.com"].includes(asset.hostname)
        )
      )
        throw Error(
          "Địa chỉ ảnh Flow không thuộc máy chủ ảnh Google được hỗ trợ.",
        );
      const response = await context!.request.get(asset.href, {
        timeout: 30000,
      });
      if (!response.ok())
        throw Error(`Không tải được ảnh Flow: HTTP ${response.status()}`);
      const mime = response.headers()["content-type"]?.split(";")[0] || "";
      const bytes = await response.body();
      if (!mime.startsWith("image/") || bytes.length < 10000)
        throw Error("Flow không trả ảnh hợp lệ.");
      lastError = "";
      return { bytes, mime };
    }
    const match = result.dataUrl?.match(
      /^data:(image\/[\w.+-]+);base64,(.+)$/s,
    );
    if (!match) throw Error("Flow không trả ảnh hợp lệ.");
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length < 10000)
      throw Error("Ảnh Flow trả về quá nhỏ hoặc không hợp lệ.");
    lastError = "";
    return { bytes, mime: match[1] };
  } finally {
    state = (await editorReady().catch(() => false))
      ? "ready"
      : "login_required";
  }
}
const monitor = setInterval(() => {
  if (!page || state !== "login_required" || monitoring) return;
  monitoring = true;
  void exclusive(completeConnection)
    .catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      state = "error";
    })
    .finally(() => {
      monitoring = false;
    });
}, 2500);
const server = http.createServer(async (req, res) => {
  try {
    // Browser POSTs must come through the same-origin application API.
    if (
      req.headers.origin ||
      (req.headers["sec-fetch-site"] &&
        req.headers["sec-fetch-site"] !== "none")
    )
      return json(res, 403, {
        error: "Chỉ ứng dụng cục bộ được truy cập Flow Worker.",
      });
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health")
      return json(res, 200, health());
    if (req.method === "POST" && url.pathname === "/tabs") {
      const tabs = await exclusive(async () => flowTabs(await ensureBrowser()));
      return json(res, 200, { tabs });
    }
    if (req.method === "POST" && url.pathname === "/open") {
      const payload = await body(req);
      if (typeof payload.profileId !== "string" || !payload.profileId) throw Error("Hãy chọn profile Chrome.");
      await exclusive(() => connectProfile(payload.profileId, String(payload.tabId || "")));
      return json(res, 200, health());
    }
    if (req.method === "POST" && url.pathname === "/disconnect") {
      await exclusive(async () => {
        await closeBrowser();
        state = "disconnected";
      });
      return json(res, 200, health());
    }
    if (req.method === "POST" && url.pathname === "/generate") {
      const payload = await body(req);
      const result = await exclusive(() => generate(payload));
      res.writeHead(200, {
        "Content-Type": result.mime,
        "Content-Length": result.bytes.length,
        "Cache-Control": "no-store",
        "X-StoryFlow-Model": MODEL,
      });
      return res.end(result.bytes);
    }
    json(res, 404, { error: "Không tìm thấy Flow Worker endpoint." });
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    if (state === "connecting") state = "error";
    json(res, 500, { error: lastError });
  }
});
server.listen(PORT, HOST, () =>
  console.log(`StoryFlow Flow Background Worker: http://${HOST}:${PORT}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    clearInterval(monitor);
    server.close();
    void exclusive(closeBrowser).finally(() => process.exit(0));
  });
