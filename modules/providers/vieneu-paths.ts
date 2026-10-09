import path from "node:path";
import { existsSync } from "node:fs";

export function vieneuPaths() {
  const managed = path.resolve("data", "ai", "vieneu");
  const legacy = path.resolve("..", "VieNeu-TTS");
  const pythonName =
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
  const directory =
    process.env.VIENEU_REPO_DIR ||
    (existsSync(path.join(managed, ".venv", pythonName))
      ? managed
      : existsSync(path.join(legacy, ".venv", pythonName))
        ? legacy
        : managed);
  return {
    directory,
    python: path.join(directory, ".venv", pythonName),
    managed: path.resolve(directory) === managed,
  };
}
