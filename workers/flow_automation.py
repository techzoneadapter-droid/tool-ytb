"""Headless Flow session. Cookies remain in memory and are never logged."""
import json
import math
import os
import re
import time
import traceback
from pathlib import Path
from uuid import uuid4
from urllib.parse import urlparse

from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout


class FlowError(Exception):
    def __init__(self, code, message, stage=None, diagnostics=None):
        super().__init__(message)
        self.code = code
        self.stage = stage
        self.diagnostics = diagnostics


def normalize_cookies(cookie_json, now=None):
    """Convert EditThisCookie fields to Playwright's documented cookie schema."""
    if not isinstance(cookie_json, str) or len(cookie_json.encode("utf-8")) > 1048576:
        raise FlowError("INVALID_COOKIES", "Cookie phải là chuỗi JSON, tối đa 1 MB.")
    try:
        entries = json.loads(cookie_json)
    except (ValueError, TypeError):
        raise FlowError("INVALID_COOKIES", "JSON cookie không hợp lệ.") from None
    if not isinstance(entries, list) or not entries or len(entries) > 3000:
        raise FlowError("INVALID_COOKIES", "Cần mảng cookie xuất từ EditThisCookie.")
    now = time.time() if now is None else now
    result = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise FlowError("INVALID_COOKIES", f"Cookie số {index + 1} không phải đối tượng.")
        name, value, domain = (entry.get(k) for k in ("name", "value", "domain"))
        if not isinstance(name, str) or not name or not isinstance(value, str) or not isinstance(domain, str):
            raise FlowError("INVALID_COOKIES", f"Cookie số {index + 1} thiếu name/value/domain.")
        host = domain.lstrip(".").lower()
        if not any(host == base or host.endswith("." + base) for base in ("google.com", "labs.google", "googleusercontent.com")):
            raise FlowError("INVALID_COOKIES", f"Cookie số {index + 1} không thuộc miền Google Flow được hỗ trợ.")
        cookie_path = entry.get("path", "/")
        if not isinstance(cookie_path, str) or not cookie_path.startswith("/"):
            raise FlowError("INVALID_COOKIES", f"Path cookie số {index + 1} không hợp lệ.")
        cookie = {"name": name, "value": value, "domain": domain, "path": cookie_path}
        for flag in ("secure", "httpOnly"):
            if flag in entry:
                if not isinstance(entry[flag], bool):
                    raise FlowError("INVALID_COOKIES", f"Thuộc tính {flag} cookie số {index + 1} không hợp lệ.")
                cookie[flag] = entry[flag]
        raw_site = entry.get("sameSite", "unspecified")
        site = {"strict": "Strict", "lax": "Lax", "none": "None", "no_restriction": "None"}.get(str(raw_site).lower())
        if site:
            cookie["sameSite"] = site
        elif raw_site not in (None, "unspecified", ""):
            raise FlowError("INVALID_COOKIES", f"sameSite cookie số {index + 1} không hợp lệ.")
        expiry = entry.get("expirationDate", entry.get("expires"))
        if not entry.get("session", False) and expiry is not None and expiry != -1:
            if isinstance(expiry, bool) or not isinstance(expiry, (int, float)) or not math.isfinite(expiry):
                raise FlowError("INVALID_COOKIES", f"Ngày hết hạn cookie số {index + 1} không hợp lệ.")
            if expiry <= now:
                # Stale unrelated cookies must not invalidate an otherwise live export.
                continue
            cookie["expires"] = float(expiry)
        result.append(cookie)
    if not result:
        raise FlowError("COOKIE_EXPIRED", "Tất cả cookie đã hết hạn. Hãy xuất lại cookie từ phiên Flow đang đăng nhập.")
    return result


def is_flow_url(url):
    parsed = urlparse(url)
    return parsed.scheme == "https" and (parsed.hostname == "flow.google.com" or (parsed.hostname == "labs.google" and re.search(r"/flow(?:/|$)", parsed.path)))


