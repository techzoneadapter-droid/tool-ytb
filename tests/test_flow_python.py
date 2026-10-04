import json
import sys
import os
import socket
import subprocess
import time
import urllib.request
import urllib.error
import unittest
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workers"))
from flow_automation import FlowAutomation, FlowError, normalize_cookies


class ServerTests(unittest.TestCase):
    def test_http_contract_and_origin_guard(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        process = subprocess.Popen([sys.executable, "workers/flow_server.py"],
            env={**os.environ, "FLOW_BRIDGE_URL": base, "FLOW_PROJECT_URL": ""},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            deadline = time.monotonic() + 15
            while True:
                try:
                    with urllib.request.urlopen(base + "/health", timeout=1) as response:
                        health = json.load(response)
                    break
                except (OSError, urllib.error.URLError):
                    if time.monotonic() > deadline:
                        self.fail("Flow Python HTTP server did not start")
                    time.sleep(0.1)
            self.assertEqual(health["protocol"], 16)
            self.assertFalse(health["connected"])
            self.assertTrue(health["background"])
            for endpoint, data, headers, expected, code in (
                ("/session", {"cookieJson": "bad"}, {}, 400, "INVALID_COOKIES"),
                ("/generate", {"prompt": "forest"}, {}, 409, "SESSION_REQUIRED"),
                ("/session", {"cookieJson": "bad"}, {"Origin": "https://example.test"}, 403, None),
            ):
                request = urllib.request.Request(base + endpoint, data=json.dumps(data).encode(),
                    headers={"Content-Type": "application/json", **headers}, method="POST")
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(request, timeout=3)
                self.assertEqual(caught.exception.code, expected)
                body = json.load(caught.exception)
                caught.exception.close()
                if code:
                    self.assertEqual(body["code"], code)
        finally:
            process.terminate()
            process.wait(timeout=10)


class CookieTests(unittest.TestCase):
    def test_export_conversion(self):
        raw = [{"name": "SID", "value": "test-only", "domain": ".google.com", "path": "/",
                "expirationDate": 2000.5, "sameSite": "no_restriction", "secure": True,
                "httpOnly": True, "hostOnly": False, "storeId": "0"}]
        result = normalize_cookies(json.dumps(raw), now=1000)[0]
        self.assertEqual(result["expires"], 2000.5)
        self.assertEqual(result["sameSite"], "None")
        self.assertNotIn("expirationDate", result)
        self.assertNotIn("storeId", result)

    def test_session_and_stale_cookies(self):
        result = normalize_cookies(json.dumps([
            {"name": "old", "value": "x", "domain": ".google.com", "expirationDate": 1},
            {"name": "live", "value": "x", "domain": ".google.com", "session": True,
             "expirationDate": 1, "sameSite": "unspecified"}]), now=1000)
        self.assertEqual(len(result), 1)
        self.assertNotIn("expires", result[0])
        self.assertNotIn("sameSite", result[0])

    def test_expired_export(self):
        with self.assertRaises(FlowError) as caught:
            normalize_cookies('[{"name":"SID","value":"x","domain":".google.com","expirationDate":1}]', now=1000)
        self.assertEqual(caught.exception.code, "COOKIE_EXPIRED")

    def test_invalid_data_does_not_expose_values(self):
        for raw in ("broken", "{}", "[]", '[{"name":"SID","value":"secret","domain":"evil.test"}]',
                    '[{"name":"SID","value":"secret","domain":".google.com","expirationDate":true}]'):
            with self.subTest(raw=raw), self.assertRaises(FlowError) as caught:
                normalize_cookies(raw)
            self.assertNotIn("secret", str(caught.exception))


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_launch_is_headless_and_cookies_imported(self):
        session = FlowAutomation(project_url="https://flow.google.com/project/demo")
        browser, context, page = AsyncMock(), AsyncMock(), AsyncMock()
        page.goto.return_value = None
        context.new_page.return_value = page
        browser.new_context.return_value = context
        pw = AsyncMock()
        pw.chromium.launch.return_value = browser
        starter = MagicMock(start=AsyncMock(return_value=pw))
        editor = MagicMock(wait_for=AsyncMock())
        with patch("flow_automation.async_playwright", return_value=starter), patch.object(session, "_auth_check", AsyncMock()), patch.object(session, "_editor", return_value=editor):
            result = await session.initialize_session('[{"name":"SID","value":"test-only","domain":".google.com"}]')
            self.assertTrue(result["connected"])
            self.assertTrue(pw.chromium.launch.call_args.kwargs["headless"])
            context.add_cookies.assert_awaited_once()
            self.assertEqual(page.goto.call_args_list[0].args[0], "https://flow.google.com")
            await session.close()
            browser.close.assert_awaited_once()
            context.close.assert_awaited_once()

    async def test_invalid_replacement_clears_old_session(self):
        session = FlowAutomation()
        session.context, session.browser = AsyncMock(), AsyncMock()
        context = session.context
        with self.assertRaises(FlowError):
            await session.initialize_session("bad")
        context.close.assert_awaited_once()
        self.assertFalse(session.health()["connected"])
        self.assertIsNone(session.browser)

    async def test_login_redirect_is_error(self):
        session = FlowAutomation()
        session.page = MagicMock()
        session.page.is_closed.return_value = False
        session.page.url = "https://accounts.google.com/v3/signin/identifier"
        with self.assertRaises(FlowError) as caught:
            await session._auth_check()
        self.assertEqual(caught.exception.code, "COOKIE_EXPIRED")

    async def test_generation_requires_session(self):
        with self.assertRaises(FlowError) as caught:
            await FlowAutomation().generate_image("forest")
        self.assertEqual(caught.exception.code, "SESSION_REQUIRED")

    async def test_configuration_failure_keeps_stage_and_artifacts(self):
        session = FlowAutomation()
        session.page = AsyncMock()
        session.page.url = "https://flow.google.com/project/test"
        session.page.content.return_value = "<html>actual failure state</html>"
        async def fail(aspect):
            session.config_stage = "FLOW_CONFIG_RATIO"
            raise RuntimeError("locator click timeout: original detail")
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"FLOW_DIAGNOSTICS_DIR": directory}), patch.object(session, "_configure_controls", fail):
            with self.assertRaises(FlowError) as caught:
                await session._configure("16:9")
            error = caught.exception
            self.assertEqual(error.code, "FLOW_CONFIG_RATIO")
            self.assertEqual(error.stage, "FLOW_CONFIG_RATIO")
            self.assertIn("locator click timeout: original detail", str(error))
            self.assertEqual(Path(error.diagnostics["html"]).read_text(encoding="utf-8"), "<html>actual failure state</html>")
            metadata = json.loads(Path(error.diagnostics["metadata"]).read_text(encoding="utf-8"))
            self.assertEqual(metadata["aspect"], "16:9")
            self.assertIn("RuntimeError", metadata["traceback"])
            session.page.screenshot.assert_awaited_once()

    async def test_diagnostic_failure_does_not_replace_configuration_error(self):
        session = FlowAutomation()
        session.page = AsyncMock()
        session.page.url = "https://flow.google.com/project/test"
        session.page.screenshot.side_effect = RuntimeError("browser closed")
        session.page.content.side_effect = RuntimeError("browser closed")
        async def fail(aspect):
            session.config_stage = "FLOW_CONFIG_MODEL"
            raise FlowError("MODEL_UNAVAILABLE", "requested model missing")
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"FLOW_DIAGNOSTICS_DIR": directory}), patch.object(session, "_configure_controls", fail):
            with self.assertRaises(FlowError) as caught:
                await session._configure("16:9")
            self.assertEqual(caught.exception.code, "FLOW_CONFIG_MODEL")
            self.assertIn("MODEL_UNAVAILABLE: requested model missing", str(caught.exception))
            self.assertEqual(len(caught.exception.diagnostics["captureErrors"]), 2)

    async def test_synthetic_composer_smoke_only(self):
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel="chrome", headless=True)
            try:
                context = await browser.new_context()
                page = await context.new_page()
                await page.route("https://flow.google.com/**", lambda route: route.fulfill(content_type="text/html", body="<body></body>"))
                await page.goto("https://flow.google.com/project/test")
                await page.set_content('''<div class="ProseMirror" contenteditable="true"></div>
                  <button class="settings-trigger-button" aria-label="Điều kiện kích hoạt cài đặt">🍌 Nano Banana Pro</button>
                  <section id="menu" hidden><button>Ảnh</button><button>🍌 Nano Banana Pro</button><button>16:9</button><button>x1</button></section>
                  <button aria-label="Bắt đầu tạo" disabled>arrow_forward</button>
                  <script>
                  document.querySelector('.settings-trigger-button').onclick=()=>document.querySelector('#menu').hidden=false;
                  document.querySelector('.ProseMirror').oninput=()=>document.querySelector('[aria-label="Bắt đầu tạo"]').disabled=false;
                  document.querySelector('[aria-label="Bắt đầu tạo"]').onclick=()=>{
                    const c=document.createElement('canvas');c.width=768;c.height=432;
                    const ctx=c.getContext('2d');const d=ctx.createImageData(768,432);
                    for(let i=0;i<d.data.length;i++)d.data[i]=Math.random()*255;
                    ctx.putImageData(d,0,0);const img=new Image();img.src=c.toDataURL();document.body.append(img);
                  };
                  </script>''')
                session = FlowAutomation()
                session.page, session.context, session.browser, session.state = page, context, browser, "ready"
                content, mime = await session.generate_image("A forest")
                self.assertEqual(mime, "image/png")
                self.assertGreater(len(content), 10000)
                self.assertEqual(await page.locator(".ProseMirror").inner_text(), "A forest")
            finally:
                await browser.close()


if __name__ == "__main__":
    unittest.main()
