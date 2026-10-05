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
from flow_automation import FlowAutomation, FlowError, normalize_cookies, COMPOSER_SCRIPT, MONITOR_SCRIPT


class ServerTests(unittest.TestCase):
    def test_http_contract_and_origin_guard(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        process = subprocess.Popen([sys.executable, "workers/flow_server.py"],
            env={**os.environ, "FLOW_BRIDGE_URL": base, "FLOW_PROJECT_URL": "", "FLOW_COOKIES_FILE": str(Path("data") / "test-absent-cookies.json")},
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
            self.assertEqual(health["protocol"], 22)
            self.assertFalse(health["connected"])
            self.assertTrue(health["background"])
            for endpoint, data, headers, expected, code in (
                ("/session", {"cookieJson": "bad"}, {}, 400, "INVALID_COOKIES"),
                ("/generate", {"prompt": "forest"}, {}, 401, "FLOW_LOGIN_REQUIRED"),
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
        self.assertEqual(caught.exception.code, "FLOW_COOKIE_EXPIRED")

    def test_invalid_data_does_not_expose_values(self):
        for raw in ("broken", "{}", "[]", '[{"name":"SID","value":"secret","domain":"evil.test"}]',
                    '[{"name":"SID","value":"secret","domain":".google.com","expirationDate":true}]'):
            with self.subTest(raw=raw), self.assertRaises(FlowError) as caught:
                normalize_cookies(raw)
            self.assertNotIn("secret", str(caught.exception))


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_generate_http_response_is_binary_and_never_an_image_file(self):
        import flow_server
        session = MagicMock()
        session.state = 'ready'
        session.observed_model = 'Nano Banana Pro'
        content = b'\x89PNG\r\n\x1a\n' + b'fixture' * 2000
        session.generate_image = AsyncMock(return_value=(content, 'image/png'))
        with patch.object(flow_server, 'session', session), patch.object(flow_server, 'payload', AsyncMock(return_value={'prompt': 'test'})):
            response = await flow_server.generate(MagicMock())
        self.assertEqual(response.body, content)
        self.assertEqual(response.media_type, 'image/png')
        self.assertEqual(response.headers['x-storyflow-model'], 'Nano Banana Pro')

    async def test_form_submit_native_setter_events_and_no_private_handler(self):
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel="chrome", headless=True)
            try:
                page = await browser.new_page()
                await page.set_content('<form><textarea required></textarea><button type="submit">Generate</button></form>')
                await page.evaluate("""() => {
                    window.events = []; window.sent = 0;
                    const editor = document.querySelector('textarea');
                    const proto = HTMLTextAreaElement.prototype;
                    Object.defineProperty(editor, 'value', { get: () => Object.getOwnPropertyDescriptor(proto, 'value').get.call(editor), set: () => { throw Error('must use native setter'); } });
                    for (const name of ['beforeinput', 'input', 'change']) editor.addEventListener(name, () => window.events.push(name));
                    document.querySelector('button').__reactProps$fixture = { onClick() { throw Error('private props must be the last fallback'); } };
                    document.querySelector('form').onsubmit = event => { event.preventDefault(); window.sent++; window.prompt = editor.value; };
                }""")
                session = FlowAutomation(); session.page = page
                result = await session._submit_prompt('React-style textarea')
                self.assertEqual(result['method'], 'requestSubmit')
                self.assertEqual(await page.evaluate('window.sent'), 1)
                self.assertEqual(await page.evaluate('window.prompt'), 'React-style textarea')
                self.assertEqual(await page.evaluate('window.events'), ['beforeinput', 'input', 'change'])
            finally:
                await browser.close()

    async def test_noop_submit_is_not_reported_as_generation_and_debug_is_opt_in(self):
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel="chrome", headless=True)
            try:
                context = await browser.new_context(); page = await context.new_page()
                await page.route('https://flow.google.com/**', lambda route: route.fulfill(body='<textarea></textarea><button>Generate</button>', content_type='text/html'))
                await page.goto('https://flow.google.com/project/test')
                session = FlowAutomation(); session.page = page; session.state = 'ready'
                with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'FLOW_GENERATION_START_TIMEOUT_MS': '150', 'FLOW_DEBUG': '0', 'FLOW_DIAGNOSTICS_DIR': directory}):
                    with self.assertRaises(FlowError) as caught:
                        await session.generate_image('Do not claim success')
                    self.assertEqual(caught.exception.code, 'FLOW_GENERATION_START_TIMEOUT')
                    self.assertEqual(caught.exception.stage, 'FLOW_GENERATION_START_WAIT')
                    self.assertIsNone(caught.exception.diagnostics)
                    self.assertEqual(list(Path(directory).iterdir()), [])
            finally:
                await browser.close()

    async def test_new_image_ignores_old_avatar_and_recreated_old_source(self):
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel='chrome', headless=True)
            try:
                context = await browser.new_context(); page = await context.new_page()
                await page.route('https://flow.google.com/**', lambda route: route.fulfill(body='<textarea></textarea><button>Generate</button>', content_type='text/html'))
                await page.goto('https://flow.google.com/project/test')
                await page.evaluate("""async () => {
                    window.makeImage = async (alt = '') => {
                        const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = 512;
                        const context = canvas.getContext('2d'); const pixels = context.createImageData(768,512);
                        for (let index = 0; index < pixels.data.length; index++) pixels.data[index] = Math.random()*255;
                        context.putImageData(pixels,0,0);
                        const image = new Image(); image.alt = alt; image.src = canvas.toDataURL(); document.body.append(image); await image.decode(); return image;
                    };
                    window.oldImage = await window.makeImage();
                    await window.makeImage('avatar');
                }""")
                before = await page.evaluate(MONITOR_SCRIPT, {})
                self.assertEqual(len(before['images']), 1)
                await page.evaluate("async () => { const copy = new Image(); copy.src = window.oldImage.src; document.body.append(copy); await copy.decode(); }")
                self.assertEqual((await page.evaluate(MONITOR_SCRIPT, {'before': before, 'prompt': 'test'}))['fresh'], [])
                await page.evaluate("document.querySelector('button').onclick = async () => { window.newImage = await window.makeImage(); }")
                session = FlowAutomation(); session.page = page; session.context = context; session.state = 'ready'
                with patch.object(session, '_configure', AsyncMock(side_effect=AssertionError('configuration must not run'))) as configure:
                    content, mime = await session.generate_image('test')
                    configure.assert_not_awaited()
                import base64
                expected = await page.evaluate('window.newImage.src')
                self.assertEqual(content, base64.b64decode(expected.split(',', 1)[1]))
                self.assertEqual(mime, 'image/png')
                self.assertTrue(session.health()['generationReady'])
            finally:
                await browser.close()

    async def test_health_distinguishes_session_from_missing_composer(self):
        session = FlowAutomation(); session.session_ready = True
        session.page = AsyncMock()
        session.page.evaluate.return_value = {'error': 'No editor', 'code': 'FLOW_COMPOSER_NOT_FOUND'}
        with self.assertRaises(FlowError): await session._ensure_composer_ready()
        self.assertTrue(session.health()['sessionReady'])
        self.assertTrue(session.health()['connected'])
        self.assertFalse(session.health()['composerReady'])
        self.assertFalse(session.health()['generationReady'])

    async def test_launch_is_headless_and_cookies_imported(self):
        session = FlowAutomation(project_url="https://flow.google.com/project/demo")
        session.cookie_file = MagicMock()
        browser, context, page = AsyncMock(), AsyncMock(), AsyncMock()
        page.goto.return_value = None
        context.new_page.return_value = page
        browser.new_context.return_value = context
        pw = AsyncMock()
        pw.chromium.launch.return_value = browser
        starter = MagicMock(start=AsyncMock(return_value=pw))
        editor = MagicMock(wait_for=AsyncMock())
        with patch("flow_automation.async_playwright", return_value=starter), patch.object(session, "_auth_check", AsyncMock()), patch.object(session, "_editor", return_value=editor), patch.object(session, "_ensure_composer_ready", AsyncMock()), patch.object(session, "_save_cookies") as save:
            result = await session.initialize_session('[{"name":"SID","value":"test-only","domain":".google.com"}]')
            self.assertTrue(result["connected"])
            self.assertTrue(pw.chromium.launch.call_args.kwargs["headless"])
            context.add_cookies.assert_awaited_once()
            save.assert_called_once()
            self.assertEqual(page.goto.call_args_list[0].args[0], "https://flow.google.com")
            await session.close()
            browser.close.assert_awaited_once()
            context.close.assert_awaited_once()

    async def test_cookie_file_restore_is_validated_and_not_rewritten(self):
        session = FlowAutomation()
        with tempfile.TemporaryDirectory() as directory:
            session.cookie_file = Path(directory) / "cookies.json"
            session.session_file = Path(directory) / "session.json"
            cookies = [{"name": "SID", "value": "test-only", "domain": ".google.com"}]
            session._save_cookies(cookies)
            self.assertEqual(json.loads(session.cookie_file.read_text()), cookies)
            with patch.object(session, "initialize_session", AsyncMock(return_value={"connected": True})) as initialize:
                result = await session.restore_session()
                self.assertTrue(result["connected"])
                initialize.assert_awaited_once_with(session.cookie_file.read_text(), persist=False)

    async def test_evaluate_composer_prefers_dom_once_and_rejects_ambiguity(self):
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel="chrome", headless=True)
            try:
                page = await browser.new_page()
                await page.set_content('<textarea></textarea><button aria-label="Generate" disabled></button>')
                await page.evaluate("""() => {
                    window.submissions = 0;
                    const button = document.querySelector('button');
                    document.querySelector('textarea').addEventListener('input', () => button.disabled = false);
                    button.__reactProps$test = { onClick(event) {
                        event.preventDefault();
                        window.submissions++;
                        window.submitted = document.querySelector('textarea').value;
                    }};
                    button.onclick = () => { window.submissions++; window.submitted = document.querySelector('textarea').value; };
                }""")
                session = FlowAutomation()
                session.page = page
                result = await session._submit_prompt('A forest')
                self.assertEqual(result['method'], 'dom-click')
                self.assertEqual(await page.evaluate('window.submissions'), 1)
                self.assertEqual(await page.evaluate('window.submitted'), 'A forest')
                await page.evaluate("document.body.appendChild(document.createElement('textarea'))")
                with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"FLOW_DEBUG": "1", "FLOW_DIAGNOSTICS_DIR": directory}):
                    with self.assertRaises(FlowError) as caught:
                        await session._submit_prompt('Do not submit')
                    self.assertEqual(caught.exception.code, 'FLOW_COMPOSER_NOT_FOUND')
                    self.assertEqual(await page.evaluate('window.submissions'), 1)
            finally:
                await browser.close()

    async def test_structural_generation_signals_and_unrelated_mutations(self):
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel="chrome", headless=True)
            try:
                page = await browser.new_page()
                for trigger in ("clear", "disabled", "spinner", "placeholder", "unrelated"):
                    with self.subTest(trigger=trigger):
                        await page.set_content('<div><textarea></textarea><button aria-label="Generate">Generate</button></div>')
                        await page.evaluate(COMPOSER_SCRIPT, {"action": "inject", "prompt": "forest"})
                        before = await page.evaluate(COMPOSER_SCRIPT, {"action": "observe"})
                        await page.evaluate("""trigger => {
                            if (trigger === 'clear') document.querySelector('textarea').value = '';
                            if (trigger === 'disabled') document.querySelector('button').disabled = true;
                            if (trigger === 'spinner') { const n = document.createElement('div'); n.className = 'spinner'; n.textContent = '...'; document.body.append(n); }
                            if (trigger === 'placeholder') { const n = document.createElement('div'); n.dataset.testid = 'media-placeholder'; n.textContent = '...'; document.body.append(n); }
                            if (trigger === 'unrelated') { const n = document.createElement('div'); n.textContent = 'clock update'; document.body.append(n); }
                        }""", trigger)
                        result = await page.evaluate(COMPOSER_SCRIPT, {"action": "snapshot", "before": before, "prompt": "forest"})
                        self.assertEqual(result['generationStarted'], trigger != 'unrelated')
                        if trigger == 'unrelated':
                            self.assertGreater(result['signals']['mutationCount'], 0)
                            self.assertFalse(result['safeToRetry'])
            finally:
                await browser.close()

    async def test_contenteditable_input_sync_and_disabled_state_error(self):
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel="chrome", headless=True)
            try:
                page = await browser.new_page()
                await page.set_content('<div class="ProseMirror" contenteditable="true">old prompt</div><button aria-label="Generate" disabled>Generate</button>')
                await page.evaluate("""() => document.querySelector('.ProseMirror').oninput = event => {
                    window.received = event.target.textContent;
                    document.querySelector('button').disabled = false;
                }""")
                session = FlowAutomation(); session.page = page
                await session._submit_prompt('new forest')
                self.assertEqual(await page.evaluate('window.received'), 'new forest')
                self.assertTrue(session.flow_diagnostics['promptSynced'])
                await page.evaluate("""() => { document.querySelector('.ProseMirror').oninput = null; document.querySelector('button').disabled = true; }""")
                with patch.dict(os.environ, {'FLOW_PROMPT_SYNC_TIMEOUT_MS': '100'}):
                    with self.assertRaises(FlowError) as caught:
                        await session._submit_prompt('still disabled')
                    self.assertEqual(caught.exception.code, 'FLOW_PROMPT_STATE_NOT_SYNCED')
                    self.assertEqual(caught.exception.stage, 'FLOW_PROMPT_SYNC')
            finally:
                await browser.close()

    async def test_noop_request_submit_retries_click_once_and_detects_start(self):
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel="chrome", headless=True)
            try:
                page = await browser.new_page()
                for start in (True, False):
                    await page.set_content('<form><textarea></textarea><button type="submit">Generate</button></form>')
                    await page.evaluate("""start => {
                        window.forms = 0; window.clicks = 0;
                        document.querySelector('form').onsubmit = e => { e.preventDefault(); window.forms++; };
                        document.querySelector('button').onclick = () => { window.clicks++; if (start) document.querySelector('textarea').value = ''; };
                    }""", start)
                    session = FlowAutomation(); session.page = page
                    before = await page.evaluate(MONITOR_SCRIPT, {})
                    await session._submit_prompt('forest')
                    with patch.object(session, '_auth_check', AsyncMock()), patch.dict(os.environ, {'FLOW_GENERATION_START_TIMEOUT_MS': '3400'}):
                        if start:
                            result = await session._wait_generation_started(before, 'forest')
                            self.assertTrue(result['generationStarted'])
                        else:
                            with self.assertRaises(FlowError) as caught:
                                await session._wait_generation_started(before, 'forest')
                            self.assertEqual(caught.exception.code, 'FLOW_GENERATION_START_TIMEOUT')
                    self.assertEqual(await page.evaluate('window.forms'), 2)
                    self.assertEqual(await page.evaluate('window.clicks'), 1)
                    self.assertEqual(len(session.flow_diagnostics['attempts']), 2)
            finally:
                await browser.close()

    async def test_click_uses_real_pointer_gesture(self):
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel="chrome", headless=True)
            try:
                page = await browser.new_page()
                await page.set_content('<textarea></textarea><button aria-label="Generate">Generate</button>')
                await page.evaluate("""() => {
                    window.sent = 0;
                    document.querySelector('button').onpointerdown = event => {
                        if (event.isTrusted) { window.sent++; document.querySelector('textarea').value = ''; }
                    };
                }""")
                session = FlowAutomation(); session.page = page
                before = await page.evaluate(MONITOR_SCRIPT, {})
                await session._submit_prompt('forest')
                with patch.object(session, '_auth_check', AsyncMock()):
                    result = await session._wait_generation_started(before, 'forest')
                self.assertTrue(result['generationStarted'])
                self.assertEqual(await page.evaluate('window.sent'), 1)
            finally:
                await browser.close()

    async def test_form_and_click_immediate_generation_no_duplicate(self):
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel="chrome", headless=True)
            try:
                page = await browser.new_page()
                for form in (True, False):
                    body = '<textarea></textarea><button type="submit" aria-label="Generate">Generate</button>'
                    await page.set_content('<form>' + body + '</form>' if form else body)
                    await page.evaluate("""form => {
                        window.sent = 0;
                        const target = document.querySelector(form ? 'form' : 'button');
                        target.addEventListener(form ? 'submit' : 'click', event => {
                            event.preventDefault(); window.sent++; document.querySelector('button').disabled = true;
                        });
                    }""", form)
                    session = FlowAutomation(); session.page = page
                    before = await page.evaluate(MONITOR_SCRIPT, {})
                    await session._submit_prompt('forest')
                    with patch.object(session, '_auth_check', AsyncMock()):
                        result = await session._wait_generation_started(before, 'forest')
                    self.assertTrue(result['signals']['buttonChanged'])
                    self.assertEqual(await page.evaluate('window.sent'), 1)
            finally:
                await browser.close()

    async def test_live_flow_content_host_download_and_untrusted_host_rejection(self):
        import base64
        session = FlowAutomation(); session.page = AsyncMock()
        content = b'fixture' * 2000
        session.page.evaluate.return_value = {'data': 'data:image/png;base64,' + base64.b64encode(content).decode()}
        actual, mime = await session._download_image({'src': 'https://flow-content.google/asset/test'})
        self.assertEqual(actual, content)
        self.assertEqual(mime, 'image/png')
        for src in ('https://flow-content.google.evil.test/test', 'http://flow-content.google/test'):
            with self.assertRaises(FlowError):
                await session._download_image({'src': src})
        self.assertEqual(session.page.evaluate.await_count, 1)

    async def test_invalid_replacement_clears_old_session(self):
        session = FlowAutomation()
        session.cookie_file = MagicMock()
        session.context, session.browser = AsyncMock(), AsyncMock()
        context = session.context
        with self.assertRaises(FlowError):
            await session.initialize_session("bad")
        context.close.assert_awaited_once()
        self.assertFalse(session.health()["connected"])
        self.assertIsNone(session.browser)

    async def test_browser_start_failure_is_a_restore_error_not_ui_changed(self):
        session = FlowAutomation()
        pw = AsyncMock()
        pw.chromium.launch.side_effect = RuntimeError("Chrome startup fixture failure")
        starter = MagicMock(start=AsyncMock(return_value=pw))
        with patch("flow_automation.async_playwright", return_value=starter):
            with self.assertRaises(FlowError) as caught:
                await session.initialize_session('[{"name":"SID","value":"fixture","domain":".google.com"}]', persist=False)
        self.assertEqual(caught.exception.code, "FLOW_SESSION_RESTORE_FAILED")
        self.assertEqual(caught.exception.stage, "FLOW_SESSION_RESTORE")
        self.assertEqual(session.state, "error")

    async def test_public_project_landing_enters_app_and_preserves_cookie_rejection(self):
        session = FlowAutomation(project_url="https://flow.google.com/project/fixture")
        pw, browser, context, page = AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock()
        page.goto.return_value = None
        page.url = "https://flow.google.com/project/fixture"
        page.evaluate.return_value = True
        entry = MagicMock()
        entry.first.click = AsyncMock()
        page.get_by_role = MagicMock(return_value=entry)
        context.pages = [page]
        context.new_page.return_value = page
        browser.new_context.return_value = context
        pw.chromium.launch.return_value = browser
        starter = MagicMock(start=AsyncMock(return_value=pw))
        rejected = FlowError("FLOW_COOKIE_EXPIRED", "Google rejected restored fixture", stage="FLOW_AUTH")
        with patch("flow_automation.async_playwright", return_value=starter), patch.object(session, "_auth_check", AsyncMock(side_effect=rejected)):
            with self.assertRaises(FlowError) as caught:
                await session.initialize_session('[{"name":"SID","value":"fixture","domain":".google.com"}]', persist=False)
        entry.first.click.assert_awaited_once()
        self.assertEqual(caught.exception.code, "FLOW_COOKIE_EXPIRED")
        self.assertEqual(session.state, "login_required")

    async def test_login_redirect_is_error(self):
        session = FlowAutomation()
        session.page = MagicMock()
        session.page.is_closed.return_value = False
        session.page.url = "https://accounts.google.com/v3/signin/identifier"
        with self.assertRaises(FlowError) as caught:
            await session._auth_check()
        self.assertEqual(caught.exception.code, "FLOW_COOKIE_EXPIRED")

    async def test_generation_requires_session(self):
        with self.assertRaises(FlowError) as caught:
            await FlowAutomation().generate_image("forest")
        self.assertEqual(caught.exception.code, "FLOW_LOGIN_REQUIRED")

    async def test_configuration_failure_keeps_stage_and_artifacts(self):
        session = FlowAutomation()
        session.page = AsyncMock()
        session.page.url = "https://flow.google.com/project/test"
        session.page.content.return_value = "<html>actual failure state</html>"
        async def fail(aspect):
            session.config_stage = "FLOW_CONFIG_RATIO"
            raise RuntimeError("locator click timeout: original detail")
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"FLOW_DEBUG": "1", "FLOW_DIAGNOSTICS_DIR": directory}), patch.object(session, "_configure_controls", fail):
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
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"FLOW_DEBUG": "1", "FLOW_DIAGNOSTICS_DIR": directory}), patch.object(session, "_configure_controls", fail):
            with self.assertRaises(FlowError) as caught:
                await session._configure("16:9")
            self.assertEqual(caught.exception.code, "FLOW_CONFIG_MODEL")
            self.assertIn("MODEL_UNAVAILABLE: requested model missing", str(caught.exception))
            self.assertEqual(len(caught.exception.diagnostics["captureErrors"]), 2)

    async def test_already_selected_image_mode_without_mode_button(self):
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel="chrome", headless=True)
            try:
                context = await browser.new_context()
                page = await context.new_page()
                await page.route("https://flow.google.com/**", lambda route: route.fulfill(content_type="text/html", body="<body></body>"))
                await page.goto("https://flow.google.com/project/test")
                await page.set_content('''<div class="ProseMirror" contenteditable="true"></div>
                  <button class="settings-trigger-button" aria-label="Nano Banana Pro">Nano Banana Pro</button>
                  <section id="menu" hidden><button>16:9</button><button>x1</button></section>
                  <button aria-label="Bắt đầu tạo" disabled>arrow_forward</button>
                  <script>
                  document.querySelector('.settings-trigger-button').onclick=()=>document.querySelector('#menu').hidden=false;
                  document.querySelector('.ProseMirror').oninput=()=>document.querySelector('[aria-label="Bắt đầu tạo"]').disabled=false;
                  document.querySelector('[aria-label="Bắt đầu tạo"]').onclick=()=>{
                    const c=document.createElement('canvas');c.width=768;c.height=512;
                    const ctx=c.getContext('2d');const d=ctx.createImageData(768,512);
                    for(let i=0;i<d.data.length;i++)d.data[i]=Math.random()*255;
                    ctx.putImageData(d,0,0);const img=new Image();img.src=c.toDataURL();document.body.append(img);
                  };
                  </script>''')
                session = FlowAutomation()
                session.page, session.context, session.browser, session.state = page, context, browser, "ready"
                content, mime = await session.generate_image("A forest")
                self.assertEqual(mime, "image/png")
                self.assertGreater(len(content), 10000)
            finally:
                await browser.close()

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
                    const c=document.createElement('canvas');c.width=768;c.height=512;
                    const ctx=c.getContext('2d');const d=ctx.createImageData(768,512);
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
