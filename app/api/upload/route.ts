import { NextRequest, NextResponse } from "next/server";
import mammoth from "mammoth";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { root, put } from "@/modules/project/store";
import { isSameOrigin } from "@/modules/project/request";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  try {
    if (!isSameOrigin(req))
      return NextResponse.json(
        {
          error:
            "Yêu cầu không xuất phát từ cửa sổ ứng dụng hiện tại. Vui lòng tải lại trang.",
        },
        { status: 403 },
      );
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size > 30 * 1024 * 1024)
      throw Error("Vui lòng chọn tệp có kích thước tối đa 30 MB.");
    const ext = path.extname(file.name).toLowerCase();
    const buffer = Buffer.from(await file.arrayBuffer());
    if (ext === ".txt")
      return NextResponse.json({ text: buffer.toString("utf8") });
    if (ext === ".docx") {
      try {
        return NextResponse.json({
          text: (await mammoth.extractRawText({ buffer })).value,
        });
      } catch {
        throw Error(
          "Không đọc được tệp DOCX. Vui lòng kiểm tra tệp hoặc lưu lại nội dung dưới dạng TXT.",
        );
      }
    }
    if (
      ![".png", ".jpg", ".jpeg", ".webp", ".wav", ".mp3", ".mp4"].includes(ext)
    )
      throw Error("Định dạng không hỗ trợ");
    const id =
      randomUUID() +
      ([".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ".png" : ext);
    await mkdir(path.join(root, "assets"), { recursive: true });
    if (id.endsWith(".png"))
      await sharp(buffer, { limitInputPixels: 40000000 })
        .resize(1920, 1920, { fit: "inside", withoutEnlargement: true })
        .png()
        .toFile(path.join(root, "assets", id));
    else await writeFile(path.join(root, "assets", id), buffer);
    put("upload", { id, createdAt: new Date().toISOString() });
    return NextResponse.json({ asset: id });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error && /[À-ỹ]/u.test(e.message)
            ? e.message
            : "Không tải được tệp. Vui lòng kiểm tra định dạng và thử lại.",
      },
      { status: 400 },
    );
  }
}
