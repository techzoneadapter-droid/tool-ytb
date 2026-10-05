import sharp from "sharp";
import { mkdir, unlink, readFile } from "node:fs/promises";
import path from "node:path";
import type { Settings, ChapterImageJob } from "../project/types";
import { imageConfig, generateAPIImage } from "../providers/image-api";
import { localGenerate, publishGenerated } from "../providers/local-workers";
import { makeModalImage, makeModalStoryBatch } from "./modal";
import { aiHordeImage, pollinationsImage } from "../providers/free-cloud";
import { generateWithFlow, flowFailure } from "../providers/flow-browser";

export async function makeFlowImageBuffer(prompt: string, settings: Settings, onStage?: (stage: string) => void, mapping?: ChapterImageJob) {
  const generated = await generateWithFlow(prompt, settings.aspect, onStage, mapping);
  try {
    const metadata = await sharp(generated.bytes, { limitInputPixels: 40000000 }).metadata();
    if ((metadata.width || 0) < 512 || (metadata.height || 0) < 512) throw Error("Ảnh Flow phải có cả hai chiều tối thiểu 512px.");
    await sharp(generated.bytes, { limitInputPixels: 40000000 }).stats();
    return generated;
  } catch (error) {
    throw flowFailure({ code: "FLOW_RESULT_DOWNLOAD_FAILED", stage: "FLOW_RESULT_DECODE", error: error instanceof Error ? error.message : String(error) }, "");
  }
}

export async function makeImage(
  prompt: string,
  file: string,
  s: Settings,
  seed = 0,
) {
  if (s.imageEnabled === false)
    throw Error("Tạo ảnh đang tắt. Có thể dùng ảnh đã có hoặc tải ảnh lên.");
  await mkdir(path.dirname(file), { recursive: true });

  let bytes: Buffer;
  let provider = s.imageProvider;

  if (provider === "modal-story" || provider === "modal-reference") {
    const generated = await makeModalImage(prompt, s, seed);
    bytes = generated.bytes;
    try {
      await sharp(bytes, { limitInputPixels: 40000000 })
        .resize(
          s.aspect === "9:16" ? 720 : 1280,
          s.aspect === "9:16" ? 1280 : 720,
          { fit: "cover" },
        )
        .png()
        .toFile(file);
      await publishGenerated(file, "images");
      return { engine: generated.engine, model: generated.model };
    } catch {
      await unlink(file).catch(() => {});
      throw Error("Story AI Cloud không trả về ảnh hợp lệ.");
    }
  }

  if (provider === "flow-browser") {
    throw flowFailure({ code: "FLOW_UI_CHANGED", stage: "FLOW_PIPELINE", error: "Flow chỉ dùng luồng Buffer → render scene; không ghi ảnh trung gian." }, "");
  }

  if (provider === "aihorde") {
    const generated = await aiHordeImage(prompt, s.aspect, seed);
    bytes = generated.bytes;
    try {
      await sharp(bytes, { limitInputPixels: 40000000 })
        .resize(
          s.aspect === "9:16" ? 720 : 1280,
          s.aspect === "9:16" ? 1280 : 720,
          { fit: "cover" },
        )
        .png()
        .toFile(file);
      await publishGenerated(file, "images");
      return { engine: "aihorde", model: generated.model };
    } catch {
      await unlink(file).catch(() => {});
      throw Error("AI Horde không trả ảnh hợp lệ.");
    }
  }

  if (provider === "pollinations") {
    const generated = await pollinationsImage(prompt, s.aspect, seed);
    bytes = generated.bytes;
    try {
      await sharp(bytes, { limitInputPixels: 40000000 })
        .resize(
          s.aspect === "9:16" ? 720 : 1280,
          s.aspect === "9:16" ? 1280 : 720,
          { fit: "cover" },
        )
        .png()
        .toFile(file);
      await publishGenerated(file, "images");
      return { engine: "pollinations", model: generated.model };
    } catch {
      await unlink(file).catch(() => {});
      throw Error("Pollinations không trả ảnh hợp lệ.");
    }
  }

  if (provider === "auto-local") {
    const tested = await readFile(
      path.resolve("data/fast-benchmark.json"),
      "utf8",
    )
      .then(JSON.parse)
      .catch(() => null);
    if (!tested?.passed)
      throw Error(
        "Auto chưa có engine đã benchmark thành công. Chọn Local Fast để kiểm tra sau khi cài model.",
      );
    provider = "local-fast";
  }

  const model =
    provider === "local-fast"
      ? "stabilityai/sd-turbo"
      : provider === "flux2-local"
        ? process.env.FLUX2_MODEL || "flux2-klein-4b"
        : s.imageModel || imageConfig(provider).model;

  if (provider === "flux2-local" || provider === "local-fast") {
    bytes = await localGenerate(provider === "local-fast" ? "fast" : "flux", {
      model,
      prompt,
      aspect: s.aspect,
      seed,
    });
  } else {
    const generated = await generateAPIImage(provider, prompt, s.aspect, seed, s.imageModel);
    bytes = generated.bytes;
    provider = generated.engine;
  }

  try {
    await sharp(bytes, { limitInputPixels: 40000000 })
      .resize(
        s.aspect === "9:16" ? 720 : 1280,
        s.aspect === "9:16" ? 1280 : 720,
        { fit: "cover" },
      )
      .png()
      .toFile(file);
    await publishGenerated(file, "images");
    return { engine: provider || "openai", model };
  } catch {
    await unlink(file).catch(() => {});
    throw Error("Không giải mã được ảnh trả về từ API.");
  }
}


export async function makeStoryImageBatch(
  prompts: string[],
  files: string[],
  settings: Settings,
  seed: number,
  characterDescription: string,
) {
  if (settings.imageProvider !== "modal-story")
    throw Error("Batch Story chỉ dùng với Story AI Cloud.");
  if (prompts.length !== files.length)
    throw Error("Số prompt và file ảnh không khớp.");
  const generated = await makeModalStoryBatch(
    prompts,
    settings,
    seed,
    characterDescription,
  );
  for (let index = 0; index < generated.images.length; index++) {
    const file = files[index];
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await sharp(generated.images[index], { limitInputPixels: 40000000 })
        .resize(
          settings.aspect === "9:16" ? 720 : 1280,
          settings.aspect === "9:16" ? 1280 : 720,
          { fit: "cover" },
        )
        .png()
        .toFile(file);
      await publishGenerated(file, "images");
    } catch {
      await unlink(file).catch(() => {});
      throw Error("Không giải mã được ảnh StoryDiffusion.");
    }
  }
  return {
    engine: "modal-story" as const,
    model: generated.model,
  };
}
