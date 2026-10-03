import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { root } from "../project/store";
import { workerURL } from "./local-workers";

function executable(command: string) {
  return new Promise<boolean>((resolve) => {
    execFile(
      command,
      ["-version"],
      { timeout: 3000, windowsHide: true },
      (error) => resolve(!error),
    );
  });
}
async function localReady(engine: "flux" | "wan" | "fast") {
  try {
    const response = await fetch(workerURL(engine) + "/health", {
      signal: AbortSignal.timeout(2000),
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok) return false;
    const health = await response.json();
    return health.status === "ok" && health.engine === engine && health.available === true;
  } catch {
    return false;
  }
}
async function workerReady() {
  try {
    const pid = Number(await readFile(path.join(root, "worker.lock"), "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    const heartbeat = JSON.parse(
      await readFile(path.join(root, "worker.health.json"), "utf8"),
    );
    return heartbeat.pid === pid && Date.now() - heartbeat.time < 15000;
  } catch {
    return false;
  }
}
let cached:
  | {
      until: number;
      value: Promise<{ ffmpeg: boolean; flux: boolean; wan: boolean; fast:boolean }>;
    }
  | undefined;
export async function runtimeStatus() {
  if (!cached || cached.until < Date.now()) {
    cached = {
      until: Date.now() + 10000,
      value: (async () => {
        const [ffmpeg, ffprobe, flux, wan, fast] = await Promise.all([
          executable(process.env.FFMPEG_PATH || "ffmpeg"),
          executable(process.env.FFPROBE_PATH || "ffprobe"),
          localReady("flux"),
          localReady("wan"),
          localReady("fast"),
        ]);
        return { ffmpeg: ffmpeg && ffprobe, flux, wan, fast };
      })(),
    };
  }
  return { ...(await cached.value), worker: await workerReady() };
}
