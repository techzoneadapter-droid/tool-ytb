import sharp from "sharp";
import { mkdir, unlink, readFile } from "node:fs/promises";
import path from "node:path";
import type { Settings } from "../project/types";
import { requireImage } from "../providers/config";
import { localGenerate, publishGenerated } from "../providers/local-workers";
import { makeModalImage } from "./modal";

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
        : requireImage().model;

  if (provider === "flux2-local" || provider === "local-fast") {
    bytes = await localGenerate(provider === "local-fast" ? "fast" : "flux", {
      model,
      prompt,
      aspect: s.aspect,
      seed,
    });
  } else {
    const c = requireImage();
    const response = await fetch(
      "https://api.openai.com/v1/images/generations",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + c.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: c.model,
          prompt:
            prompt +
            " Compose for " +
            s.aspect +
            " with important subjects inside the central crop.",
          size: s.aspect === "9:16" ? "1024x1536" : "1536x1024",
          n: 1,
        }),
        signal: AbortSignal.timeout(240000),
      },
    );
    if (!response.ok)
      throw Error(
        "API tạo ảnh thất bại (" +
          response.status +
          "). Kiểm tra khóa, quyền truy cập model và hạn mức.",
      );
    const d = await response.json();
    if (!d.data?.[0]?.b64_json)
      throw Error("API tạo ảnh không trả về dữ liệu ảnh hợp lệ.");
    bytes = Buffer.from(d.data[0].b64_json, "base64");
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
