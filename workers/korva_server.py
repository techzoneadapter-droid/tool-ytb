"""Single persistent Korva model, serialized requests; no CLI reload per scene."""
import argparse
import io
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

model = None
lock = threading.Lock()
loads = 0

def get_model():
    global model, loads
    if model is None:
        from korvatts.tts import TTS
        from korvatts.assets import resolve_assets_dir
        try:
            assets = resolve_assets_dir(auto_download=False)
        except FileNotFoundError:
            from huggingface_hub import snapshot_download
            assets = snapshot_download(os.environ.get("KORVATTS_HF_REPO", "dogenthq/KorvaTTS"), local_files_only=True, allow_patterns=['onnx/*', 'voice_styles/*'])
        model = TTS(assets_dir=assets, auto_download=False)
        loads += 1
    return model

class Handler(BaseHTTPRequestHandler):
    def reply(self, status, value, content_type="application/json"):
        body = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/voices":
            try:
                if model is None:
                    with lock:
                        get_model()
                voices = model.list_voices()
                return self.reply(200, {"data": [{"id": v} for v in voices]})
            except Exception as exc:
                return self.reply(503, {"error": str(exc)})
        if self.path != "/health":
            return self.reply(404, {"error": "Not found"})
        self.reply(200, {"status": "ok", "engine": "korva", "model_loaded": model is not None, "model_loads": loads})

    def do_POST(self):
        global model, loads
        if self.path not in ("/generate", "/preview", "/synthesize") or self.headers.get("Origin"):
            return self.reply(403, {"error": "Server requests only"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 100000:
                raise ValueError("Invalid body size")
            data = json.loads(self.rfile.read(size))
            text, voice = data["text"], data["voice"]
            if not isinstance(text, str) or not 0 < len(text) <= 20000:
                raise ValueError("Invalid text")
            with lock:
                started = time.perf_counter()
                load_seconds = 0
                get_model()
                load_seconds = time.perf_counter() - started
                steps = 12 if self.path == "/preview" else 32
                wav, duration = model.synthesize(text, voice=voice, lang="vi", speed=1, total_steps=steps)
                import soundfile as sf
                output = io.BytesIO()
                sf.write(output, wav, model.sample_rate, format="WAV")
                print(json.dumps({"model_loads": loads, "load_seconds": load_seconds, "total_seconds": time.perf_counter() - started, "audio_seconds": duration}), flush=True)
                self.reply(200, output.getvalue(), "audio/wav")
        except Exception as exc:
            self.reply(503, {"error": str(exc)})

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7863)
    args = parser.parse_args()
    started = time.perf_counter()
    get_model()
    print(json.dumps({'startup_seconds':time.perf_counter()-started, 'model_loads':loads}), flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
