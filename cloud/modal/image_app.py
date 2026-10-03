"""StoryFlow StoryDiffusion + multi-reference PhotoMaker worker on Modal.

Story mode uses StoryDiffusion's Consistent Self-Attention code from the
official HVision-NKU repository, but loads a configurable SDXL base model
instead of silently inheriting the demo's bundled base models.

Reference mode uses PhotoMaker v1 with all supplied identity images. V2 is not
enabled by default because the official PhotoMaker V2 README says it relies on
InsightFace and therefore has additional license requirements.
"""
from __future__ import annotations

import base64
import io
import os
import sys
from typing import Any

import modal

app = modal.App("storyflow-story-image")
model_volume = modal.Volume.from_name(
    "storyflow-story-image-cache", create_if_missing=True
)

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("git")
    .run_commands(
        "git clone --depth 1 https://github.com/HVision-NKU/StoryDiffusion.git /opt/storydiffusion",
    )
    .pip_install(
        "torch==2.1.2",
        "torchvision==0.16.2",
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
    from diffusers import StableDiffusionXLPipeline, EulerDiscreteScheduler
    from huggingface_hub import hf_hub_download

    repo = "/opt/storydiffusion"
    os.chdir(repo)
    if repo not in sys.path:
        sys.path.insert(0, repo)

    # Import the official StoryDiffusion attention processors and predictor.
    import predict as story_predict  # type: ignore
    from utils import PhotoMakerStableDiffusionXLPipeline  # type: ignore

    base_model = os.environ.get(
        "STORYFLOW_SDXL_MODEL",
        "stabilityai/stable-diffusion-xl-base-1.0",
    )
    cache_dir = "/cache/huggingface"

    # Story pipeline. The predictor is reused only for the official
    # Consistent Self-Attention generation path; its Replicate demo weights are
    # deliberately not downloaded.
    story_pipe = StableDiffusionXLPipeline.from_pretrained(
        base_model,
        torch_dtype=torch.float16,
        use_safetensors=True,
        cache_dir=cache_dir,
    )
    story_pipe.scheduler = EulerDiscreteScheduler.from_config(
        story_pipe.scheduler.config
    )
    story_pipe.enable_vae_slicing()
    story_predictor = story_predict.Predictor()
    story_predictor.sdxl_pipe_realvision = story_pipe
    story_predictor.sdxl_pipe_unstable = story_pipe

    # PhotoMaker v1 is kept separate and uses every supplied identity image.
    reference_pipe = PhotoMakerStableDiffusionXLPipeline.from_pretrained(
        base_model,
        torch_dtype=torch.float16,
        use_safetensors=True,
        cache_dir=cache_dir,
    )
    photomaker_path = hf_hub_download(
        repo_id="TencentARC/PhotoMaker",
        filename="photomaker-v1.bin",
        repo_type="model",
        cache_dir=cache_dir,
    )
    reference_pipe.load_photomaker_adapter(
        os.path.dirname(photomaker_path),
        subfolder="",
        weight_name=os.path.basename(photomaker_path),
        trigger_word="img",
    )
    reference_pipe.scheduler = EulerDiscreteScheduler.from_config(
        reference_pipe.scheduler.config
    )
    reference_pipe.fuse_lora()
    reference_pipe.enable_vae_slicing()

    api = FastAPI(title="StoryFlow Story AI", version="1.1")
    token = os.environ.get("STORYFLOW_MODAL_TOKEN")

    def auth(authorization: str | None = Header(default=None)):
        if token and authorization != f"Bearer {token}":
            raise HTTPException(401, "invalid token")

    def dims(aspect: str):
        # StoryDiffusion supports SDXL dimensions in multiples of 32.
        return (1024, 576) if aspect == "16:9" else (576, 1024)

    class StoryRequest(BaseModel):
        prompt: str | None = Field(default=None, max_length=8000)
        prompts: list[str] | None = Field(default=None, max_length=10)
        character_description: str = Field(
            default="a consistent main character", max_length=3000
        )
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
            "model": f"storydiffusion:{base_model}",
            "reference_model": "photomaker-v1",
        }

    def generate_story(req: StoryRequest):
        prompts = req.prompts or ([req.prompt] if req.prompt else [])
        prompts = [
            prompt.strip().replace("\n", " ")
            for prompt in prompts
            if prompt and prompt.strip()
        ][:10]
        if not prompts:
            raise HTTPException(400, "missing prompt")
        width, height = dims(req.aspect)
        num_ids = min(3, len(prompts))

        # "(No style)" makes the official StoryDiffusion predictor keep the
        # complete StoryFlow prompt/style instead of layering its demo preset.
        result = story_predictor.predict(
            sd_model="RealVision",
            ref_image=None,
            character_description=(
                req.character_description or "a consistent main character"
            ),
            negative_prompt=(
                "text, watermark, logo, bad anatomy, extra fingers, malformed "
                "hands, duplicate person, inconsistent face, low quality"
            ),
            comic_description="\n".join(prompts),
            style_name="(No style)",
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
        return [str(path) for path in result.individual_images]

    @api.post("/v1/images/story")
    def story(req: StoryRequest, authorization: str | None = Header(default=None)):
        auth(authorization)
        paths = generate_story(req)
        with open(paths[0], "rb") as source:
            data = source.read()
        return Response(
            data,
            media_type="image/png",
            headers={"X-StoryFlow-Model": f"storydiffusion:{base_model}"},
        )

    @api.post("/v1/images/story-batch")
    def story_batch(
        req: StoryRequest, authorization: str | None = Header(default=None)
    ):
        auth(authorization)
        paths = generate_story(req)
        result = []
        for index, path in enumerate(paths):
            with open(path, "rb") as source:
                result.append(
                    {
                        "index": index,
                        "image_png_base64": base64.b64encode(
                            source.read()
                        ).decode("ascii"),
                    }
                )
        return {"model": f"storydiffusion:{base_model}", "data": result}

    @api.post("/v1/images/reference")
    @torch.inference_mode()
    def reference(
        req: ReferenceRequest, authorization: str | None = Header(default=None)
    ):
        auth(authorization)
        refs = []
        for raw in req.reference_images:
            try:
                refs.append(
                    Image.open(
                        io.BytesIO(base64.b64decode(raw, validate=True))
                    ).convert("RGB")
                )
            except Exception as exc:
                raise HTTPException(
                    400, f"invalid reference image: {exc}"
                ) from exc

        width, height = dims(req.aspect)
        prompt = req.prompt
        if " img" not in prompt:
            prompt = "a person img, " + prompt

        pipe = reference_pipe.to("cuda")
        if hasattr(pipe, "id_encoder"):
            pipe.id_encoder.to("cuda")
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
