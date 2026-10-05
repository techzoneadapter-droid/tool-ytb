import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workers"))
from flow_automation import FlowAutomation, FlowError, RESULT_SCRIPT, payload_contains_prompt


class ResultTests(unittest.IsolatedAsyncioTestCase):
    async def test_error_mapping_uses_request_state_not_the_next_session_request(self):
        import json
        from types import SimpleNamespace
        import flow_server
        request = SimpleNamespace(state=SimpleNamespace(flow_request_id="flow_original", flow_chapter_id="original_chapter"))
        with patch.object(flow_server.session, 'current_request_id', 'flow_next', create=True):
            response = await flow_server.flow_error(request, FlowError("FLOW_RESULT_NOT_FOUND", "fixture"))
        body = json.loads(response.body)
        self.assertEqual(body['requestId'], 'flow_original')
        self.assertEqual(body['chapterId'], 'original_chapter')
    def test_batchexecute_nested_json_matches_only_exact_prompt(self):
        import json
        prompt = "Lâm Hạo enters forest"
        data = {"f.req": json.dumps([["rpc", json.dumps([None, {"text": "Lâm Hạo\n enters forest"}])]])}
        self.assertTrue(payload_contains_prompt(data, prompt))
        self.assertFalse(payload_contains_prompt(data, "different prompt"))
        self.assertFalse(payload_contains_prompt({"text": prompt + " unrelated"}, prompt))
    async def test_chapter_enforces_x1_without_changing_model(self):
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel="chrome", headless=True)
            try:
                page = await browser.new_page()
                await page.set_content("""<textarea></textarea><button id='picker' class='settings-trigger-button'>Nano Banana 2 x2</button>
                    <div id='menu' hidden><button id='one'>x1</button></div><button>Generate</button>
                    <script>picker.onclick = () => menu.hidden = false;
                    one.onclick = () => { picker.textContent = 'Nano Banana 2 x1'; menu.hidden = true; };</script>""")
                session = FlowAutomation(); session.page = page
                probe = await session._ensure_composer_ready()
                await session._ensure_single_image(probe)
                self.assertEqual(session.image_count, 1)
                self.assertEqual(await page.locator('#picker').inner_text(), 'Nano Banana 2 x1')
            finally:
                await browser.close()
    async def test_observer_mapping_reorder_placeholder_avatar_and_polling(self):
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel="chrome", headless=True)
            try:
                page = await browser.new_page()
                await page.set_content("<body><figure id='results'></figure></body>")
                await page.evaluate("""async () => {
                  window.make = async (size, index, alt = '') => {
                    const c = document.createElement('canvas'); c.width = c.height = size;
                    c.getContext('2d').fillStyle = `rgb(${index},0,0)`; c.getContext('2d').fillRect(0,0,size,size);
                    const img = new Image(); img.alt = alt; img.src = c.toDataURL();
                    document.querySelector('figure').append(img); await img.decode(); return img;
                  };
                  for(let i=0;i<10;i++) await window.make(1024,i);
                }""")
                baseline = await page.evaluate(RESULT_SCRIPT, {"action": "arm", "requestId": "flow_test", "projectId": "project", "chapterId": "chapter"})
                self.assertEqual(baseline["beforeSnapshot"]["mediaCount"], 10)
                await page.evaluate("document.querySelector('figure').prepend(document.images[9])")
                self.assertEqual((await page.evaluate(RESULT_SCRIPT, {}))["candidates"], [])
                await page.evaluate("async () => { window.placeholder = await make(100,40); await make(1024,41,'avatar'); }")
                self.assertEqual((await page.evaluate(RESULT_SCRIPT, {}))["candidates"], [])
                await page.evaluate("""async () => {
                  const result = await make(1024,42); window.expected = result.src;
                  placeholder.src = result.src; result.remove(); await placeholder.decode();
                }""")
                result = await page.evaluate(RESULT_SCRIPT, {})
                self.assertEqual(len(result["candidates"]), 1)
                self.assertEqual(result["candidates"][0]["src"], await page.evaluate("window.expected"))
                self.assertEqual(result["candidates"][0]["requestId"], "flow_test")
                self.assertGreaterEqual(result["candidates"][0]["detectedAt"], baseline["startedAt"])
                self.assertEqual(result["candidates"][0]["source"], "observer")
                # Arm a second request, simulate a lost observer event, and let polling catch it.
                await page.evaluate(RESULT_SCRIPT, {"action": "arm", "requestId": "second"})
                await page.evaluate("window.__storyflowResult.stop()")
                # stop() stops validation too; instead intercept MutationObserver for a fresh arm.
                await page.evaluate("() => { window.RealObserver = MutationObserver; window.MutationObserver = class { observe(){} disconnect(){} }; }")
                await page.evaluate(RESULT_SCRIPT, {"action": "arm", "requestId": "third"})
                await page.evaluate("async () => { window.polled = await make(1024,43); }")
                polled = await page.evaluate(RESULT_SCRIPT, {})
                self.assertEqual(polled["candidates"][0]["src"], await page.evaluate("window.polled.src"))
                self.assertEqual(polled["candidates"][0]["source"], "polling")
            finally:
                await browser.close()

    async def test_browser_fetch_blob_and_google_hosts_with_no_external_download(self):
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel="chrome", headless=True)
            try:
                context = await browser.new_context()
                page = await context.new_page()
                await page.set_content("<body></body>")
                data = await page.evaluate("""async () => {
                  const c = document.createElement('canvas'); c.width = c.height = 1024;
                  const ctx = c.getContext('2d'), pixels = ctx.createImageData(1024,1024);
                  for (let i=0;i<65536;i++) pixels.data[i] = Math.random()*255;
                  ctx.putImageData(pixels,0,0);
                  return c.toDataURL();
                }""")
                import base64
                expected = base64.b64decode(data.split(",", 1)[1])
                blob = await page.evaluate("async data => URL.createObjectURL(await (await fetch(data)).blob())", data)
                session = FlowAutomation(); session.page = page; session.context = context
                for src in (blob, "https://flow-content.google/test.png", "https://lh3.googleusercontent.com/test.png", "https://flow-content.google/no-cors.png"):
                    if src.startswith("https:"):
                        await page.route(src, lambda route: route.fulfill(body=expected, content_type="image/png", headers={"Access-Control-Allow-Origin": "null", "Access-Control-Allow-Credentials": "true"}))
                        if src.endswith("no-cors.png"):
                            await page.unroute(src)
                            await page.route(src, lambda route: route.fulfill(body=expected, content_type="image/png"))
                    content, mime = await session._download_image({"src": src})
                    self.assertEqual(content, expected)
                    self.assertEqual(mime, "image/png")
                await page.route("https://flow-content.google/failed.png", lambda route: route.fulfill(status=403))
                with self.assertRaises(FlowError):
                    await session._download_image({"src": "https://flow-content.google/failed.png"})
            finally:
                await browser.close()

    async def test_valid_result_after_missing_start_ack_is_success(self):
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel="chrome", headless=True)
            try:
                page = await browser.new_page()
                await page.route("https://flow.google.com/**", lambda route: route.fulfill(body="<textarea></textarea><button>Generate</button>", content_type="text/html"))
                await page.goto("https://flow.google.com/project/test")
                await page.evaluate("""() => document.querySelector('button').onclick = () => setTimeout(async () => {
                  const c=document.createElement('canvas');c.width=c.height=1024;
                  const ctx=c.getContext('2d'),p=ctx.createImageData(1024,1024);
                  for(let i=0;i<65536;i++)p.data[i]=Math.random()*255;
                  ctx.putImageData(p,0,0);const img=new Image();img.src=c.toDataURL();document.body.append(img);
                }, 400)""")
                session = FlowAutomation(); session.page = page; session.state = "ready"
                with patch.dict(os.environ, {"FLOW_GENERATION_START_TIMEOUT_MS": "100", "FLOW_GENERATION_TIMEOUT_MS": "3000"}):
                    content, mime = await session.generate_image("forest")
                self.assertGreater(len(content), 10000)
                self.assertEqual(mime, "image/png")
                self.assertTrue(session.flow_diagnostics["startAckMissing"])
                # A submit action can also complete while its acknowledgement errors.
                original_submit = session._submit_prompt
                async def uncertain_submit(prompt):
                    await original_submit(prompt)
                    raise FlowError("FLOW_SUBMIT_FAILED", "uncertain pointer acknowledgement")
                with patch.object(session, '_submit_prompt', uncertain_submit), patch.dict(os.environ, {"FLOW_GENERATION_TIMEOUT_MS": "3000"}):
                    content, mime = await session.generate_image("second forest")
                self.assertGreater(len(content), 10000)
                self.assertEqual(mime, "image/png")
            finally:
                await browser.close()
