import { randomUUID } from "node:crypto";
import type { Chapter, Scene } from "./types";
export function chunks(text: string, max = 550): string[] {
  const sentences =
    text.replace(/\r/g, "").match(/[^.!?\n]+[.!?]*/g) ||
    (text.trim() ? [text.trim()] : []);
  const out: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    for (const word of words) {
      if (current.length + word.length + 1 > max && current) {
        out.push(current);
        current = "";
      }
      if (word.length > max) {
        if (current) {
          out.push(current);
          current = "";
        }
        for (let i = 0; i < word.length; i += max)
          out.push(word.slice(i, i + max));
      } else current += (current ? " " : "") + word;
    }
  }
  if (current) out.push(current);
  return out;
}
export function plan(text: string, style = "Điện ảnh"): Scene[] {
  return chunks(text).map((text) => ({
    id: randomUUID(),
    text,
    prompt: `${style}. Minh họa cảnh truyện: ${text}. Nhất quán nhân vật, không chữ, không dấu bản quyền.`,
    duration: Math.max(3, text.split(/\s+/).length / 2.8),
    approved: false,
  }));
}
export function parseChapters(input: string): Chapter[] {
  const text = input
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .trim();
  if (!text) throw Error("Nội dung truyện đang trống.");
  // Markers are recognized only on their own line. Never split inline mentions.
  const numberWord =
    "(?:không|một|mốt|hai|ba|bốn|tư|năm|lăm|sáu|bảy|tám|chín|mười|mươi|trăm|nghìn|ngàn|linh|lẻ)";
  const number = `(?:\\d+|[IVXLCDM]+|${numberWord}(?:[ \\t]+${numberWord})*)`;
  const heading = new RegExp(
    `^(chương|chapter|tập|phần)\\s+(${number})(?=\\s|[:.\\-–—]|$)`,
    "iu",
  );
  const ending = new RegExp(
    `^hết\\s+(chương|chapter|tập|phần)\\s+(${number})[.!…]?\\s*$`,
    "iu",
  );
  const groups: { title?: string; text: string[] }[] = [];
  let group: { title?: string; text: string[] } = { text: [] };
  const flush = () => {
    if (group.text.join("\n").trim()) groups.push(group);
    group = { text: [] };
  };
  for (const line of text.split("\n")) {
    const marker = line
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^(\*\*|__)(.*?)\1$/u, "$2")
      .trim();
    const end = ending.exec(marker);
    if (end) {
      if (!group.title)
        group.title = `${end[1][0].toLocaleUpperCase("vi-VN")}${end[1].slice(1).toLocaleLowerCase("vi-VN")} ${end[2]}`;
      flush();
    } else if (heading.test(marker)) {
      flush();
      group.title = marker;
    } else group.text.push(line);
  }
  flush();
  // Even a document made solely of headings must not produce a zero-chapter project.
  if (!groups.length) groups.push({ title: "Chương 1", text: [text] });
  return groups.map((g, i) => ({
    id: randomUUID(),
    title: g.title || `Chương ${i + 1}`,
    text: g.text.join("\n").trim(),
    scenes: plan(g.text.join("\n")),
  }));
}
