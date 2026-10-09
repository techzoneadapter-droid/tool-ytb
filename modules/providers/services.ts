import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { codePath } from "../project/code-path";
import { pathToFileURL } from "node:url";
import { vieneuPaths } from "./vieneu-paths";

export type Service = "worker" | "korva" | "flux" | "fast" | "wan" | "vieneu" | "flow";
export const WORKER_PROTOCOL = 21;
export const FLOW_PROTOCOL = 23;
export async function alive(file: string) {
  try {
    const pid = Number(
      await readFile(/* turbopackIgnore: true */ file, "utf8"),
    );
    if (!Number.isInteger(pid) || pid < 1) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export async function acquireLock(file: string) {
  await mkdir(path.dirname(/* turbopackIgnore: true */ file), {
    recursive: true,
  });
  try {
    const handle = await open(/* turbopackIgnore: true */ file, "wx");
    await handle.writeFile(String(process.pid));
    await handle.close();
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  // An empty lock can belong to a process between open and write.
  const recovery = await open(
    /* turbopackIgnore: true */ file + ".reclaim",
    "wx",
  );
  try {
    const contents = await readFile(/* turbopackIgnore: true */ file, "utf8");
    if ((!contents.trim() && Date.now() - (await stat(file)).mtimeMs < 30000) || (await alive(file)))
      throw Error("Dịch vụ đang chạy hoặc đang khởi động.");
    await unlink(file);
    const handle = await open(/* turbopackIgnore: true */ file, "wx");
    await handle.writeFile(String(process.pid));
    await handle.close();
  } finally {
    await recovery.close();
    await unlink(file + ".reclaim").catch(() => {});
  }
}
export function serviceURL(service: Exclude<Service, "worker">) {
  const values = {
    korva: process.env.KORVA_LOCAL_URL || "http://127.0.0.1:7863",
    flux: process.env.FLUX2_WORKER_URL || "http://127.0.0.1:7861",
    fast: process.env.LOCAL_FAST_WORKER_URL || "http://127.0.0.1:7864",
    wan: process.env.WAN22_WORKER_URL || "http://127.0.0.1:7862",
    vieneu: process.env.VIENEU_LOCAL_URL || "http://127.0.0.1:8000",
    flow: process.env.FLOW_BRIDGE_URL || "http://127.0.0.1:7865",
  };
  const url = new URL(values[service]);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("Dịch vụ AI phải dùng HTTP trên máy cục bộ.");
  return url;
}
async function ready(service: Service) {
  if (service === "worker") {
    const lock = path.resolve("data/worker.lock");
    if (!(await alive(lock))) return false;
    try {
      const pid = Number(await readFile(lock, "utf8"));
      const health = JSON.parse(
        await readFile(path.resolve("data/worker.health.json"), "utf8"),
      );
      return (
        health.pid === pid &&
        health.protocol === WORKER_PROTOCOL &&
        Date.now() - health.time < 15000
      );
    } catch {
      return false;
    }
  }
  try {
    const response = await fetch(new URL("/health", serviceURL(service)), {
      signal: AbortSignal.timeout(1000),
      redirect: "error",
    });
    const health = await response.json();
    return (
      response.ok &&
      health.status === "ok" &&
      (service === "vieneu" || health.engine === service) &&
      (service !== "flow" || (health.protocol === FLOW_PROTOCOL && health.connectionMode === "python-headless-cookies" && health.bridgeReady === true && health.backgroundRestore === true))
    );
  } catch {
    return false;
  }
}
const starts = new Map<string, Promise<void>>();

export function startService(service: Service, options: { replaceFlowSession?: boolean } = {}): Promise<void> {
  const key = service;
  const pending = starts.get(key);
  if (pending) return pending;
  const task = (service === "flow" ? startFlowService(options) : start(service)).finally(() => starts.delete(key));
  starts.set(key, task);
  return task;
}

export function flowTimeout(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}

function flowStartFailure(message: string) {
  return Object.assign(new Error(message), { code: "FLOW_SERVICE_START_FAILED", stage: "FLOW_SERVICE_START" });
}

async function bridgeHealth() {
  try {
    const response = await fetch(new URL("/health", serviceURL("flow")), { signal: AbortSignal.timeout(500), redirect: "error" });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

export async function stopFlowService() {
  const pidFile = path.resolve("data/flow.service.pid");
  if (!(await alive(pidFile))) { await unlink(pidFile).catch(() => {}); return; }
  const health = await bridgeHealth();
  if (health && health.engine !== "flow") throw flowStartFailure("Port Flow đang được dịch vụ khác sử dụng.");
  const pid = Number(await readFile(pidFile, "utf8"));
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true });
      killer.on("error", reject);
      killer.on("close", () => resolve());
    });
  } else {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  const deadline = Date.now() + 10000;
  while (await alive(pidFile)) {
    if (Date.now() >= deadline) throw flowStartFailure("Worker Flow cũ chưa dừng; không khởi động worker thứ hai.");
    await new Promise(r => setTimeout(r, 100));
  }
  await unlink(pidFile).catch(() => {});
}

async function startFlowService(options: { replaceFlowSession?: boolean }) {
  const deadline = Date.now() + flowTimeout("FLOW_START_TIMEOUT_MS", 15000);
  const lockFile = path.resolve("data/flow.start.lock");
  const pidFile = path.resolve("data/flow.service.pid");
  let owned = false;
  try {
    if (await ready("flow")) return;
    while (!owned) {
      try { await acquireLock(lockFile); owned = true; }
      catch {
        if (await ready("flow")) return;
        if (Date.now() >= deadline) throw flowStartFailure("Hết thời gian chờ Flow Worker khởi động.");
        await new Promise(r => setTimeout(r, 100));
      }
    }
    if (await ready("flow")) return;
    if (await alive(pidFile)) {
      const health = await bridgeHealth();
      if (health?.engine === "flow" && (health.protocol !== FLOW_PROTOCOL || health.backgroundRestore !== true)) {
        if (health.connected && !options.replaceFlowSession && !existsSync(/* turbopackIgnore: true */ path.resolve(process.env.FLOW_COOKIES_FILE || "cookies.json")))
          throw Object.assign(new Error("Worker cũ đang giữ phiên Flow trong RAM; chưa có cookie file để khôi phục."), { code: "FLOW_LOGIN_REQUIRED", stage: "FLOW_SESSION_RESTORE" });
        await stopFlowService();
      } else {
        // Another starter already spawned the process. Wait, never spawn a second one.
        while (Date.now() < deadline) {
          if (await ready("flow")) return;
          if (!(await alive(pidFile))) break;
          await new Promise(r => setTimeout(r, 100));
        }
        if (await alive(pidFile)) throw flowStartFailure("Flow Worker chưa mở được health; tiến trình đang khởi động được giữ nguyên.");
      }
    }
    await unlink(pidFile).catch(() => {});
    let command = process.env.FLOW_PYTHON || path.resolve(".flow-venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    if (!existsSync(/* turbopackIgnore: true */ command)) throw flowStartFailure("Chưa cài backend Flow Python vào .flow-venv.");
    if (process.platform === "win32" && command.endsWith("python.exe")) {
      const silent = command.slice(0, -10) + "pythonw.exe";
      if (existsSync(/* turbopackIgnore: true */ silent)) command = silent;
    }
    const log = await open(path.resolve("data/flow.log"), "a");
    let failure = "";
    try {
      const child = spawn(/* turbopackIgnore: true */ command, [codePath("workers/flow_server.py")], {
        env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
        shell: false, windowsHide: true, detached: true, stdio: ["ignore", log.fd, log.fd],
      });
      child.on("error", e => { failure = e.message; });
      child.on("exit", code => { failure = `Flow Worker dừng (mã ${code}).`; });
      child.unref();
      if (child.pid) await writeFile(pidFile, String(child.pid));
    } finally { await log.close(); }
    while (Date.now() < deadline) {
      if (await ready("flow")) return;
      if (failure) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!(await alive(pidFile))) await unlink(pidFile).catch(() => {});
    throw flowStartFailure(failure || "Hết thời gian chờ health của Flow Worker. Xem Chi tiết dịch vụ.");
  } catch (error) {
    if (error instanceof Error && "code" in error && "stage" in error) throw error;
    throw flowStartFailure(error instanceof Error ? error.message : String(error));
  } finally { if (owned) await unlink(lockFile).catch(() => {}); }
}
async function start(service: Exclude<Service, "flow">) {
  if (await ready(service)) return;

  if (service === "worker") {
    const workerLock = path.resolve("data/worker.lock");
    if (await alive(workerLock)) {
      const pid = Number(
        await readFile(workerLock, "utf8").catch(() => "0"),
      );
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
        for (let i = 0; i < 20 && (await alive(workerLock)); i++)
          await new Promise((resolve) => setTimeout(resolve, 100));
        if (await alive(workerLock)) {
          if (process.platform === "win32") {
            await new Promise<void>((resolve) => {
              const killer = spawn(
                "taskkill",
                ["/PID", String(pid), "/T", "/F"],
                { shell: false, windowsHide: true },
              );
              killer.on("close", () => resolve());
              killer.on("error", () => resolve());
            });
          } else {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
        }
      }
      await unlink(workerLock).catch(() => {});
      await unlink(path.resolve("data/worker.health.json")).catch(() => {});
    }
  }
  const lock = path.resolve(`data/${service}.start.lock`);
  let owned = false;
  try {
    try {
      await acquireLock(lock);
      owned = true;
    } catch {
      for (let i = 0; i < 30; i++) {
        if (await ready(service)) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw Error("Dịch vụ chưa khởi động được. Xem nhật ký xử lý.");
    }
    if (await ready(service)) return;
    const pidFile = path.resolve(`data/${service}.service.pid`);
    if (service !== "worker" && (await alive(pidFile)))
      throw Error(
        `${service} đang khởi động hoặc nạp model. Chờ rồi thử lại; xem Chi tiết dịch vụ.`,
      );
    let command: string, args: string[], cwd: string | undefined;
    if (service === "worker") {
      command = process.execPath;
      args = ["--import", pathToFileURL(codePath("node_modules/tsx/dist/loader.mjs")).href, codePath("scripts/worker.ts")];
    } else if (service === "vieneu") {
      const runtime = vieneuPaths();
      cwd = runtime.directory;
      command = runtime.python;
      if (!existsSync(/* turbopackIgnore: true */ command))
        throw Error(
          "VieNeu-TTS chưa cài môi trường Python. Bấm Cài và khởi động VieNeu để app tự thiết lập.",
        );
      if (serviceURL(service).port !== "8000")
        throw Error(
          "VieNeu dùng cổng tùy chỉnh; cần cấu hình engine ngoài ứng dụng.",
        );
      args = ["-m", "apps.openai_speech"];
    } else {
      const environment = service === "korva" ? ".tts-venv" : ".ai-venv";
      const fromCLI =
        service === "korva" &&
        process.env.KORVATTS_BIN &&
        path.isAbsolute(process.env.KORVATTS_BIN)
          ? path.join(
              path.dirname(process.env.KORVATTS_BIN),
              process.platform === "win32" ? "python.exe" : "python",
            )
          : undefined;
      command =
        (service === "korva"
          ? process.env.KORVA_PYTHON
          : process.env.LOCAL_AI_PYTHON) ||
        fromCLI ||
        path.resolve(
          environment,
          process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
        );
      if (
        service === "korva" &&
        !process.env.KORVA_PYTHON &&
        !fromCLI &&
        !existsSync(/* turbopackIgnore: true */ command)
      )
        command = "python";
      if (
        path.isAbsolute(command) &&
        !existsSync(/* turbopackIgnore: true */ command)
      )
        throw Error(
          `${service === "korva" ? "KorvaTTS" : service === "flux" ? "FLUX.2" : "Wan2.2"} chưa cài môi trường Python (${environment}). Xem Chi tiết / tài liệu cài engine.`,
        );
      const url = serviceURL(service);
      args = [
        codePath(
          service === "korva"
            ? "workers/korva_server.py"
            : "workers/local_ai.py",
        ),
        ...(service === "korva" ? [] : ["--engine", service]),
        "--port",
        url.port || "80",
      ];
    }
    // pythonw has no console subsystem; detaching it keeps the resident model
    // alive across Next dev restarts without opening a black terminal.
    if(process.platform==='win32' && command.endsWith('python.exe')) {
      const silent=command.slice(0,-10)+'pythonw.exe';
      if(existsSync(/* turbopackIgnore: true */ silent))command=silent;
    }
    const log = await open(path.resolve(`data/${service}.log`), "a");
    let failure = "";
    const child = spawn(/* turbopackIgnore: true */ command, args, {
      cwd,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        ...(service === "vieneu" ? {
          PORT: "8000",
          ...(vieneuPaths().managed ? {
            VIENEU_BACKEND: process.env.VIENEU_BACKEND || "onnx",
            VIENEU_DEVICE: process.env.VIENEU_DEVICE || "cpu",
            VIENEU_PRECISION: process.env.VIENEU_PRECISION || "int8",
            HF_HOME: process.env.HF_HOME || path.resolve("data/huggingface"),
          } : {}),
        } : {}),
      },
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    child.on("error", (e) => {
      failure = e.message;
    });
    child.on("exit", (code) => {
      failure = `Dịch vụ dừng (mã ${code}).`;
    });
    child.unref();
    if (child.pid && service !== "worker")
      await writeFile(pidFile, String(child.pid));
    await log.close();
    // First launch downloads the model; installation runs outside the HTTP request.
    for (let i = 0; i < (service === "vieneu" ? 3600 : 240); i++) {
      if (await ready(service)) return;
      if (failure) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!failure && service !== "worker" && (await alive(pidFile)))
      throw Error(
        `${service} vẫn đang nạp model. Chờ rồi thử lại; tiến trình đã được giữ để tiếp tục khởi động.`,
      );
    const tail = (
      await readFile(path.resolve(`data/${service}.log`), "utf8").catch(
        () => "",
      )
    ).slice(-1200);
    throw Error(`Không khởi động được ${service}. ${failure} ${tail}`);
  } finally {
    if (owned) await unlink(lock).catch(() => {});
  }
}
