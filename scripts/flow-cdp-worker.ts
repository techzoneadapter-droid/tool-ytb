import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const HOST = "127.0.0.1";
const BRIDGE_URL = process.env.FLOW_BRIDGE_URL || "http://127.0.0.1:7865";
const PORT = Number(new URL(BRIDGE_URL).port || 7865);
const PROJECT_URL = process.env.FLOW_PROJECT_URL || "https://flow.google.com/";
const MODEL = process.env.FLOW_MODEL_LABEL || "Nano Banana Pro";
const GENERATION_TIMEOUT = Number(process.env.FLOW_GENERATION_TIMEOUT_MS || 420000);
const FLOW_PROTOCOL = 5;

let connected = false;
let flowPageId: number | undefined;
let currentUrl = "";
let lastError = "";
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

function chromeUserDataDir() {
  const configured = process.env.FLOW_CHROME_USER_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);

  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    if (local) return path.join(local, "Google", "Chrome", "User Data");
  }
  if (process.platform === "darwin")
    return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  return path.join(os.homedir(), ".config", "google-chrome");
}

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

async function runChromeDevtools(
  args: string[],
  timeout = 120000,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      npxCommand(),
      ["-y", "-p", "chrome-devtools-mcp@latest", "chrome-devtools", ...args],
      {
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
      },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {}
      reject(
        Error(
          "Chrome DevTools hết thời gian chờ. Nếu Chrome đang hỏi quyền điều khiển, hãy bấm Allow rồi thử lại.",
        ),
      );
    }, timeout);

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) resolve({ stdout: out, stderr: err });
      else
        reject(
          Error(
            [out, err, `chrome-devtools thoát với mã ${code ?? "?"}`]
              .filter(Boolean)
              .join("\n"),
          ),
        );
    });
  });
}

async function stopCliDaemon() {
  await runChromeDevtools(["stop"], 20000).catch(() => {});
}

async function openRemoteDebuggingHelp() {
  if (process.platform !== "win32") return;
  await new Promise<void>((resolve) => {
    const child = spawn(
      "cmd.exe",
      ["/d", "/s", "/c", 'start "" chrome "chrome://inspect/#remote-debugging"'],
      { windowsHide: true, shell: false, stdio: "ignore" },
    );
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

function parsePageList(raw: string) {
  const pages: Array<{ id: number; url: string }> = [];

  const tryObject = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) tryObject(item);
      return;
    }
    const record = value as Record<string, unknown>;
    const id =
      typeof record.id === "number"
        ? record.id
        : typeof record.pageId === "number"
          ? record.pageId
          : undefined;
    const url =
      typeof record.url === "string"
        ? record.url
        : typeof record.href === "string"
          ? record.href
          : undefined;
    if (id !== undefined && url) pages.push({ id, url });
    for (const item of Object.values(record)) tryObject(item);
  };

  try {
    tryObject(JSON.parse(raw));
  } catch {}

  if (pages.length) return pages;

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s*[:\-]\s*(https?:\/\/\S+)/i);
    if (match) pages.push({ id: Number(match[1]), url: match[2] });
  }

  return pages;
}

function findReturnedObject(raw: string): Record<string, unknown> | undefined {
  const walk = (value: unknown): Record<string, unknown> | undefined => {
    if (!value || typeof value !== "object") return undefined;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item);
        if (found) return found;
      }
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (record.storyflow === true) return record;
    for (const item of Object.values(record)) {
      if (typeof item === "string" && item.includes('"storyflow"')) {
        const fenced = item.match(/\{[\s\S]*"storyflow"[\s\S]*\}/);
        if (fenced)
          try {
            const parsed = JSON.parse(fenced[0]);
            if (parsed?.storyflow === true) return parsed;
          } catch {}
      }
      const found = walk(item);
      if (found) return found;
    }
    return undefined;
  };

  try {
    const found = walk(JSON.parse(raw));
    if (found) return found;
  } catch {}

  const marker = raw.indexOf('"storyflow"');
  if (marker >= 0) {
    const start = raw.lastIndexOf("{", marker);
    const end = raw.indexOf("}", marker);
    if (start >= 0 && end > start)
      try {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        if (parsed?.storyflow === true) return parsed;
      } catch {}
  }
  return undefined;
}

