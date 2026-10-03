import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { POST as studioPost } from "../../studio/route";
import { isSameOrigin } from "@/modules/project/request";
import { defaults } from "@/modules/project/types";
import { makeImage } from "@/modules/imagePrompt";
import { styledPrompt } from "@/modules/imagePrompt/styles";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  try {
    if (!isSameOrigin(req))
      return NextResponse.json(
        { ok: false, error: "Nguồn yêu cầu không hợp lệ." },
        { status: 403 },
      );
    const body = await req.json();
    if (body.projectId)
      return studioPost(
        new NextRequest(new URL("/api/studio", req.url), {
          method: "POST",
          headers: req.headers,
          body: JSON.stringify({ ...body, action: "enqueue", kind: "image" }),
        }),
      );
    const b = z
      .object({
        prompt: z.string().trim().min(1).max(4000),
        provider: z
          .enum(["flux2-local", "local-fast", "auto-local", "openai"])
          .default("flux2-local"),
        enabled: z.boolean().default(true),
        aspect: z.enum(["16:9", "9:16"]).default("16:9"),
        style: z.string().max(100).optional(),
      })
      .parse(body);
    const file = randomUUID() + ".png";
    await makeImage(
      b.style ? styledPrompt(b.prompt, b.style) : b.prompt,
      path.resolve("data/assets", file),
      {
        ...defaults,
        imageEnabled: b.enabled,
        imageProvider: b.provider,
        aspect: b.aspect,
      },
    );
    return NextResponse.json({
      ok: true,
      file,
      imageUrl: "/generated/images/" + file,
    });
  } catch (e) {
    const error =
      e instanceof z.ZodError
        ? "Thông tin tạo ảnh không hợp lệ."
        : e instanceof Error
          ? e.message
          : "Không tạo được ảnh.";
    return NextResponse.json(
      { ok: false, error, message: error },
      { status: 400 },
    );
  }
}
