"""Headless Flow session with local cookie persistence; credentials are never logged."""
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

COMPOSER_SCRIPT = Path(__file__).with_name("flow_composer.js").read_text(encoding="utf-8")
FLOW_COMPOSER_SCRIPT = COMPOSER_SCRIPT
MONITOR_SCRIPT = "async args => (" + COMPOSER_SCRIPT + ")({ ...args, action: 'snapshot' })"


class FlowError(Exception):
    def __init__(self, code, message, stage=None, diagnostics=None):
        super().__init__(message)
        self.code = code
        self.stage = stage or code
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
        raise FlowError("FLOW_COOKIE_EXPIRED", "Tất cả cookie đã hết hạn. Hãy xuất lại cookie từ phiên Flow đang đăng nhập.")
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
        self.cookie_file = Path(os.getenv("FLOW_COOKIES_FILE", "cookies.json")).resolve()
        self.session_file = Path(os.getenv("FLOW_SESSION_FILE", "data/flow-session.json")).resolve()
        self.session_ready = self.composer_ready = self.generation_ready = False
        self.last_stage = "FLOW_DISCONNECTED"
        self.observed_models = []
        self.observed_model = None
        self.current_request_id = None
        self._generation_request_seen = False
        self.flow_diagnostics = {}
        self.debug_directory = None

    def health(self):
        current_url = self.page.url if self.page and isinstance(self.page.url, str) else None
        return {"status": "ok", "engine": "flow", "protocol": 22, "bridgeReady": True,
                "browserOpen": self.browser is not None, "connected": self.session_ready,
                "sessionReady": self.session_ready, "composerReady": self.composer_ready,
                "generationReady": self.generation_ready, "lastStage": self.last_stage,
                "currentUrl": urlparse(current_url)._replace(query="", fragment="").geturl() if current_url else None,
                "observedModels": self.observed_models,
                "currentRequestId": self.current_request_id,
                "state": self.state, "background": True, "connectionMode": "python-headless-cookies",
                "projectConfigured": bool(self.project_url), "model": self.observed_model or "project-current",
                "lastError": self.last_error or None,
                "message": self.last_error or {"starting": "Khởi động Flow Worker...", "restoring": "Đang khôi phục phiên Flow...", "ready": "Flow sẵn sàng", "generating": "Flow đang tạo ảnh...",
                    "project_required": "Cookie đã xác thực. Cần URL dự án Flow để tạo ảnh."}.get(self.state, "Dán JSON cookie EditThisCookie để kết nối Flow chạy ẩn.")}

    async def _auth_check(self):
        if self.page is None or self.page.is_closed():
            raise FlowError("FLOW_LOGIN_REQUIRED", "Chưa khởi tạo phiên Flow.")
        host = urlparse(self.page.url).hostname or ""
        if host == "accounts.google.com" or re.search(r"/(signin|login|servicelogin)(?:[/?]|$)", self.page.url, re.I):
            raise FlowError("FLOW_COOKIE_EXPIRED", "Google yêu cầu đăng nhập lại: cookie hết hạn, thiếu hoặc phiên mới không được chấp nhận.")
        if not is_flow_url(self.page.url):
            raise FlowError("FLOW_LOGIN_REQUIRED", "Trang đã chuyển khỏi Flow; chưa xác nhận được phiên đăng nhập.")
        login = self.page.get_by_role("button", name=re.compile(r"^(sign in|đăng nhập)$", re.I)).or_(
            self.page.get_by_role("link", name=re.compile(r"^(sign in|đăng nhập)$", re.I)))
        if await login.filter(visible=True).count():
            raise FlowError("FLOW_COOKIE_EXPIRED", "Flow yêu cầu đăng nhập. Hãy xuất lại đầy đủ cookie của phiên đang đăng nhập.")

    def _editor(self):
        return self.page.locator('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]').filter(visible=True).last

    async def restore_session(self):
        if not self.cookie_file.is_file():
            return self.health()
        try:
            if self.cookie_file.stat().st_size > 1048576:
                raise FlowError("INVALID_COOKIES", "Saved cookie file exceeds 1 MB.")
            raw = self.cookie_file.read_text(encoding="utf-8-sig")
            if not self.project_url and self.session_file.is_file():
                saved = json.loads(self.session_file.read_text(encoding="utf-8"))
                if not isinstance(saved, dict):
                    raise FlowError("FLOW_PROJECT_INVALID", "Saved project metadata is invalid.")
                candidate = saved.get("projectUrl", "")
                if not isinstance(candidate, str) or (candidate and not is_flow_url(candidate)):
                    raise FlowError("FLOW_PROJECT_INVALID", "Saved project URL is invalid.")
                self.project_url = candidate
        except (OSError, UnicodeError, ValueError):
            raise FlowError("COOKIE_FILE_READ", "Cannot read the saved Flow cookie file.") from None
        return await self.initialize_session(raw, persist=False)

    def _save_cookies(self, cookies):
        self.cookie_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.cookie_file.with_name(self.cookie_file.name + ".tmp")
        try:
            temporary.write_text(json.dumps(cookies, ensure_ascii=False), encoding="utf-8")
            temporary.chmod(0o600)
            temporary.replace(self.cookie_file)
        finally:
            temporary.unlink(missing_ok=True)
        if self.project_url:
            self.session_file.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.session_file.with_name(self.session_file.name + ".tmp")
            try:
                temporary.write_text(json.dumps({"projectUrl": self.project_url}), encoding="utf-8")
                temporary.replace(self.session_file)
            finally:
                temporary.unlink(missing_ok=True)

    async def initialize_session(self, cookie_json, persist=True):
        # A failed replacement must not leave an old account silently active.
        await self.close()
        self.state = "restoring" if not persist else "starting"
        self.last_stage = "FLOW_SESSION_RESTORE" if not persist else "FLOW_SESSION_CONNECT"
        try:
            if persist:
                self.cookie_file.unlink(missing_ok=True)
            cookies = normalize_cookies(cookie_json)
            if self.project_url and not is_flow_url(self.project_url):
                raise FlowError("FLOW_PROJECT_INVALID", "URL dự án phải thuộc Google Flow.")
            self.playwright = await async_playwright().start()
            self.browser = await self.playwright.chromium.launch(headless=True, channel=os.getenv("FLOW_BROWSER_CHANNEL", "chrome"))
            self.context = await self.browser.new_context()
            await self.context.add_cookies(cookies)
            self.page = await self.context.new_page()
            response = await self.page.goto("https://flow.google.com", wait_until="domcontentloaded", timeout=60000)
            if response and response.status >= 400:
                raise FlowError("FLOW_UNAVAILABLE", "Flow trả lỗi truy cập. Kiểm tra quyền tài khoản hoặc mạng.")
            if self.project_url:
                self.last_stage = "FLOW_PROJECT_OPEN"
                await self.page.goto(self.project_url, wait_until="domcontentloaded", timeout=60000)
                project_path = re.search(r"/project/([^/?#]+)", urlparse(self.project_url).path)
                # A fresh session may need the public entry button to enter the
                # application before a project deep link is accepted.
                landing = await self.page.evaluate("""() => location.hostname === 'flow.google.com'
                    && !document.querySelector('textarea,[contenteditable="true"],[role="textbox"]')
                    && !!document.querySelector('a[href*="one.google.com/ai"]')""")
                if landing is True and project_path and urlparse(self.project_url).hostname == "flow.google.com":
                    pages_before = set(self.context.pages)
                    await self.page.get_by_role("button", name="Create with Google Flow", exact=True).first.click(timeout=10000)
                    entry_deadline = time.monotonic() + 15
                    while time.monotonic() < entry_deadline:
                        new_pages = [page for page in self.context.pages if page not in pages_before]
                        if new_pages:
                            self.page = new_pages[-1]
                        try:
                            entered = await self.page.evaluate("""() => !document.querySelector('button[aria-label="Create with Google Flow"]')
                                && (!!document.querySelector('textarea,[contenteditable="true"],[role="textbox"],a[href*="/project/"]'))""")
                            if entered:
                                break
                        except Exception:
                            pass  # Navigation can briefly destroy the JS context.
                        await self.page.wait_for_timeout(100)
                    await self._auth_check()
                    await self.page.goto(self.project_url, wait_until="domcontentloaded", timeout=60000)
            await self._auth_check()
            try:
                self.last_stage = "FLOW_COMPOSER_WAIT"
                await self._editor().wait_for(state="visible", timeout=20000)
            except PlaywrightTimeout:
                await self._auth_check()
                # An authenticated project link is evidence; a public landing page is not.
                projects = self.page.locator('a[href*="/flow/project/"], a[href*="/project/"]').filter(visible=True)
                if not self.project_url and await projects.count():
                    self.session_ready = True
                    self.state = "project_required"
                    self.last_stage = "FLOW_PROJECT_INVALID"
                    if persist:
                        self._save_cookies(cookies)
                    return self.health()
                # Keep authenticated cookies even when the composer is unavailable.
                self.session_ready = bool(self.project_url)
                self.state = "project_required"
                self.last_stage = "FLOW_COMPOSER_NOT_FOUND"
                self.last_error = "[FLOW_COMPOSER_NOT_FOUND] Flow chưa có ô nhập prompt trong project."
                if persist and self.session_ready:
                    self._save_cookies(cookies)
                return self.health()
            self.state = "ready"
            await self._auth_check()
            self.session_ready = True
            try:
                await self._ensure_composer_ready()
            except FlowError as error:
                self.state = "error"
                self.last_error = f"[{error.code}] {error}"
                self.last_stage = error.stage
            if persist:
                self._save_cookies(cookies)
            if self.generation_ready:
                self.last_error = ""
                self.last_stage = "FLOW_READY"
            return self.health()
        except FlowError as error:
            await self.close()
            self.state = "login_required" if error.code in ("FLOW_COOKIE_EXPIRED", "FLOW_LOGIN_REQUIRED") else "error"
            self.last_error = f"[{error.code}] {error}"
            self.last_stage = error.stage
            raise
        except Exception as cause:
            stage = self.last_stage
            await self.close()
            self.state = "error"
            self.last_stage = stage
            self.last_error = f"{type(cause).__name__}: Không khởi tạo được Flow headless. Kiểm tra Playwright, Chrome và kết nối mạng."
            raise FlowError("FLOW_SESSION_RESTORE_FAILED", self.last_error, stage=self.last_stage) from cause

    async def _click(self, locator):
        target = locator.filter(visible=True).first
        if not await target.count():
            return False
        handle = await target.element_handle(timeout=10000)
        try:
            return await self.page.evaluate("node => { if (!node || !node.isConnected || node.disabled || node.getAttribute('aria-disabled') === 'true') return false; node.click(); return true; }", handle)
        finally:
            if handle:
                await handle.dispose()

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
        if os.getenv("FLOW_DEBUG") != "1":
            return None
        directory = Path(os.getenv("FLOW_DIAGNOSTICS_DIR", "data/flow-debug")).resolve()
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
            await self._click(agent)
        agent_switch = self.page.get_by_role("switch", name=re.compile(r"^(agent|tác nhân)$", re.I)).filter(visible=True).first
        if await agent_switch.count() and await agent_switch.is_checked():
            await self._click(agent_switch)
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
            await self._click(models.last)
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
        await self.page.evaluate("() => { const target = document.activeElement || document.body; target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true })); }")

    async def _ensure_flow_project_ready(self):
        self.last_stage = "FLOW_PROJECT_READY"
        if self.page is None or not is_flow_url(self.page.url) or not re.search(r"/project/[^/]+", urlparse(self.page.url).path):
            raise FlowError("FLOW_PROJECT_INVALID", "Chưa mở đúng project Flow.")
        if self.project_url and not is_flow_url(self.project_url):
            raise FlowError("FLOW_PROJECT_INVALID", "URL project Flow không hợp lệ.")
        # The current project owns model/aspect/count. Never open settings in the hot path.

    async def _ensure_composer_ready(self):
        self.last_stage = "FLOW_PROMPT_FIND"
        result = await self.page.evaluate(COMPOSER_SCRIPT, {"action": "probe"})
        self.composer_ready = bool(result.get("composerReady"))
        self.generation_ready = bool(result.get("generationReady"))
        self.observed_models = result.get("modelLabels", [])
        if len(self.observed_models) == 1:
            match = re.search(r"nano banana(?:\s+(?:pro|2))?|imagen(?:\s*\d+(?:\.\d+)?)?|veo(?:\s*\d+(?:\.\d+)?)?", self.observed_models[0], re.I)
            self.observed_model = match[0] if match else None
        else:
            self.observed_model = None
        if not result.get("ok"):
            raise FlowError(result.get("code", "FLOW_COMPOSER_NOT_FOUND"), result.get("error", "Không tìm thấy composer Flow."), stage=self.last_stage)
        return result

    async def _composer(self, action, **options):
        result = await self.page.evaluate(FLOW_COMPOSER_SCRIPT, {"action": action, **options})
        if result.get("trustedClick"):
            # Real pointer events are required by Flow's button/gesture handlers.
            try:
                await self.page.locator('[data-storyflow-submit="true"]').click(timeout=5000)
            except PlaywrightTimeout as error:
                raise FlowError("FLOW_SUBMIT_FAILED", f"Generate pointer click failed: {error}", stage=self.last_stage) from error
        self.flow_diagnostics.setdefault("snapshots", []).append({"stage": self.last_stage, **result})
        if result.get("error"):
            raise FlowError(result.get("code", "FLOW_SUBMIT_FAILED"), result["error"], stage=self.last_stage)
        return result

    async def _debug_snapshot(self, name):
        if os.getenv("FLOW_DEBUG") != "1":
            return
        if not getattr(self, "debug_directory", None):
            self.debug_directory = Path(os.getenv("FLOW_DIAGNOSTICS_DIR", "data/flow-debug")).resolve() / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid4().hex[:8]}"
        try:
            self.debug_directory.mkdir(parents=True, exist_ok=True)
        except Exception as error:
            self.flow_diagnostics.setdefault("captureErrors", []).append(f"directory: {error}")
            return
        for kind in ("html", "png"):
            try:
                target = self.debug_directory / (name + ("-submit.html" if kind == "html" else ".png"))
                if kind == "html":
                    # Export rendered markup only, excluding embedded scripts, tokens and form secrets.
                    html = await self.page.evaluate("""() => {
                        const copy = document.documentElement.cloneNode(true);
                        copy.querySelectorAll('script,meta,input[type="hidden"],input[type="password"]').forEach(n => n.remove());
                        copy.querySelectorAll('*').forEach(n => [...n.attributes].forEach(a => {
                            if (/cookie|token|authorization|nonce|^on/i.test(a.name)) n.removeAttribute(a.name);
                        }));
                        return copy.outerHTML;
                    }""")
                    target.write_text(html, encoding="utf-8")
                else:
                    await self.page.screenshot(path=str(target), full_page=True, timeout=10000)
            except Exception as error:
                self.flow_diagnostics.setdefault("captureErrors", []).append(f"{name}/{kind}: {error}")

    async def _submit_prompt(self, prompt):
        self.flow_diagnostics = {"snapshots": [], "attempts": []}
        self.debug_directory = None
        self.last_stage = "FLOW_PROMPT_FIND"
        await self._composer("inspect")
        self.last_stage = "FLOW_PROMPT_INJECT"
        await self._composer("inject", prompt=prompt)
        self.last_stage = "FLOW_PROMPT_SYNC"
        deadline = time.monotonic() + max(0.1, float(os.getenv("FLOW_PROMPT_SYNC_TIMEOUT_MS", "10000")) / 1000)
        while True:
            current = await self._composer("inspect")
            if current.get("promptValue") == prompt and current.get("submitEnabled"):
                break
            if time.monotonic() >= deadline:
                if current.get("promptValue") != prompt:
                    raise FlowError("FLOW_PROMPT_INJECT_FAILED", "Flow không giữ nguyên prompt sau input.", stage=self.last_stage)
                code = "FLOW_SUBMIT_BUTTON_NOT_FOUND" if not current.get("submitFound") else "FLOW_PROMPT_STATE_NOT_SYNCED"
                raise FlowError(code, "Prompt đã xuất hiện trong DOM nhưng Flow chưa nhận state nội bộ.", stage=self.last_stage)
            await self.page.wait_for_timeout(100)
        self.flow_diagnostics["promptSynced"] = True
        self.last_stage = "FLOW_SUBMIT_DISCOVER"
        self.submit_before = await self._composer("observe")
        await self._debug_snapshot("before")
        self.last_stage = "FLOW_SUBMIT_ATTEMPT_1"
        result = await self._composer("submit", prompt=prompt)
        self.flow_diagnostics["attempts"].append(result)
        self.last_stage = "FLOW_SUBMIT_VERIFY_1"
        return result

    def _check_alerts(self, alerts):
        text = alerts.lower()
        if any(word in text for word in ("insufficient credits", "not enough credits", "out of credits", "hết tín dụng", "không đủ tín dụng")):
            raise FlowError("FLOW_CREDIT_EXHAUSTED", alerts, stage=self.last_stage)
        if any(word in text for word in ("too many requests", "rate limit", "try again later", "thử lại sau")):
            raise FlowError("FLOW_LIMIT", alerts, stage=self.last_stage)
        if any(word in text for word in ("generation failed", "couldn't generate", "could not generate", "không thể tạo", "failed to generate")):
            raise FlowError("FLOW_RESULT_NOT_FOUND", alerts, stage=self.last_stage)

    async def _wait_generation_started(self, before, prompt):
        baseline = getattr(self, "submit_before", before)
        timeout = max(0.1, float(os.getenv("FLOW_GENERATION_START_TIMEOUT_MS", "15000")) / 1000)
        started_at = time.monotonic()
        deadline = started_at + timeout
        next_sample = iter((0.5, 1, 2, 5))
        sample_at = next(next_sample, None)
        attempts = self.flow_diagnostics["attempts"]
        while time.monotonic() < deadline:
            await self._auth_check()
            current = await self.page.evaluate(FLOW_COMPOSER_SCRIPT, {"action": "snapshot", "before": baseline, "prompt": prompt})
            self.flow_diagnostics["latest"] = current
            self._check_alerts(current["alerts"])
            elapsed = time.monotonic() - started_at
            if sample_at is not None and elapsed >= sample_at:
                self.flow_diagnostics["snapshots"].append({"elapsed": elapsed, "stage": self.last_stage, **current})
                sample_at = next(next_sample, None)
            if current["started"] or self._generation_request_seen:
                self.last_stage = "FLOW_GENERATING"
                self.flow_diagnostics["generationStarted"] = True
                self.flow_diagnostics["networkRequestSeen"] = self._generation_request_seen
                await self._debug_snapshot("after")
                return current
            if elapsed >= 3 and len(attempts) == 1 and current.get("safeToRetry") and not self._generation_request_seen:
                methods = attempts[0].get("methods", [])
                alternative = next((m for m in methods if m != attempts[0]["method"]), None)
                if alternative:
                    self.last_stage = "FLOW_SUBMIT_ATTEMPT_2"
                    attempts.append(await self._composer("submit", prompt=prompt, method=alternative))
            if elapsed >= 3:
                self.last_stage = "FLOW_GENERATION_START_WAIT"
            await self.page.wait_for_timeout(100)
        self.last_stage = "FLOW_GENERATION_START_WAIT"
        raise FlowError("FLOW_GENERATION_START_TIMEOUT", "Submit đã được thử nhưng chưa có tín hiệu generation; dừng để tránh tạo trùng.", stage=self.last_stage)

    async def _wait_new_image(self, before, prompt):
        self.last_stage = "FLOW_RESULT_WAIT"
        deadline = time.monotonic() + max(0.1, float(os.getenv("FLOW_GENERATION_TIMEOUT_MS", "420000")) / 1000)
        while time.monotonic() < deadline:
            await self._auth_check()
            current = await self.page.evaluate(MONITOR_SCRIPT, {"before": before, "prompt": prompt})
            self._check_alerts(current["alerts"])
            if current["fresh"]:
                return current["fresh"][-1]
            await self.page.wait_for_timeout(500)
        raise FlowError("FLOW_GENERATION_TIMEOUT", "Flow đã nhận prompt nhưng chưa có ảnh mới trong thời gian chờ.", stage=self.last_stage)

    async def _download_image(self, image):
        import base64
        self.last_stage = "FLOW_RESULT_DOWNLOAD"
        src = image["src"]
        if not src.startswith(("blob:", "data:image/")):
            asset = urlparse(src)
            host = asset.hostname or ""
            if asset.scheme != "https" or not any(host == base or host.endswith("." + base) for base in ("googleusercontent.com", "googleapis.com", "labs.google", "flow.google.com", "flow-content.google")):
                raise FlowError("FLOW_RESULT_DOWNLOAD_FAILED", "Máy chủ ảnh Flow không được hỗ trợ.", stage=self.last_stage)
        # Binary bytes stay in RAM; base64 is only transient Playwright transport, never state/DB.
        result = await self.page.evaluate("""async src => {
            try {
                const response = await fetch(src, { signal: AbortSignal.timeout(30000) });
                if (!response.ok) return { error: 'HTTP ' + response.status };
                const blob = await response.blob();
                if (!blob.type.startsWith('image/') || blob.size > 40000000) return { error: 'Invalid image MIME/size' };
                const data = await new Promise((resolve, reject) => {
                    const reader = new FileReader(); reader.onload = () => resolve(reader.result);
                    reader.onerror = reject; reader.readAsDataURL(blob);
                });
                return { data };
            } catch (error) { return { error: error.message }; }
        }""", src)
        if result.get("data"):
            match = re.fullmatch(r"data:(image/[\w.+-]+);base64,(.+)", result["data"], re.S)
            if not match:
                raise FlowError("FLOW_RESULT_DOWNLOAD_FAILED", "Flow không trả dữ liệu ảnh hợp lệ.", stage=self.last_stage)
            mime, content = match[1], base64.b64decode(match[2], validate=True)
        elif src.startswith("https:"):
            response = await self.context.request.get(src, timeout=30000, max_redirects=0)
            if not response.ok:
                raise FlowError("FLOW_RESULT_DOWNLOAD_FAILED", f"Ảnh Flow trả HTTP {response.status}.", stage=self.last_stage)
            mime = response.headers.get("content-type", "").split(";")[0]
            content = await response.body()
        else:
            raise FlowError("FLOW_RESULT_DOWNLOAD_FAILED", result.get("error", "Không tải được ảnh Flow."), stage=self.last_stage)
        if not mime.startswith("image/") or not 10000 <= len(content) <= 40000000:
            raise FlowError("FLOW_RESULT_DOWNLOAD_FAILED", "Ảnh Flow có kích thước hoặc MIME không hợp lệ.", stage=self.last_stage)
        return content, mime

    async def generate_image(self, prompt, aspect="16:9"):
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 50000:
            raise FlowError("INVALID_PROMPT", "Prompt phải có nội dung và tối đa 50.000 ký tự.")
        if aspect not in ("16:9", "9:16"):
            raise FlowError("INVALID_ASPECT", "Tỷ lệ ảnh không hợp lệ.")
        if self.state not in ("ready", "project_required") or self.page is None:
            raise FlowError("FLOW_LOGIN_REQUIRED", "Phiên Flow chưa sẵn sàng.")
        self.state = "generating"
        self._generation_request_seen = False
        self.flow_diagnostics = {}
        self.debug_directory = None
        def observe_request(request):
            host = urlparse(request.url).hostname or ""
            if request.method != "POST" or not any(host == base or host.endswith("." + base) for base in ("googleapis.com", "labs.google", "flow.google.com")):
                return
            try:
                data = request.post_data_json
            except (ValueError, TypeError):
                return
            def contains_prompt(value):
                if isinstance(value, str):
                    return value == prompt.strip()
                if isinstance(value, dict):
                    return any(contains_prompt(item) for item in value.values())
                if isinstance(value, list):
                    return any(contains_prompt(item) for item in value)
                return False
            if re.search(r"generate|generation|batchGenerate|createImage", urlparse(request.url).path, re.I) and contains_prompt(data):
                self._generation_request_seen = True
        self.page.on("request", observe_request)
        try:
            self.last_stage = "FLOW_AUTH"
            await self._auth_check()
            self.session_ready = True
            await self._ensure_flow_project_ready()
            await self._ensure_composer_ready()
            before = await self.page.evaluate(MONITOR_SCRIPT, {})
            submitted = await self._submit_prompt(prompt.strip())
            await self._wait_generation_started(before, prompt.strip())
            image = await self._wait_new_image(before, prompt.strip())
            content, mime = await self._download_image(image)
            self.state, self.last_error, self.last_stage = "ready", "", "FLOW_RESULT_READY"
            self.flow_diagnostics.update({"stage": self.last_stage, "imageBytes": len(content), "mime": mime})
            if os.getenv("FLOW_DEBUG") == "1" and self.debug_directory:
                try:
                    (self.debug_directory / "state.json").write_text(json.dumps(self.flow_diagnostics, ensure_ascii=False, indent=2), encoding="utf-8")
                except OSError:
                    pass
            return content, mime
        except Exception as cause:
            code = cause.code if isinstance(cause, FlowError) else "FLOW_UI_CHANGED"
            stage = cause.stage if isinstance(cause, FlowError) else self.last_stage
            self.last_stage = stage
            diagnostics = None
            if os.getenv("FLOW_DEBUG") == "1":
                await self._debug_snapshot("after")
                self.flow_diagnostics.update({"stage": stage, "error": str(cause), "code": code})
                target = self.debug_directory / "state.json"
                try:
                    target.write_text(json.dumps(self.flow_diagnostics, ensure_ascii=False, indent=2), encoding="utf-8")
                    diagnostics = {"directory": str(self.debug_directory), "state": str(target)}
                except OSError as error:
                    diagnostics = {"captureErrors": [str(error)]}
            if code in ("FLOW_COOKIE_EXPIRED", "FLOW_LOGIN_REQUIRED"):
                self.state = "login_required"
                self.session_ready = self.composer_ready = self.generation_ready = False
            else:
                self.state = "ready" if self.session_ready else "error"
                if code in ("FLOW_COMPOSER_NOT_FOUND", "FLOW_UI_CHANGED", "FLOW_SUBMIT_FAILED", "FLOW_GENERATION_NOT_STARTED", "FLOW_GENERATION_START_TIMEOUT", "FLOW_PROMPT_STATE_NOT_SYNCED", "FLOW_SUBMIT_BUTTON_NOT_FOUND", "FLOW_SUBMIT_BUTTON_DISABLED", "FLOW_LIMIT", "FLOW_CREDIT_EXHAUSTED"):
                    self.generation_ready = False
            self.last_error = f"[{code}] {cause}"
            raise FlowError(code, str(cause), stage=stage, diagnostics=diagnostics) from cause
        finally:
            self.page.remove_listener("request", observe_request)
            try:
                await self.page.evaluate(FLOW_COMPOSER_SCRIPT, {"action": "stop"})
            except Exception:
                pass

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
        self.session_ready = self.composer_ready = self.generation_ready = False
        self.last_stage = "FLOW_DISCONNECTED"
