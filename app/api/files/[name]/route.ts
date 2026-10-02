import { NextRequest } from "next/server";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { root } from "@/modules/project/store";
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!/^[a-f0-9-]+\.(png|jpg|jpeg|webp|wav|mp3|mp4|srt|vtt)$/.test(name))
    return new Response("Not found", { status: 404 });
  try {
    const file = path.join(root, "assets", name);
    const info = await stat(file);
    const mime: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".mp4": "video/mp4",
      ".srt": "text/plain; charset=utf-8",
      ".vtt": "text/vtt; charset=utf-8",
    };
    const headers: Record<string, string> = {
      "Content-Type": mime[path.extname(name)] || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
    };
    let start = 0,
      end = info.size - 1;
    const range = req.headers.get("range");
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${info.size}` },
        });
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), end) : end;
      if (start > end || start >= info.size)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${info.size}` },
        });
      headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
    }
    headers["Content-Length"] = String(end - start + 1);
    const stream = Readable.toWeb(
      createReadStream(file, { start, end }),
    ) as ReadableStream<Uint8Array>;
    return new Response(stream, { status: range ? 206 : 200, headers });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
