import { NextRequest, NextResponse } from "next/server";
import { POST as studioPost } from "../../studio/route";
import { isSameOrigin } from "@/modules/project/request";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  try {
    if (!isSameOrigin(req))
      return NextResponse.json(
        { ok: false, error: "Nguồn yêu cầu không hợp lệ." },
        { status: 403 },
      );
    const body = await req.json();
    const r = await studioPost(
      new NextRequest(new URL("/api/studio", req.url), {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify({ ...body, action: "enqueue", kind: "motion" }),
      }),
    );
    const data = await r.json();
    return NextResponse.json(
      r.ok
        ? { ok: true, jobs: data, jobId: data[0].id }
        : { ok: false, ...data },
      { status: r.status },
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "Yêu cầu tạo ảnh động không hợp lệ." },
      { status: 400 },
    );
  }
}
