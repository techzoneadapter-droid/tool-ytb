import { NextRequest } from "next/server";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
export const runtime = "nodejs";
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ kind: string; name: string }> },
) {
  const { kind, name } = await context.params;
  const valid: Record<string, RegExp> = {
    audio: /^[a-f0-9-]+\.(wav|mp3)$/,
    images: /^[a-f0-9-]+\.png$/,
    motion: /^[a-f0-9-]+\.mp4$/,
  };
  if (!Object.hasOwn(valid, kind) || !valid[kind].test(name))
    return new Response("Không tìm thấy tệp.", { status: 404 });
  try {
    const file = path.resolve("public/generated", kind, name);
    const info = await stat(file);
    if (!info.isFile() || !info.size) throw Error("Missing file");
    const mime: Record<string, string> = {
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".png": "image/png",
      ".mp4": "video/mp4",
    };
    const headers: Record<string, string> = {
      "Content-Type": mime[path.extname(name)],
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
    };
    const range = req.headers.get("range");
    let start = 0,
      end = info.size - 1;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (!m[1] && !m[2]))
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${info.size}` },
        });
      if (!m[1]) start = Math.max(0, info.size - Number(m[2]));
      else {
        start = Number(m[1]);
        if (m[2]) end = Math.min(end, Number(m[2]));
      }
      if (start > end || !Number.isSafeInteger(start) || start < 0)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${info.size}` },
        });
      headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
    }
    headers["Content-Length"] = String(end - start + 1);
    return new Response(
      Readable.toWeb(
        createReadStream(file, { start, end }),
      ) as ReadableStream<Uint8Array>,
      { status: range ? 206 : 200, headers },
    );
  } catch {
    return new Response("Không tìm thấy tệp.", { status: 404 });
  }
}
