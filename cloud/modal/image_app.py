"""StoryFlow StoryDiffusion + PhotoMaker reference worker on Modal.

This service uses the upstream StoryDiffusion implementation rather than
pretending independent SDXL images are StoryDiffusion. Story mode can create up
to 10 frames in one call so Consistent Self-Attention is shared across frames.

Reference mode uses the PhotoMaker v1 adapter already bundled by the upstream
StoryDiffusion predictor and accepts multiple identity images. PhotoMaker V2 is
not enabled by default because its own README says it relies on InsightFace and
therefore carries additional license requirements.
"""
from __future__ import annotations

import base64
import io
import os
import sys
from pathlib import Path
from typing import Any

import modal

app = modal.App("storyflow-story-image")
model_volume = modal.Volume.from_name("storyflow-story-image-cache", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("git", "curl")
    .run_commands(
        'curl -L -o /usr/local/bin/pget "https://github.com/replicate/pget/releases/latest/download/pget_Linux_x86_64"',
        "chmod +x /usr/local/bin/pget",
        "git clone --depth 1 https://github.com/HVision-NKU/StoryDiffusion.git /opt/storydiffusion",
    )
    .pip_install(
        "torch==2.0.1",
        "torchvision==0.15.2",
        "diffusers==0.25.0",
        "transformers==4.36.2",
        "huggingface-hub==0.20.2",
        "accelerate",
        "safetensors==0.4.0",
        "omegaconf",
        "peft",
        "gradio==4.22.0",
        "httpx==0.27.0",
        "cog",
        "pillow",
        "fastapi",
    )
)

def encode_png(image: Any) -> bytes:
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()

@app.function(
    image=image,
    gpu="A10G",
    timeout=3600,
    scaledown_window=300,
    volumes={"/cache": model_volume},
)
@modal.asgi_app()
def web():
    from fastapi import FastAPI, Header, HTTPException, Response
    from pydantic import BaseModel, Field
    from PIL import Image
    import torch

    repo = "/opt/storydiffusion"
    os.chdir(repo)
    if repo not in sys.path:
        sys.path.insert(0, repo)

    import predict as story_predict  # type: ignore

    story_predict.MODEL_CACHE = "/cache/model_weights"
    predictor = story_predict.Predictor()
    predictor.setup()

    api = FastAPI(title="StoryFlow Story AI", version="1.0")
    token = os.environ.get("STORYFLOW_MODAL_TOKEN")

    def auth(authorization: str | None = Header(default=None)):
        if token and authorization != f"Bearer {token}":
            raise HTTPException(401, "invalid token")

    def dims(aspect: str):
        return (1024, 576) if aspect == "16:9" else (576, 1024)

    def story_style(style: str):
        lower = style.lower()
        if "anime" in lower or "manhua" in lower or "hoạt hình" in lower:
            return "Japanese Anime"
        # RealVision + no additional template is the least surprising option for
        # realistic/cinematic StoryFlow presets.
        return "(No style)"

    class StoryRequest(BaseModel):
        prompt: str | None = Field(default=None, max_length=8000)
        prompts: list[str] | None = Field(default=None, max_length=10)
        character_description: str = Field(default="a consistent main character", max_length=3000)
        seed: int = 0
        aspect: str = Field(default="16:9", pattern=r"^(16:9|9:16)$")
        style: str = "Điện ảnh chân thực"

    class ReferenceRequest(BaseModel):
        prompt: str = Field(min_length=1, max_length=8000)
        reference_images: list[str] = Field(min_length=1, max_length=10)
        seed: int = 0
        aspect: str = Field(default="16:9", pattern=r"^(16:9|9:16)$")
        style: str = "Điện ảnh chân thực"

    @api.get("/health")
    def health(authorization: str | None = Header(default=None)):
        auth(authorization)
        return {
            "status": "ok",
            "ready": True,
            "model": "storydiffusion-sdxl",
            "reference_model": "photomaker-v1",
        }

    def generate_story(req: StoryRequest):
        prompts = req.prompts or ([req.prompt] if req.prompt else [])
        prompts = [p.strip().replace("\n", " ") for p in prompts if p and p.strip()]
        if not prompts:
            raise HTTPException(400, "missing prompt")
        prompts = prompts[:10]
        width, height = dims(req.aspect)
        # StoryDiffusion requires id_length <= number of prompts. For short
        # groups use 1; for longer groups reserve up to 3 identity frames.
        num_ids = min(3, max(1, len(prompts)))
        result = predictor.predict(
            sd_model="RealVision",
            ref_image=None,
            character_description=req.character_description or "a consistent main character",
            negative_prompt=(
                "text, watermark, logo, bad anatomy, extra fingers, malformed hands, "
                "duplicate person, inconsistent face, low quality"
            ),
            comic_description="\n".join(prompts),
            style_name=story_style(req.style),
            comic_style="Classic Comic Style",
            image_width=width,
            image_height=height,
            num_steps=25,
            guidance_scale=5,
            seed=req.seed,
            sa32_setting=0.5,
            sa64_setting=0.5,
            num_ids=num_ids,
            output_format="png",
            output_quality=100,
        )
        return [Path(str(p)) for p in result.individual_images]

    @api.post("/v1/images/story")
    def story(req: StoryRequest, authorization: str | None = Header(default=None)):
        auth(authorization)
        paths = generate_story(req)
        return Response(
            paths[0].read_bytes(),
            media_type="image/png",
            headers={"X-StoryFlow-Model": "storydiffusion-sdxl"},
        )

    @api.post("/v1/images/story-batch")
    def story_batch(req: StoryRequest, authorization: str | None = Header(default=None)):
        auth(authorization)
        paths = generate_story(req)
        return {
            "model": "storydiffusion-sdxl",
            "data": [
                {"index": index, "image_png_base64": base64.b64encode(path.read_bytes()).decode("ascii")}
                for index, path in enumerate(paths)
            ],
        }

    @api.post("/v1/images/reference")
    @torch.inference_mode()
    def reference(req: ReferenceRequest, authorization: str | None = Header(default=None)):
        auth(authorization)
        refs = []
        for raw in req.reference_images:
            try:
                refs.append(Image.open(io.BytesIO(base64.b64decode(raw, validate=True))).convert("RGB"))
            except Exception as exc:
                raise HTTPException(400, f"invalid reference image: {exc}") from exc

        pipe = predictor.pipe_realvision.to("cuda")
        if hasattr(pipe, "id_encoder"):
            pipe.id_encoder.to("cuda")
        prompt = req.prompt
        if " img" not in prompt:
            prompt = "a person img, " + prompt
        width, height = dims(req.aspect)
        generator = torch.Generator(device="cuda").manual_seed(req.seed)
        output = pipe(
            prompt=prompt,
            input_id_images=refs,
            negative_prompt=(
                "text, watermark, logo, asymmetry, low quality, bad anatomy, "
                "extra fingers, fused face, duplicate face"
            ),
            num_images_per_prompt=1,
            num_inference_steps=25,
            start_merge_step=10,
            height=height,
            width=width,
            generator=generator,
        ).images[0]
        return Response(
            encode_png(output),
            media_type="image/png",
            headers={"X-StoryFlow-Model": "photomaker-v1"},
        )

    return api
