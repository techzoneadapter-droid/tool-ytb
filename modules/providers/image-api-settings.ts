import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ImageAPIProvider } from "./image-api-options";

export type ImageAPIModel = { id: string; label: string };
export type SavedImageAPI = {
  key: string;
  model: string;
  models: ImageAPIModel[];
  connected: boolean;
  checkedAt: string;
  catalogSource: "api" | "stability-endpoints";
};
function filename(provider: ImageAPIProvider) {
  return path.join(process.env.IMAGE_API_CONFIG_DIR || path.resolve("data/image-api"), `${provider}.json`);
}
export function readImageAPI(provider: ImageAPIProvider): SavedImageAPI | undefined {
  try {
    const saved = JSON.parse(readFileSync(/* turbopackIgnore: true */ filename(provider), "utf8"));
    if (typeof saved.key !== "string" || typeof saved.model !== "string" || !Array.isArray(saved.models))
      throw Error("invalid settings");
    return saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw Error("Không đọc được cấu hình API ảnh đã lưu. Hãy kiểm tra tệp cấu hình cục bộ.");
  }
}
export function saveImageAPI(provider: ImageAPIProvider, settings: SavedImageAPI) {
  const file = filename(provider);
  mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(/* turbopackIgnore: true */ temporary, JSON.stringify(settings), { mode: 0o600 });
  renameSync(/* turbopackIgnore: true */ temporary, file);
}
