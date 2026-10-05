"""Real HTTP startup tests: restore is delayed or fails, without launching Chrome."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor


class StartupTests(unittest.TestCase):
    def run_worker(self, expired=False):
        with tempfile.TemporaryDirectory() as directory:
            cookies = Path(directory) / "cookies.json"
            cookies.write_text("[]", encoding="utf-8")
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            code = '''import asyncio, sys
sys.path.insert(0, 'workers')
import flow_server as server
from flow_automation import FlowError
calls = 0
active = 0
max_active = 0
async def restore():
    global calls
    calls += 1
    await asyncio.sleep(0.1 if __EXPIRED__ else 5)
    if __EXPIRED__: raise FlowError('FLOW_COOKIE_EXPIRED', 'Expired fixture', stage='FLOW_AUTH')
    server.session.state = 'ready'
    server.session.session_ready = server.session.composer_ready = server.session.generation_ready = True
async def generate(prompt, aspect):
    global active, max_active
    active += 1
    max_active = max(active, max_active)
    await asyncio.sleep(0.05)
    active -= 1
    return b'fixture-image', 'image/png'
original = server.session.health
def health(): return {**original(), 'restoreCalls': calls, 'maxConcurrentGeneration': max_active}
server.session.restore_session = restore
server.session.generate_image = generate
server.session.health = health
import uvicorn
uvicorn.run(server.app, host='127.0.0.1', port=PORT, access_log=False)
'''.replace("__EXPIRED__", repr(expired)).replace("PORT", str(port))
            log = (Path(directory) / "worker.log").open("w+", encoding="utf-8")
            process = subprocess.Popen([sys.executable, "-c", code],
                env={**os.environ, "FLOW_COOKIES_FILE": str(cookies), "FLOW_RESTORE_TIMEOUT_MS": "10000"},
                stdout=log, stderr=log,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            base = f"http://127.0.0.1:{port}"
            def health():
                with urllib.request.urlopen(base + "/health", timeout=1) as response:
                    return json.load(response)
            def generate():
                request = urllib.request.Request(base + "/generate", data=b'{"prompt":"fixture"}', headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(request, timeout=10) as response:
                    return response.read()
            try:
                deadline = time.monotonic() + 30
                while True:
                    try:
                        current = health()
                        break
                    except OSError:
                        if process.poll() is not None or time.monotonic() >= deadline:
                            log.flush(); log.seek(0)
                            self.fail("HTTP bridge never started: " + log.read())
                        time.sleep(0.05)
                if expired:
                    while current["state"] != "login_required" and time.monotonic() < deadline:
                        time.sleep(0.05)
                        current = health()
                    self.assertEqual(current["state"], "login_required")
                    self.assertEqual(current["lastErrorCode"], "FLOW_COOKIE_EXPIRED")
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        generate()
                    self.assertEqual(json.load(caught.exception)["code"], "FLOW_COOKIE_EXPIRED")
                    caught.exception.close()
                    self.assertIsNone(process.poll())
                else:
                    self.assertEqual(current["state"], "restoring")
                    self.assertTrue(current["bridgeReady"])
                    self.assertFalse(current["generationReady"])
                    with ThreadPoolExecutor(max_workers=3) as pool:
                        first = pool.submit(generate)
                        second = pool.submit(generate)
                        started = time.monotonic()
                        self.assertEqual(health()["state"], "restoring")
                        self.assertLess(time.monotonic() - started, 0.5)
                        self.assertEqual(first.result(), b"fixture-image")
                        self.assertEqual(second.result(), b"fixture-image")
                    current = health()
                    self.assertTrue(current["generationReady"])
                    self.assertEqual(current["restoreCalls"], 1)
                    self.assertEqual(current["maxConcurrentGeneration"], 1)
            finally:
                process.terminate()
                process.wait(timeout=10)
                log.close()

    def test_health_is_available_during_five_second_restore_and_generations_share_task(self):
        self.run_worker()

    def test_expired_restore_keeps_http_alive_and_preserves_error(self):
        self.run_worker(expired=True)
