# StoryFlow Cloud AI on Modal

This folder contains the deployable cloud workers used by StoryFlow. The local
application keeps SQLite, cached media and FFmpeg rendering on the user's PC;
GPU inference runs remotely.

## VieNeu Cloud

```powershell
python -m pip install modal
modal setup
modal deploy cloud/modal/tts_app.py
```

Copy the HTTPS base URL printed by Modal to `.env.local`:

```dotenv
MODAL_TTS_URL=https://...
# Optional: use the same value as the STORYFLOW_MODAL_TOKEN secret in Modal.
MODAL_AUTH_TOKEN=
```

The service exposes `/health`, `/v1/voices`, `/v1/audio/speech` and
`/v1/audio/batch`. VieNeu is loaded once per warm GPU container and the model
cache is retained in a Modal Volume.

## Story / reference image worker

Deploy `image_app.py` after reviewing the base-model license and setting the
required Hugging Face access. StoryDiffusion source code is Apache-2.0, but a
base model has its own license. PhotoMaker's repository is Apache-2.0, while
PhotoMaker V2 relies on InsightFace and inherits additional license
requirements. For that reason Reference Mode is deliberately not silently
enabled for commercial projects: configure an allowed reference backend before
using it.

Never commit Modal or Hugging Face tokens. Cloud inference is not silently
replaced with paid APIs when an endpoint is unavailable.
