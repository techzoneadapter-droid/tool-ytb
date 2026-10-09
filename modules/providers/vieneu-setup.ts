import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { alive } from "./services";
import { codePath } from "../project/code-path";
const lock = path.resolve("data/vieneu-setup.lock");
let launching: Promise<void> | undefined;
async function launch() {
  if (await alive(lock)) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(codePath("node_modules/tsx/dist/loader.mjs")).href,
        codePath("scripts/setup-vieneu.ts"),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          STORYFLOW_CODE_ROOT: codePath(),
          TSX_TSCONFIG_PATH: codePath("tsconfig.json"),
          ELECTRON_RUN_AS_NODE: "1",
        },
        windowsHide: true,
        detached: true,
        shell: false,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const timer = setTimeout(
      () => reject(Error("Chưa mở được trình cài VieNeu.")),
      15000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(Error("Trình cài VieNeu chưa khởi động được."));
    });
    child.once("message", () => {
      clearTimeout(timer);
      child.disconnect();
      child.unref();
      resolve();
    });
  });
}
export async function launchVieneuSetup() {
  launching ||= launch().finally(() => {
    launching = undefined;
  });
  await launching;
}
