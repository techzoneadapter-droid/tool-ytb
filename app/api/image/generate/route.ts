import { NextRequest, NextResponse } from "next/server";
import { isSameOrigin } from "@/modules/project/request";
import { imageGenerationRemoved } from "@/modules/project/uploaded-image";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req))
    return NextResponse.json(
      { ok: false, error: "Nguồn yêu cầu không hợp lệ." },
      { status: 403 },
    );
  return NextResponse.json(
    { ok: false, error: imageGenerationRemoved },
    { status: 410 },
  );
}
