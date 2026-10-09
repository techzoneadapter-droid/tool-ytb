import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  acquireLock,
  startService,
  serviceURL,
} from "../modules/providers/services";
import { codePath } from "../modules/project/code-path";
import { vieneuPaths } from "../modules/providers/vieneu-paths";

const lock = path.resolve("data/vieneu-setup.lock");
const status = path.resolve("data/vieneu-setup.json");
const log = path.resolve("data/vieneu-setup.log");
let writes = Promise.resolve();
function save(state: string, stage: string, detail?: string) {
  writes = writes.then(async () => {
    const temporary = status + "." + randomUUID();
    await writeFile(
      temporary,
      JSON.stringify({
        state,
        stage,
        detail,
        updatedAt: new Date().toISOString(),
      }),
    );
    await rename(temporary, status);
  });
  return writes;
}
async function main() {
  await mkdir(path.resolve("data"), { recursive: true });
  // The dedicated process keeps installing even if the UI reloads.
  try {
    await acquireLock(lock);
  } catch {
    process.send?.({ type: "busy" });
    return;
  }
  try {
    await writeFile(log, "");
    await save("running", "python");
    process.send?.({ type: "started" });
    const runtime = vieneuPaths();
    if (
      !existsSync(runtime.python) ||
      (runtime.managed &&
        !existsSync(path.join(runtime.directory, "installed.json")))
    ) {
      if (process.platform !== "win32")
        throw Error("Cài VieNeu tự động hiện dành cho Windows.");
      if (!runtime.managed)
        throw Error(
          "VIENEU_REPO_DIR đang trỏ đến môi trường riêng chưa tồn tại. Kiểm tra cấu hình này trước.",
        );
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            codePath("scripts/setup-vieneu.ps1"),
            "-Workspace",
            process.cwd(),
          ],
          {
            windowsHide: true,
            shell: false,
            // Do not inherit PowerShell 7's module search path into Windows PowerShell 5.
            env: { ...process.env, PSModulePath: undefined },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let pending = "";
        const output = (bytes: Buffer) => {
          pending += bytes.toString("utf8");
          writes = writes.then(() => writeFile(log, bytes, { flag: "a" }));
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() || "";
          for (const line of lines) {
            const stage = /^STORYFLOW_SETUP:(python|dependencies|model)$/.exec(
              line,
            )?.[1];
            if (stage) void save("running", stage);
          }
        };
        child.stdout.on("data", output);
        child.stderr.on("data", output);
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0
            ? resolve()
            : reject(
                Error(
                  "Cài môi trường VieNeu thất bại. Xem nhật ký cài đặt rồi bấm thử lại.",
                ),
              ),
        );
      });
    }
    await save("running", "model");
    await startService("vieneu");
    await save("running", "verify");
    const response = await fetch(new URL("/v1/voices", serviceURL("vieneu")), {
      signal: AbortSignal.timeout(10000),
    });
    const voices = await response.json();
    if (!response.ok || !Array.isArray(voices.data) || !voices.data.length)
      throw Error("VieNeu chưa trả danh sách giọng hợp lệ.");
    await save(
      "done",
      "ready",
      `VieNeu đã sẵn sàng · ${voices.data.length} giọng.`,
    );
  } catch (error) {
    await save(
      "error",
      "error",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  } finally {
    await writes;
    await unlink(lock).catch(() => {});
    if (process.connected) process.disconnect();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
