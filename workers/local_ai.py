"""Optional loopback workers. No models are loaded until /generate is called."""
import argparse
import base64
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field
from PIL import Image, ImageOps
import uvicorn

app = FastAPI()
engine = "flux"
pipeline = None
lock = threading.Lock()

class Generate(BaseModel):
    model: str
    prompt: str = Field(min_length=1, max_length=8000)
    aspect: str = Field(default="16:9", pattern=r"^(16:9|9:16)$")
    image_base64: str | None = Field(default=None, max_length=40_000_000)

@app.get("/health")
def health():
    return {"status": "ok", "engine": engine, "model_loaded": pipeline is not None}

@app.post("/generate")
def generate(request: Generate):
    global pipeline
    if not lock.acquire(blocking=False):
        raise HTTPException(409, "Worker đang bận. Chờ tác vụ trước hoàn tất.")
    try:
        if engine == "flux":
            if request.model != "flux2-klein-4b":
                raise ValueError("Worker chỉ cấu hình flux2-klein-4b; không tự đổi sang bản dev.")
            import torch
            from diffusers import Flux2KleinPipeline
            if not torch.cuda.is_available():
                raise ValueError("Cần PyTorch CUDA và GPU phù hợp để chạy FLUX.2 worker này.")
            if pipeline is None:
                pipeline = Flux2KleinPipeline.from_pretrained("black-forest-labs/FLUX.2-klein-4B", torch_dtype=torch.bfloat16)
                pipeline.enable_model_cpu_offload()
            width, height = (1280, 704) if request.aspect == "16:9" else (704, 1280)
            image = pipeline(prompt=request.prompt, width=width, height=height, guidance_scale=1.0, num_inference_steps=4).images[0]
            output = io.BytesIO()
            image.save(output, format="PNG")
            return Response(output.getvalue(), media_type="image/png")
        if request.model != "ti2v-5b" or not request.image_base64:
            raise ValueError("Wan cần model ti2v-5b và ảnh đầu vào thật.")
        repo = Path(os.environ.get("WAN22_REPO_DIR", "")).resolve()
        checkpoint = Path(os.environ.get("WAN22_CHECKPOINT_DIR", "")).resolve()
        if not (repo / "generate.py").is_file() or not (checkpoint / "config.json").is_file():
            raise ValueError("Chưa cấu hình WAN22_REPO_DIR / WAN22_CHECKPOINT_DIR. Xem docs/LOCAL_AI_WORKERS.md.")
        with tempfile.TemporaryDirectory(prefix="storyflow-wan-") as temp:
            image_path = Path(temp) / "input.png"
            output_path = Path(temp) / "output.mp4"
            image = Image.open(io.BytesIO(base64.b64decode(request.image_base64, validate=True))).convert("RGB")
            size = (1280, 704) if request.aspect == "16:9" else (704, 1280)
            ImageOps.fit(image, size).save(image_path)
            command = [sys.executable, str(repo / "generate.py"), "--task", "ti2v-5B", "--size", f"{size[0]}*{size[1]}", "--ckpt_dir", str(checkpoint), "--offload_model", "True", "--convert_model_dtype", "--t5_cpu", "--image", str(image_path), "--prompt", request.prompt, "--save_file", str(output_path)]
            # Use the official Wan image-to-video implementation, never a shell string.
            with open(Path(temp) / "worker.log", "w+b") as log:
                process = subprocess.Popen(command, cwd=repo, stdout=log, stderr=log, shell=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                try:
                    code = process.wait(timeout=1700)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    raise ValueError("Wan xử lý quá lâu. Giảm tải GPU và thử lại.")
                if code != 0:
                    log.seek(0, os.SEEK_END)
                    log.seek(max(0, log.tell() - 2000))
                    raise ValueError("Wan xử lý lỗi. " + log.read().decode("utf-8", errors="replace"))
            if not output_path.is_file() or output_path.stat().st_size == 0:
                raise ValueError("Wan chưa tạo được MP4.")
            return Response(output_path.read_bytes(), media_type="video/mp4")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, f"Không tạo được tài nguyên local: {exc}") from exc
    finally:
        lock.release()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=["flux", "wan"], required=True)
    args = parser.parse_args()
    engine = args.engine
    uvicorn.run(app, host="127.0.0.1", port=7861 if engine == "flux" else 7862)
