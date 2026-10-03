import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Settings } from "../project/types";
import { root } from "../project/store";
import { modalFetch } from "../providers/modal/client";

async function refs(settings: Settings) {
  const images = settings.referenceImages || [];
  const out: string[] = [];
  for (const name of images.slice(0, 10)) {
    if (!/^[a-f0-9-]+\.(png|jpg|jpeg|webp)$/i.test(name)) continue;
    const bytes = await readFile(path.join(root, "assets", name));
    out.push(bytes.toString("base64"));
  }
  return out;
}

export async function makeModalImage(
  prompt: string,
  settings: Settings,
  seed: number,
) {
  const referenceImages =
    settings.imageProvider === "modal-reference" ? await refs(settings) : [];
  if (settings.imageProvider === "modal-reference" && !referenceImages.length)
    throw Error("Reference AI cần ít nhất một ảnh tham chiếu.");

  const response = await modalFetch(
    "image",
    settings.imageProvider === "modal-reference"
      ? "/v1/images/reference"
      : "/v1/images/story",
    {
      method: "POST",
      body: JSON.stringify({
        prompt,
        seed,
        aspect: settings.aspect,
        style: settings.style,
        reference_images: referenceImages,
      }),
    },
    1_800_000,
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw Error("Story AI Cloud không trả dữ liệu ảnh.");
  return {
    bytes,
    engine: settings.imageProvider,
    model:
      response.headers.get("x-storyflow-model") ||
      (settings.imageProvider === "modal-reference"
        ? "photomaker-v2"
        : "storydiffusion-sdxl"),
  };
}
