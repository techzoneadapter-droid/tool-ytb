import json
from pathlib import Path
import torch
from diffusers import AutoPipelineForText2Image, Flux2KleinPipeline

gpu = torch.cuda.get_device_properties(0) if torch.cuda.is_available() else None
result = {"imports": True, "torch": torch.__version__, "cuda": torch.cuda.is_available(),
          "gpu": gpu.name if gpu else None, "vram_gb": round(gpu.total_memory / 2**30, 2) if gpu else 0,
          "bf16": torch.cuda.is_bf16_supported() if gpu else False}
Path('data').mkdir(exist_ok=True)
Path('data/ai-hardware.json').write_text(json.dumps(result), encoding='utf-8')
print(json.dumps(result), flush=True)
