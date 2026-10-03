import { NextRequest, NextResponse } from "next/server";
import { randomUUID, createHash } from "node:crypto";
import { stat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isSameOrigin } from "../project/request";
import { defaults } from "../project/types";
import { root } from "../project/store";
import { defaultTTSProvider, speak } from "./index";

const sample = "Xin chào, hãy cùng nghe câu chuyện hôm nay.";
export async function ttsRequest(req: NextRequest, preview: boolean) {
  try {
    if (!isSameOrigin(req))
      return NextResponse.json(
        {
          ok: false,
          message: "Nguồn yêu cầu không hợp lệ.",
          error: "Nguồn yêu cầu không hợp lệ.",
        },
        { status: 403 },
      );
    const b = z
      .object({
        provider: z
          .enum(["modal-vieneu", "pollinations", "vieneu-local", "korva-local", "tts-studio-local", "cloud"])
          .optional(),
        voiceId: z.string().min(1).max(100).optional(),
        voice: z.string().min(1).max(100).optional(),
        text: z
          .string()
          .trim()
          .min(1)
          .max(preview ? 2000 : 20000)
          .optional(),
        format: z.enum(["wav", "mp3"]).default("mp3"),
        speed: z.number().min(0.5).max(2).default(1),
        pitch: z.number().min(-6).max(6).default(0),
        volume: z.number().min(0).max(2).default(1),
      })
      .parse(await req.json());
    if (!preview && !b.text) throw Error("Vui lòng nhập nội dung cần đọc.");
    const provider = b.provider || (b.voice ? "cloud" : defaultTTSProvider());
    const voiceId =
      b.voiceId ||
      b.voice ||
      process.env.DEFAULT_VIETNAMESE_VOICE ||
      "ngoc_huyen";
    const file =
      (preview
        ? createHash("sha256")
            .update(JSON.stringify(["preview-v1", provider, voiceId, b.speed]))
            .digest("hex")
        : randomUUID()) +
      "." +
      (preview ? "mp3" : b.format);
    const output = path.join(root, "assets", file);
    if (preview) {
      try {
        const [info, meta] = await Promise.all([
          stat(output),
          readFile(output + ".json", "utf8").then(JSON.parse),
        ]);
        if (
          info.size > 0 &&
          meta.size === info.size &&
          meta.mtime === info.mtimeMs &&
          meta.duration > 0
        )
          return NextResponse.json({
            ok: true,
            audioUrl: "/api/files/" + file,
            file,
            duration: meta.duration,
            provider,
            voiceId,
            cached: true,
          });
      } catch {
        /* first preview */
      }
    }
    const seconds = await speak(
      preview ? sample : b.text!,
      output,
      {
        ...defaults,
        ...b,
        provider: defaults.provider,
        ttsProvider: provider,
        voice: voiceId,
        pause: 0,
        ...(preview ? { pitch: 0, volume: 1 } : {}),
      },
      { preview },
    );
    if (preview) {
      const info = await stat(output);
      await writeFile(
        output + ".json",
        JSON.stringify({
          size: info.size,
          mtime: info.mtimeMs,
          duration: seconds,
        }),
      );
    }
    return NextResponse.json({
      ok: true,
      audioUrl: "/generated/audio/" + file,
      file,
      duration: seconds,
      provider,
      voiceId,
      cached: false,
    });
  } catch (e) {
    const message =
      e instanceof z.ZodError
        ? "Thông tin giọng đọc không hợp lệ. Kiểm tra nội dung, engine, tốc độ và định dạng."
        : e instanceof Error
          ? e.message
          : "Không tạo được lời đọc.";
    return NextResponse.json(
      { ok: false, message, error: message },
      { status: 400 },
    );
  }
}
