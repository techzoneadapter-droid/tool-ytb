import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type Service = "worker" | "korva" | "flux" | "fast" | "wan" | "vieneu" | "flow";
export const WORKER_PROTOCOL = 6;
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
    if (!contents.trim() || (await alive(file)))
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
      (service === "vieneu" || health.engine === service)
    );
  } catch {
    return false;
  }
}
const starts = new Map<Service, Promise<void>>();

async function runSetupCommand(
  command: string,
  args: string[],
  cwd?: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(/* turbopackIgnore: true */ command, args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            Error(
              `Lệnh cài môi trường thất bại (${command}, mã ${code ?? "?"}).`,
            ),
          ),
    );
  });
}

async function ensureFlowPython() {
  const environment = path.resolve(".flow-venv");
  const python = path.join(
    environment,
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  if (existsSync(/* turbopackIgnore: true */ python)) return python;

  const launcher = process.env.PYTHON || (process.platform === "win32" ? "py" : "python3");
  const launcherArgs =
    process.platform === "win32" && launcher === "py"
      ? ["-3", "-m", "venv", environment]
      : ["-m", "venv", environment];
  await runSetupCommand(launcher, launcherArgs);

  const pipArgs = [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "-r",
    path.resolve("workers/flow_requirements.txt"),
  ];
  await runSetupCommand(python, pipArgs);
  return python;
}
export function startService(service: Service): Promise<void> {
  const pending = starts.get(service);
  if (pending) return pending;
  const task = start(service).finally(() => starts.delete(service));
  starts.set(service, task);
  return task;
}
async function start(service: Service) {
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
      args = ["--import", "tsx", path.resolve("scripts/worker.ts")];
    } else if (service === "flow") {
      command = process.env.FLOW_PYTHON || (await ensureFlowPython());
      args = [path.resolve("workers/flow_selenium.py")];
    } else if (service === "vieneu") {
      cwd =
        process.env.VIENEU_REPO_DIR ||
        path.resolve(/* turbopackIgnore: true */ "..", "VieNeu-TTS");
      command = path.join(
        cwd,
        ".venv",
        process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
      );
      if (!existsSync(/* turbopackIgnore: true */ command))
        throw Error(
          "VieNeu-TTS chưa cài môi trường Python. Xem Chi tiết / LOCAL_TTS.md.",
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
        path.resolve(
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
        ...(service === "vieneu" ? { PORT: "8000" } : {}),
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
    for (let i = 0; i < 240; i++) {
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
