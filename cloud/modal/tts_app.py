"""StoryFlow VieNeu-TTS v3 Turbo on Modal.

Deploy:
    modal deploy cloud/modal/tts_app.py

The ASGI application keeps one VieNeu model resident per warm GPU container.
Set STORYFLOW_MODAL_TOKEN as a Modal secret if the endpoint is exposed beyond
your private development environment.
"""
from __future__ import annotations

import base64
import io
import os
import wave
from typing import Any

import modal

app = modal.App("storyflow-vieneu")
model_volume = modal.Volume.from_name("storyflow-vieneu-cache", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch==2.8.0",
        "torchaudio==2.8.0",
        "transformers==4.57.6",
        "vieneu",
        "fastapi",
        "numpy",
    )
)

def wav_bytes(audio: Any, sample_rate: int = 48_000) -> bytes:
    import numpy as np

    pcm = (np.asarray(audio, dtype=np.float32) * 32767).clip(-32768, 32767).astype("<i2")
    stream = io.BytesIO()
    with wave.open(stream, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(pcm.tobytes())
    return stream.getvalue()

@app.function(
    image=image,
    gpu="L4",
    timeout=3600,
    scaledown_window=300,
    volumes={"/root/.cache": model_volume},
)
@modal.asgi_app()
def web():
    from fastapi import FastAPI, Header, HTTPException, Response
    from pydantic import BaseModel, Field
    from vieneu import Vieneu

    api = FastAPI(title="StoryFlow VieNeu Cloud", version="1.0")
    tts = Vieneu(mode="v3turbo", backend="pytorch", device="cuda", max_streams=16)
    # Warm the CUDA graph once so the first StoryFlow preview does not pay startup latency.
    for _ in tts.infer_stream("Xin chào.", voice=None, apply_watermark=True):
        pass

    token = os.environ.get("STORYFLOW_MODAL_TOKEN")

    def auth(authorization: str | None = Header(default=None)):
        if token and authorization != f"Bearer {token}":
            raise HTTPException(401, "invalid token")

    class SpeechRequest(BaseModel):
        model: str = "vieneu-v3-turbo"
        input: str = Field(min_length=1, max_length=20_000)
        voice: str | None = None
        response_format: str = "wav"
        sample_rate: int = 48_000

    class BatchItem(BaseModel):
        id: str
        text: str = Field(min_length=1, max_length=20_000)

    class BatchRequest(BaseModel):
        items: list[BatchItem] = Field(min_length=1, max_length=32)
        voice: str | None = None
        batch_size: int = Field(default=16, ge=1, le=32)

    @api.get("/health")
    def health(authorization: str | None = Header(default=None)):
        auth(authorization)
        return {
            "status": "ok",
            "ready": True,
            "model": "vieneu-v3-turbo",
            "backend": getattr(tts, "backend", "pytorch"),
        }

    @api.get("/v1/voices")
    def voices(authorization: str | None = Header(default=None)):
        auth(authorization)
        data = []
        for label, voice_id in tts.list_preset_voices():
            data.append({"id": voice_id, "name": label})
        return {"object": "list", "data": data}

    @api.post("/v1/audio/speech")
    def speech(req: SpeechRequest, authorization: str | None = Header(default=None)):
        auth(authorization)
        if req.response_format != "wav":
            raise HTTPException(400, "StoryFlow cloud endpoint currently returns WAV.")
        if req.sample_rate != 48_000:
            raise HTTPException(400, "Use sample_rate=48000.")
        audio = tts.infer(req.input, voice=req.voice)
        return Response(
            wav_bytes(audio),
            media_type="audio/wav",
            headers={"X-StoryFlow-Model": "vieneu-v3-turbo"},
        )

    @api.post("/v1/audio/batch")
    def batch(req: BatchRequest, authorization: str | None = Header(default=None)):
        auth(authorization)
        texts = [item.text for item in req.items]
        audios = tts.infer_batch(texts, voice=req.voice, batch_size=req.batch_size)
        return {
            "model": "vieneu-v3-turbo",
            "sample_rate": 48_000,
            "data": [
                {
                    "id": item.id,
                    "audio_wav_base64": base64.b64encode(wav_bytes(audio)).decode("ascii"),
                }
                for item, audio in zip(req.items, audios)
            ],
        }

    return api
