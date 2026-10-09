"""Keep ONNX graphs and their external weights together as regular files."""
import logging
import os
from pathlib import Path

from huggingface_hub import hf_hub_download
from vieneu._v3_turbo_engine.onnx_runtime_lite import OnnxV3LiteEngine


def fetch_models(repo, files, subfolder):
    # HF's shared cache uses symlinks to separate blob directories. New ORT
    # correctly refuses external weights outside a graph's resolved directory.
    # local_dir downloads regular files and supports resumable, cached retries.
    root = Path(os.environ["STORYFLOW_VIENEU_MODELS"]) / repo.replace("/", "--")
    directory = root / subfolder if subfolder else root
    for filename in files:
        try:
            logging.getLogger("storyflow.vieneu").info("Loading %s/%s", repo, filename)
            hf_hub_download(repo, filename, repo_type="model", subfolder=subfolder or None,
                            local_dir=str(root))
        except Exception:
            if filename.endswith(".json"):
                continue
            raise
    return directory


OnnxV3LiteEngine._fetch = staticmethod(fetch_models)

from apps.openai_speech import main

if __name__ == "__main__":
    main()