async function startAutoConnect() {
  await stopCliDaemon();

  const userDataDir = chromeUserDataDir();
  try {
    await runChromeDevtools(
      [
        "start",
        "--autoConnect",
        "--headless=false",
        "--userDataDir",
        userDataDir,
      ],
      45000,
    );
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    await openRemoteDebuggingHelp();
    throw Error(
      "Chrome chưa bật kết nối điều khiển an toàn. StoryFlow đã mở trang Remote Debugging. " +
        "Trong Chrome, bật Remote Debugging tại chrome://inspect/#remote-debugging, sau đó bấm Kết nối Flow lại. " +
        "Khi Chrome hỏi quyền, bấm Allow.\n" +
        lastError,
    );
  }

  // The first real tool call triggers Chrome's permission prompt in autoConnect mode.
  let listed: { stdout: string; stderr: string };
  try {
    listed = await runChromeDevtools(["list_pages", "--output-format=json"], 180000);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    await openRemoteDebuggingHelp();
    throw Error(
      "Chưa kết nối được với Chrome hiện tại. Hãy bật Remote Debugging rồi bấm Allow khi Chrome hỏi quyền.\n" +
        lastError,
    );
  }

  let pages = parsePageList(listed.stdout);
  let flow = pages.find((page) => {
    try {
      return new URL(page.url).hostname === "flow.google.com";
    } catch {
      return false;
    }
  });

  if (!flow) {
    await runChromeDevtools(["new_page", PROJECT_URL], 120000);
    const next = await runChromeDevtools(
      ["list_pages", "--output-format=json"],
      60000,
    );
    pages = parsePageList(next.stdout);
    flow = pages.find((page) => {
      try {
        return new URL(page.url).hostname === "flow.google.com";
      } catch {
        return false;
      }
    });
  }

  if (!flow)
    throw Error(
      "Đã kết nối Chrome nhưng chưa tìm thấy tab Google Flow. Hãy mở flow.google.com bằng đúng tài khoản Flow Plus rồi kết nối lại.",
    );

  flowPageId = flow.id;
  currentUrl = flow.url;
  connected = true;
  lastError = "";
}

async function health() {
  return {
    status: "ok" as const,
    engine: "flow" as const,
    protocol: FLOW_PROTOCOL,
    bridgeReady: true,
    browserOpen: connected,
    connected,
    projectConfigured: !!process.env.FLOW_PROJECT_URL,
    currentUrl: currentUrl || undefined,
    model: MODEL,
    connectionMode: "chrome-devtools-autoconnect",
    message: connected
      ? "Đã kết nối trực tiếp Chrome đang mở bằng Chrome DevTools Auto Connect."
      : "Bấm Kết nối Flow. Lần đầu cần bật Remote Debugging và bấm Allow trong Chrome.",
    lastError: lastError || undefined,
  };
}

