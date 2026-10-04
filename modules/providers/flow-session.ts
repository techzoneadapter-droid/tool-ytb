import { chromium, type Browser, type Page } from "playwright";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromeUserDataDir } from "./flow-profiles";

export function isFlowPage(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "flow.google.com" || (parsed.hostname === "labs.google" && /\/flow(?:\/|$)/.test(parsed.pathname)));
  } catch { return false; }
}
export async function connectFlowEndpoint(
  endpoint: string,
  connect: (url: string) => Promise<Browser> = url => chromium.connectOverCDP(url, { timeout: 90000, noDefaults: true }),
): Promise<Browser> {
  try {
    return await connect(endpoint);
  } catch (error) {
    const url = new URL(endpoint);
    const detail = error instanceof Error ? error.message : String(error);
    if (url.protocol !== "http:" || !/Unexpected status 404[\s\S]*\/json\/version/i.test(detail)) throw error;
    // Chrome's opt-in server has no HTTP discovery route. Connect directly.
    url.protocol = "ws:";
    url.pathname = "/devtools/browser";
    url.search = "";
    url.hash = "";
    try { return await connect(url.href); }
    catch (fallbackError) {
      const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw Error(`HTTP discovery trả 404; đã thử WebSocket ${url.href}.\n${fallbackDetail}`);
    }
  }
}
export async function attachFlowChrome(): Promise<Browser> {
  let endpoint = process.env.FLOW_CDP_URL || "chrome";
  if (endpoint === "chrome") {
    try {
      const contents = await readFile(path.join(chromeUserDataDir(), "DevToolsActivePort"), "utf8");
      const port = Number(contents.trim().split(/\r?\n/)[0]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Cổng Chrome không hợp lệ.");
      // Chrome's opt-in debugging server uses this WS endpoint, not /json/version.
      endpoint = `ws://127.0.0.1:${port}/devtools/browser`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      endpoint = "ws://127.0.0.1:9222/devtools/browser";
    }
  }
  if (endpoint !== "chrome") {
    const url = new URL(endpoint);
    if (!["http:", "ws:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password)
      throw Error("FLOW_CDP_URL phải là địa chỉ Chrome cục bộ.");
  }
  try {
    return await connectFlowEndpoint(endpoint);
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/\u001b\[[0-9;]*m/g, "");
    const hint = /Timeout|timed out/i.test(detail)
      ? "Chrome chưa hoàn tất yêu cầu kết nối. Kiểm tra hộp thoại Cho phép trong cửa sổ Chrome đã chọn; bật Remote debugging chưa thay thế bước xác nhận này."
      : "Không kết nối được máy chủ điều khiển Chrome. Kiểm tra địa chỉ Server running at trong chrome://inspect/#remote-debugging.";
    throw Error(`${hint}\nĐịa chỉ kết nối: ${endpoint}\nChi tiết: ${detail}`);
  }
}
async function targetId(page: Page) {
  const session = await page.context().newCDPSession(page);
  try { return (await session.send("Target.getTargetInfo")).targetInfo.targetId as string; }
  finally { await session.detach(); }
}
export async function flowTabs(browser: Browser) {
  const tabs: { id: string; name: string; url: string }[] = [];
  for (const context of browser.contexts()) for (const page of context.pages()) {
    if (!isFlowPage(page.url())) continue;
    try { tabs.push({ id: await targetId(page), name: await page.title() || "Google Flow", url: page.url() }); } catch {}
  }
  return tabs;
}
export async function selectFlowTab(browser: Browser, id: string): Promise<Page> {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    if (isFlowPage(page.url()) && await targetId(page).catch(() => "") === id) return page;
  }
  throw Error("Tab Flow đã chọn không còn mở. Tải lại danh sách và chọn tab trong đúng profile Chrome đã đăng nhập.");
}

export async function findProfileFlowPage(browser: Browser, token: string): Promise<Page> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) for (const page of context.pages()) {
      if (isFlowPage(page.url()) && new URL(page.url()).searchParams.get("storyflow_connect") === token) return page;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error("Flow đã mở nhưng chưa xác định được tab của profile đã chọn. Bấm Kết nối lại; ứng dụng không tự dùng tài khoản ở profile khác.");
}
