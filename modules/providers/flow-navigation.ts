import { errors, type Page } from "playwright";

// Readiness is checked using the editor, not the page's load event.
export async function navigateFlow(page: Page, url: string, timeout = 30000) {
  try {
    const response = await page.goto(url, { waitUntil: "commit", timeout });
    if (response && response.status() >= 400)
      throw Error(`Không mở được Flow (HTTP ${response.status()}). Kiểm tra quyền truy cập dự án trong Chrome.`);
    return true;
  } catch (error) {
    if (error instanceof errors.TimeoutError && !page.isClosed()) return false;
    if (error instanceof Error && error.message.includes("net::ERR_"))
      throw Error("Không kết nối được trang Flow. Kiểm tra mạng/VPN và thử mở dự án bằng Chrome.");
    throw error;
  }
}
