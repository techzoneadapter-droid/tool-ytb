import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSameOrigin } from "@/modules/project/request";
import { codePath } from "@/modules/project/code-path";
import { alive } from "@/modules/providers/services";
export const runtime = "nodejs";
const statusFile = path.resolve("data/ai-setup-status.json");
const pidFile = path.resolve("data/ai-setup.pid");
export async function GET() {
  const [status, log, hardware] = await Promise.all([
    readFile(statusFile, "utf8")
      .then(JSON.parse)
      .catch(() => ({ state: "idle" })),
    readFile(path.resolve("data/ai-setup-ui.log"), "utf8").catch(() => ""),
    readFile(path.resolve("data/ai-hardware.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null),
  ]);
  if (status.state === "running" && !(await alive(pidFile)))
    status.state = "interrupted";
  return NextResponse.json({ ...status, log: log.slice(-4000), hardware });
}
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req))
    return NextResponse.json(
      { error: "Nguồn yêu cầu không hợp lệ" },
      { status: 403 },
    );
  try {
    const b = await req.json();
    if (!["install", "download"].includes(b.action))
      throw Error("Tác vụ không hợp lệ");
    if (b.action === "download" && b.confirmed !== true)
      throw Error("Cần xác nhận tải model khoảng 2,6 GB.");
    if (process.platform !== "win32")
      throw Error("Script thiết lập này dành cho Windows.");
    if (await alive(pidFile)) throw Error("Thiết lập đang chạy.");
    await mkdir(path.resolve("data"), { recursive: true });
    const log = await open(path.resolve("data/ai-setup-ui.log"), "w");
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        codePath("scripts/setup-local-ai.ps1"),
        ...(b.action === "download" ? ["-DownloadModel"] : []),
      ],
      { windowsHide: true, shell: false, stdio: ["ignore", log.fd, log.fd] },
    );
    const save = (state: string, detail?: string) =>
      writeFile(
        statusFile,
        JSON.stringify({
          state,
          detail,
          action: b.action,
          updatedAt: new Date().toISOString(),
        }),
      );
    await save("running");
    if (child.pid) await writeFile(pidFile, String(child.pid));
    child.on("error", (e) => void save("error", e.message));
    child.on(
      "exit",
      (code) => void save(code === 0 ? "done" : "error", `Exit ${code}`),
    );
    child.unref();
    await log.close();
    return NextResponse.json({ ok: true, state: "running" });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
