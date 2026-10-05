import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isSameOrigin } from "@/modules/project/request";
import { imageAPIStatus } from "@/modules/providers/image-api";
import { connectImageAPI, selectImageModel } from "@/modules/providers/image-api-connect";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
export async function GET() {
  return NextResponse.json({ ok: true, providers: imageAPIStatus() }, { headers });
}
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ ok: false, error: "Nguồn yêu cầu không hợp lệ." }, { status: 403, headers });
  try {
    const body = z.discriminatedUnion("action", [
      z.object({ action: z.literal("connect"), provider: z.enum(["openai", "gemini", "stability"]), key: z.string().trim().max(1024).optional() }),
      z.object({ action: z.literal("select"), provider: z.enum(["openai", "gemini", "stability"]), model: z.string().regex(/^[a-zA-Z0-9._-]+$/).max(150) }),
    ]).parse(await req.json());
    const result = body.action === "connect" ? await connectImageAPI(body.provider, body.key) : selectImageModel(body.provider, body.model);
    return NextResponse.json({ ok: true, ...result, providers: imageAPIStatus() }, { headers });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof z.ZodError ? "Thông tin kết nối không hợp lệ." : error instanceof Error ? error.message : "Không kết nối được API." }, { status: 400, headers });
  }
}
