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
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(Error("Trình cài VieNeu không phản hồi trong 60 giây. Kiểm tra data/vieneu-setup.json và data/vieneu-setup.log.")),
      60000,
    );
    child.once("error", (error) => {
      finish(error);
    });
    child.once("exit", (code) => {
      // A quick successful exit can race the IPC startup acknowledgement.
      if (code === 0) finish();
      else finish(Error("Trình cài VieNeu thoát sớm (" + code + "). Kiểm tra data/vieneu-setup.json và data/vieneu-setup.log."));
    });
    child.once("message", () => {
      if (child.connected) child.disconnect();
      child.unref();
      finish();
    });
  });
}
export async function launchVieneuSetup() {
  launching ||= launch().finally(() => {
    launching = undefined;
  });
  await launching;
}