function generationScript(prompt: string, aspect: "16:9" | "9:16") {
  return `async () => {
    const prompt = ${JSON.stringify(prompt)};
    const aspect = ${JSON.stringify(aspect)};
    const timeoutMs = ${Math.max(30000, GENERATION_TIMEOUT)};

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const largeImages = () =>
      Array.from(document.images)
        .filter((img) =>
          img.complete &&
          img.naturalWidth >= 512 &&
          img.naturalHeight >= 512 &&
          (img.currentSrc || img.src)
        )
        .map((img) => img.currentSrc || img.src);

    const before = new Set(largeImages());

    const selectors = [
      'textarea[placeholder*="Bạn muốn tạo"]',
      'textarea[placeholder*="What do you want"]',
      '[contenteditable="true"][role="textbox"]',
      'textarea',
      '[contenteditable="true"]'
    ];

    let box = null;
    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      box = nodes.reverse().find((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
      });
      if (box) break;
    }
    if (!box) throw new Error("Không tìm thấy ô nhập prompt trên Flow.");

    box.focus();
    if (box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement) {
      const proto = box instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(box, prompt);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      box.textContent = prompt;
      box.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: prompt
      }));
    }

    const aspectNodes = Array.from(document.querySelectorAll('button,[role="button"],span,div'));
    const aspectNode = aspectNodes.find((node) => node.textContent?.trim() === aspect);
    if (aspectNode instanceof HTMLElement) aspectNode.click();

    await sleep(300);

    const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
    const generate = buttons.reverse().find((node) => {
      if (!(node instanceof HTMLElement)) return false;
      const label = (node.getAttribute('aria-label') || node.textContent || '').trim().toLowerCase();
      const disabled =
        node instanceof HTMLButtonElement ? node.disabled : node.getAttribute('aria-disabled') === 'true';
      return !disabled && ['tạo','generate','gửi','send'].some((key) => label === key || label.includes(key));
    });

    if (generate instanceof HTMLElement) generate.click();
    else {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      box.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    }

    const deadline = Date.now() + timeoutMs;
    let src = '';
    while (Date.now() < deadline) {
      const body = document.body?.innerText?.toLowerCase() || '';
      const warning = [
        'hết tín dụng',
        'tín dụng google flow',
        'too many requests',
        'rate limit',
        'try again later',
        'thử lại sau'
      ].find((item) => body.includes(item));
      if (warning) throw new Error('Google Flow đang báo giới hạn/tín dụng: ' + warning);

      const fresh = largeImages().filter((item) => !before.has(item));
      if (fresh.length) {
        src = fresh[fresh.length - 1];
        break;
      }
      await sleep(1500);
    }
    if (!src) throw new Error('Flow chưa trả ảnh trong thời gian chờ.');

    const response = await fetch(src);
    if (!response.ok) throw new Error('Không tải được ảnh Flow: HTTP ' + response.status);
    const blob = await response.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });

    return {
      storyflow: true,
      mime: blob.type || 'image/png',
      dataUrl,
      src
    };
  }`;
}

async function generate(payload: {
  prompt?: string;
  aspect?: "16:9" | "9:16";
}) {
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) throw Error("Prompt Flow đang trống.");
  if (!connected || flowPageId === undefined) await startAutoConnect();

  let release!: () => void;
  const previous = generationQueue;
  generationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});

  try {
    const script = generationScript(prompt, payload.aspect || "16:9");
    const result = await runChromeDevtools(
      [
        "evaluate_script",
        script,
        "--pageId",
        String(flowPageId),
        "--output-format=json",
      ],
      GENERATION_TIMEOUT + 60000,
    );

    const returned = findReturnedObject(result.stdout);
    const dataUrl = typeof returned?.dataUrl === "string" ? returned.dataUrl : "";
    if (!dataUrl.startsWith("data:image/"))
      throw Error(
        "Google Flow đã chạy nhưng StoryFlow chưa đọc được ảnh kết quả từ Chrome.",
      );

    const comma = dataUrl.indexOf(",");
    const bytes = Buffer.from(dataUrl.slice(comma + 1), "base64");
    if (bytes.length < 10000) throw Error("Ảnh Flow trả về quá nhỏ hoặc không hợp lệ.");
    return bytes;
  } finally {
    release();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health")
      return json(res, 200, await health());

    if (req.method === "POST" && url.pathname === "/open") {
      await readBody(req).catch(() => ({}));
      await startAutoConnect();
      return json(res, 200, await health());
    }

    if (req.method === "POST" && url.pathname === "/disconnect") {
      connected = false;
      flowPageId = undefined;
      currentUrl = "";
      await stopCliDaemon();
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
    const message = error instanceof Error ? error.message : String(error);
    lastError = message;
    return json(res, 500, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`StoryFlow Flow AutoConnect Worker: http://${HOST}:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await stopCliDaemon();
    server.close(() => process.exit(0));
  });
