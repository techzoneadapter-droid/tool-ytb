import path from "node:path";
import { mkdir, copyFile, readFile, writeFile, unlink } from "node:fs/promises";
import { run } from "../videoRender/process";
import type { Scene, Settings } from "../project/types";
import { startService, serviceURL } from "./services";
import { resolveSceneImage } from "../project/media";
export function workerURL(engine: "flux" | "wan" | "fast") {
  if (engine === "fast") return serviceURL("fast").href.replace(/\/$/, "");
  const u = new URL(
    engine === "flux"
      ? process.env.FLUX2_WORKER_URL || "http://127.0.0.1:7861"
      : process.env.WAN22_WORKER_URL || "http://127.0.0.1:7862",
  );
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw Error("Địa chỉ worker phải nằm trên máy cục bộ.");
  return u.href.replace(/\/$/, "");
}
export async function localGenerate(
  engine: "flux" | "wan" | "fast",
  body: object,
) {
  const label =
    engine === "flux" ? "FLUX.2" : engine === "fast" ? "Local Fast" : "Wan2.2";
  let r: Response;
  try {
    r = await fetch(workerURL(engine) + "/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(1800000),
    });
  } catch {
    try {
      await startService(engine);
    } catch (e) {
      throw Error(
        `Không kết nối được ${label} local. ${e instanceof Error ? e.message : e}`,
      );
    }
    r = await fetch(workerURL(engine) + "/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(1800000),
    });
  }
  if (!r.ok)
    throw Error(
      `${label} xử lý thất bại (${r.status}). ${(await r.text()).slice(0, 1200)}`,
    );
  return Buffer.from(await r.arrayBuffer());
}
export async function publishGenerated(
  file: string,
  kind: "audio" | "images" | "motion",
) {
  const name = path.basename(file);
  if (!/^[a-f0-9-]+\.(wav|mp3|png|mp4)$/.test(name))
    throw Error("Tên tệp không hợp lệ.");
  const dir = path.resolve("public", "generated", kind);
  await mkdir(dir, { recursive: true });
  await copyFile(file, path.join(dir, name));
  return `/generated/${kind}/${name}`;
}
export function usesMotion(scene: Scene, s: Settings) {
  return (
    s.motionMode === "all" ||
    (s.motionMode === "selected" && !!scene.motionSelected)
  );
}
export async function makeMotion(scene: Scene, file: string, s: Settings) {
  const effective = await resolveSceneImage(scene, s);
  if (!effective) throw Error("Cần tạo hoặc tải ảnh trước khi tạo ảnh động.");
  const image = await readFile(path.resolve("data/assets", effective));
  const bytes = await localGenerate("wan", {
    model: process.env.WAN22_MODEL || "ti2v-5b",
    prompt: scene.prompt,
    image_base64: image.toString("base64"),
    aspect: s.aspect,
  });
  try {
    await writeFile(file, bytes);
    const probe = JSON.parse(
      await run(
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
        undefined,
        true,
      ),
    );
    if (
      !probe.streams?.some(
        (s: { codec_type: string }) => s.codec_type === "video",
      ) ||
      !(Number(probe.format?.duration) > 0)
    )
      throw Error("Wan2.2 không trả về video hợp lệ.");
    await publishGenerated(file, "motion");
  } catch (e) {
    await unlink(file).catch(() => {});
    throw e;
  }
}
