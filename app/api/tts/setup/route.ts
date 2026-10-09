import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { alive } from "@/modules/providers/services";
import { isSameOrigin } from "@/modules/project/request";
import { launchVieneuSetup } from "@/modules/providers/vieneu-setup";

export const runtime = "nodejs";
const lock = path.resolve("data/vieneu-setup.lock");
export async function GET() {
  const status = await readFile(path.resolve("data/vieneu-setup.json"), "utf8")
    .then(JSON.parse)
    .catch(() => ({ state: "idle" }));
  let log = await readFile(path.resolve("data/vieneu-setup.log"), "utf8").catch(
    () => "",
  );
  if (status.stage === "model" || status.state === "error") {
    log +=
      "\n" +
      (await readFile(path.resolve("data/vieneu.log"), "utf8").catch(() => ""));
  }
  if (status.state === "running" && !(await alive(lock))) {
    status.state = "interrupted";
    status.detail =
      "Cài đặt bị gián đoạn. Bấm Cài và khởi động VieNeu để tiếp tục.";
  }
  return NextResponse.json({ ...status, log: log.slice(-4000) });
}
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req))
    return NextResponse.json(
      { error: "Nguồn yêu cầu không hợp lệ." },
      { status: 403 },
    );
  try {
    if ((await req.json()).action !== "install")
      throw Error("Tác vụ không hợp lệ.");
    if (process.platform !== "win32")
      throw Error("Cài VieNeu tự động hiện dành cho Windows.");
    await launchVieneuSetup();
    return NextResponse.json({ ok: true, state: "running" }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