class FlowAutomation:
    def __init__(self, project_url=None, model=None):
        self.playwright = self.browser = self.context = self.page = None
        self.project_url = project_url or os.getenv("FLOW_PROJECT_URL", "")
        self.model = model or os.getenv("FLOW_MODEL_LABEL", "Nano Banana Pro")
        self.state = "disconnected"
        self.last_error = ""

    def health(self):
        return {"status": "ok", "engine": "flow", "protocol": 17, "bridgeReady": True,
                "browserOpen": self.browser is not None, "connected": self.state in ("ready", "generating"),
                "state": self.state, "background": True, "connectionMode": "python-headless-cookies",
                "projectConfigured": bool(self.project_url), "model": self.model,
                "lastError": self.last_error or None,
                "message": self.last_error or {"ready": "Flow headless đã sẵn sàng.", "generating": "Đang tạo ảnh Flow trong nền.",
                    "project_required": "Cookie đã xác thực. Cần URL dự án Flow để tạo ảnh."}.get(self.state, "Dán JSON cookie EditThisCookie để kết nối Flow chạy ẩn.")}

    async def _auth_check(self):
        if self.page is None or self.page.is_closed():
            raise FlowError("SESSION_REQUIRED", "Chưa khởi tạo phiên Flow.")
        host = urlparse(self.page.url).hostname or ""
        if host == "accounts.google.com" or re.search(r"/(signin|login|servicelogin)(?:[/?]|$)", self.page.url, re.I):
            raise FlowError("COOKIE_EXPIRED", "Google yêu cầu đăng nhập lại: cookie hết hạn, thiếu hoặc phiên mới không được chấp nhận.")
        if not is_flow_url(self.page.url):
            raise FlowError("AUTH_UNCONFIRMED", "Trang đã chuyển khỏi Flow; chưa xác nhận được phiên đăng nhập.")
        login = self.page.get_by_role("button", name=re.compile(r"^(sign in|đăng nhập)$", re.I)).or_(
            self.page.get_by_role("link", name=re.compile(r"^(sign in|đăng nhập)$", re.I)))
        if await login.filter(visible=True).count():
            raise FlowError("COOKIE_EXPIRED", "Flow yêu cầu đăng nhập. Hãy xuất lại đầy đủ cookie của phiên đang đăng nhập.")

    def _editor(self):
        return self.page.locator('.ProseMirror[contenteditable="true"], textarea, [contenteditable="true"][role="textbox"]').filter(visible=True).last

    async def initialize_session(self, cookie_json):
        # A failed replacement must not leave an old account silently active.
        await self.close()
        self.state = "connecting"
        try:
            cookies = normalize_cookies(cookie_json)
            if self.project_url and not is_flow_url(self.project_url):
                raise FlowError("INVALID_PROJECT", "URL dự án phải thuộc Google Flow.")
            self.playwright = await async_playwright().start()
            self.browser = await self.playwright.chromium.launch(headless=True, channel=os.getenv("FLOW_BROWSER_CHANNEL", "chrome"))
            self.context = await self.browser.new_context()
            await self.context.add_cookies(cookies)
            self.page = await self.context.new_page()
            response = await self.page.goto("https://flow.google.com", wait_until="domcontentloaded", timeout=60000)
            if response and response.status >= 400:
                raise FlowError("FLOW_UNAVAILABLE", "Flow trả lỗi truy cập. Kiểm tra quyền tài khoản hoặc mạng.")
            if self.project_url:
                await self.page.goto(self.project_url, wait_until="domcontentloaded", timeout=60000)
            await self._auth_check()
            try:
                await self._editor().wait_for(state="visible", timeout=20000)
            except PlaywrightTimeout:
                await self._auth_check()
                # An authenticated project link is evidence; a public landing page is not.
                projects = self.page.locator('a[href*="/flow/project/"], a[href*="/project/"]').filter(visible=True)
                if not self.project_url and await projects.count():
                    self.state = "project_required"
                    return self.health()
                raise FlowError("AUTH_UNCONFIRMED", "Chưa xác nhận được phiên Flow. Cookie có thể thiếu, Google yêu cầu xác minh, hoặc trang chưa có ô tạo ảnh.") from None
            self.state = "ready"
            await self._auth_check()
            self.last_error = ""
            return self.health()
        except FlowError as error:
            await self.close()
            self.state = "login_required" if error.code in ("COOKIE_EXPIRED", "AUTH_UNCONFIRMED") else "error"
            self.last_error = f"[{error.code}] {error}"
            raise
        except Exception:
            await self.close()
            self.state = "error"
            self.last_error = "Không khởi tạo được Flow headless. Kiểm tra Playwright, Chrome và kết nối mạng."
            raise FlowError("CONNECTION_FAILED", self.last_error) from None

    async def _click(self, locator):
        target = locator.filter(visible=True).first
        if not await target.count():
            return False
        await target.click(timeout=10000)
        return True

    async def _configure(self, aspect):
        self.config_stage = "FLOW_CONFIG_AGENT"
        try:
            await self._configure_controls(aspect)
        except Exception as cause:
            stage = self.config_stage
            diagnostics = await self._capture_config_failure(stage, cause, aspect)
            original = cause.code if isinstance(cause, FlowError) else type(cause).__name__
            raise FlowError(stage, f"{original}: {cause}", stage=stage, diagnostics=diagnostics) from cause

    async def _capture_config_failure(self, stage, cause, aspect):
        directory = Path(os.getenv("FLOW_DIAGNOSTICS_DIR", "data/flow-diagnostics")).resolve()
        prefix = directory / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid4().hex[:8]}-{stage}"
        result = {}
        failures = []
        try:
            directory.mkdir(parents=True, exist_ok=True)
        except Exception as error:
            return {"captureErrors": [f"directory: {error}"]}
        for kind in ("screenshot", "html"):
            target = str(prefix) + (".png" if kind == "screenshot" else ".html")
            try:
                if kind == "screenshot":
                    await self.page.screenshot(path=target, full_page=True, timeout=10000)
                else:
                    Path(target).write_text(await self.page.content(), encoding="utf-8")
                result[kind] = target
            except Exception as error:
                failures.append(f"{kind}: {error}")
        metadata = {"stage": stage, "error": str(cause), "errorType": type(cause).__name__,
                    "model": self.model, "aspect": aspect, "url": self.page.url,
                    "traceback": traceback.format_exc(), "artifacts": dict(result), "captureErrors": failures}
        try:
            target = str(prefix) + ".json"
            Path(target).write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
            result["metadata"] = target
        except Exception as error:
            failures.append(f"metadata: {error}")
        if failures:
            result["captureErrors"] = failures
        return result

    async def _configure_controls(self, aspect):
        agent = self.page.get_by_role("button", name=re.compile(r"^(agent|tác nhân)$", re.I)).filter(visible=True).first
        if await agent.count() and await agent.get_attribute("aria-pressed") == "true":
            await agent.click()
        agent_switch = self.page.get_by_role("switch", name=re.compile(r"^(agent|tác nhân)$", re.I)).filter(visible=True).first
        if await agent_switch.count() and await agent_switch.is_checked():
            await agent_switch.uncheck()
        self.config_stage = "FLOW_CONFIG_PICKER"
        picker = self.page.locator("button.settings-trigger-button").or_(self.page.get_by_role("button", name=re.compile(r"nano banana|imagen|veo|Điều kiện kích hoạt cài đặt", re.I)))
        if not await self._click(picker):
            raise FlowError("UI_CHANGED", "Không tìm thấy bộ chọn model Flow.")

        # Flow changes the Image/Video segmented control frequently. When the
        # composer is already in Image mode, some builds do not expose a
        # separate clickable "Image/Hình ảnh" item inside the settings popover.
        self.config_stage = "FLOW_CONFIG_MODE"
        modes = re.compile(r"^(image|images|create images|tạo ảnh|hình ảnh|ảnh)$", re.I)
        mode_controls = (
            self.page.get_by_role("tab", name=modes)
            .or_(self.page.get_by_role("button", name=modes))
            .or_(self.page.get_by_role("menuitem", name=modes))
            .or_(self.page.get_by_role("radio", name=modes))
            .or_(self.page.get_by_role("option", name=modes))
        )
        mode_clicked = await self._click(mode_controls)

        image_model_pattern = re.compile(r"nano banana|imagen", re.I)
        image_model_controls = (
            self.page.get_by_role("button", name=image_model_pattern)
            .or_(self.page.get_by_role("combobox", name=image_model_pattern))
            .or_(self.page.get_by_role("option", name=image_model_pattern))
            .filter(visible=True)
        )
        visible_image_model_text = self.page.get_by_text(image_model_pattern).filter(visible=True)

        if not mode_clicked and not (await image_model_controls.count() or await visible_image_model_text.count()):
            raise FlowError(
                "UI_CHANGED",
                "Không xác nhận được chế độ tạo ảnh; Flow không hiển thị nút Hình ảnh và cũng không thấy model ảnh đang được chọn. Chưa gửi prompt.",
            )

        self.config_stage = "FLOW_CONFIG_MODEL"
        exact_model = re.compile(r"^(?:🍌\s*)?" + re.escape(self.model) + "$", re.I)
        selected_model = (
            self.page.get_by_role("button", name=exact_model)
            .or_(self.page.get_by_role("combobox", name=exact_model))
            .filter(visible=True)
        )
        if not await selected_model.count():
            models = self.page.get_by_text(exact_model).filter(visible=True)
            if not await models.count():
                await self._click(
                    self.page.get_by_role("combobox")
                    .filter(has_text=image_model_pattern)
                    .or_(self.page.get_by_role("button", name=image_model_pattern))
                )
                models = self.page.get_by_text(exact_model).filter(visible=True)
            if not await models.count():
                raise FlowError("MODEL_UNAVAILABLE", "Model ảnh được yêu cầu không có trong tài khoản Flow.")
            await models.last.click()
        self.config_stage = "FLOW_CONFIG_RATIO"
        ratio = re.compile(re.escape(aspect) + (r"|crop_16_9|landscape|ngang" if aspect == "16:9" else r"|crop_9_16|portrait|dọc"), re.I)
        choices = self.page.get_by_role("button", name=ratio).or_(self.page.get_by_role("radio", name=ratio)).or_(self.page.get_by_role("option", name=ratio)).or_(self.page.get_by_role("menuitem", name=ratio))
        if not await self._click(choices):
            await self._click(picker)
            await self._click(self.page.get_by_role("combobox").filter(has_text=re.compile(r"16:9|9:16|landscape|portrait", re.I)))
            if not await self._click(choices):
                raise FlowError("UI_CHANGED", "Không chọn được tỷ lệ ảnh Flow.")
        self.config_stage = "FLOW_CONFIG_COUNT"
        if not await self._click(self.page.get_by_role("button", name=re.compile(r"^(x1|1x|1)$", re.I)).or_(self.page.get_by_role("radio", name=re.compile(r"^(x1|1x|1)$", re.I)))):
            raise FlowError("UI_CHANGED", "Không xác nhận được số ảnh x1; chưa gửi prompt.")
        self.config_stage = "FLOW_CONFIG_CLOSE"
        await self.page.keyboard.press("Escape")

    async def generate_image(self, prompt, aspect="16:9"):
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 50000:
            raise FlowError("INVALID_PROMPT", "Prompt phải có nội dung và tối đa 50.000 ký tự.")
        if aspect not in ("16:9", "9:16"):
            raise FlowError("INVALID_ASPECT", "Tỷ lệ ảnh không hợp lệ.")
        if self.state != "ready":
            raise FlowError("SESSION_REQUIRED", "Phiên Flow chưa sẵn sàng. Nạp cookie và URL dự án trước.")
        self.state = "generating"
        try:
            await self._auth_check()
            await self._configure(aspect)
            images = "() => Array.from(document.images).filter(i => i.complete && i.naturalWidth >= 256 && i.naturalHeight >= 256 && i.naturalWidth*i.naturalHeight >= 262144).map(i => i.currentSrc || i.src)"
            before = set(await self.page.evaluate(images))
            await self._editor().fill(prompt.strip())
            submit = self.page.get_by_role("button", name=re.compile(r"^(bắt đầu tạo|tạo ảnh|tạo|generate(?: images?)?|start generating|arrow_forward)$", re.I)).filter(visible=True).last
            await submit.click(timeout=10000)
            deadline = time.monotonic() + int(os.getenv("FLOW_GENERATION_TIMEOUT_MS", "420000")) / 1000
            while time.monotonic() < deadline:
                await self._auth_check()
                alerts = " ".join(await self.page.locator('[role="alert"]').all_text_contents()).lower()
                if any(word in alerts for word in ("insufficient credits", "hết tín dụng", "too many requests", "rate limit", "try again later", "thử lại sau")):
                    raise FlowError("FLOW_LIMIT", "Flow báo giới hạn hoặc hết tín dụng.")
                fresh = [src for src in await self.page.evaluate(images) if src not in before]
                if fresh:
                    src = fresh[-1]
                    if src.startswith(("blob:", "data:image/")):
                        import base64
                        data = await self.page.evaluate("async src => { const r=await fetch(src); if(!r.ok) throw Error('asset'); const b=await r.blob(); return await new Promise((resolve,reject)=>{const f=new FileReader();f.onload=()=>resolve(f.result);f.onerror=reject;f.readAsDataURL(b)}); }", src)
                        match = re.fullmatch(r"data:(image/[\w.+-]+);base64,(.+)", data, re.S)
                        if not match:
                            raise FlowError("INVALID_IMAGE", "Flow không trả ảnh hợp lệ.")
                        mime, content = match[1], base64.b64decode(match[2], validate=True)
                    else:
                        asset = urlparse(src)
                        host = asset.hostname or ""
                        if asset.scheme != "https" or not any(host == base or host.endswith("." + base) for base in ("googleusercontent.com", "googleapis.com", "labs.google", "flow.google.com")):
                            raise FlowError("INVALID_IMAGE", "Máy chủ ảnh Flow không được hỗ trợ.")
                        response = await self.context.request.get(src, timeout=30000, max_redirects=0)
                        if not response.ok:
                            raise FlowError("IMAGE_DOWNLOAD", "Không tải được ảnh Flow.")
                        mime = response.headers.get("content-type", "").split(";")[0]
                        content = await response.body()
                    if not mime.startswith("image/") or len(content) < 10000:
                        raise FlowError("INVALID_IMAGE", "Ảnh Flow quá nhỏ hoặc không hợp lệ.")
                    self.state, self.last_error = "ready", ""
                    return content, mime
                await self.page.wait_for_timeout(1500)
            raise FlowError("GENERATION_TIMEOUT", "Flow chưa trả ảnh trong thời gian chờ. Kiểm tra trước khi thử lại để tránh tạo trùng.")
        except FlowError as error:
            self.state = "login_required" if error.code in ("COOKIE_EXPIRED", "AUTH_UNCONFIRMED") else "ready"
            self.last_error = f"[{error.code}] {error}"
            raise
        except Exception:
            self.state = "error"
            self.last_error = "Giao diện Flow thay đổi hoặc trình duyệt bị ngắt; chưa xác nhận được kết quả tạo ảnh."
            raise FlowError("GENERATION_FAILED", self.last_error) from None

    async def close(self):
        for resource in (self.context, self.browser):
            if resource:
                try:
                    await resource.close()
                except Exception:
                    pass
        if self.playwright:
            try:
                await self.playwright.stop()
            except Exception:
                pass
        self.playwright = self.browser = self.context = self.page = None
        self.state, self.last_error = "disconnected", ""
