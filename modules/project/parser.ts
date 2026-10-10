import { randomUUID } from "node:crypto";
import type { Chapter, Scene } from "./types";

const BASIC_NARRATION_PUNCTUATION = new Set([
  ".", ",", "!", "?", ":", ";", "…", "-", "–", "—", "(", ")", '"', "'",
]);

export function cleanNarrationText(input: string): string {
  let text = input
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/https?:\/\/\S+|www\.\S+/giu, " ")
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu, " ")
    .replace(/^\s{0,3}#{1,6}\s*/gmu, "")
    .replace(/^\s*>+\s?/gmu, "")
    .replace(/^\s*[-+*•▪◦‣⁃]+\s+/gmu, "")
    .replace(/^\s*\d+[.)]\s+/gmu, "")
    .replace(/_/gu, " ")
    .replace(/(\*\*|__|~~|\*|[\x60]{1,3})/gu, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ");

  let out = "";
  for (const char of text) {
    if (
      /[\p{L}\p{M}\p{N}]/u.test(char) ||
      /\s/u.test(char) ||
      BASIC_NARRATION_PUNCTUATION.has(char)
    ) out += char;
    else out += " ";
  }

  return out
    .replace(/[ \t]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/\.{4,}/gu, "…")
    .replace(/…{2,}/gu, "…")
    .replace(/!{2,}/gu, "!")
    .replace(/\?{2,}/gu, "?")
    .replace(/,{2,}/gu, ",")
    .replace(/;{2,}/gu, ";")
    .replace(/:{2,}/gu, ":")
    .replace(/\s+([.,!?:;…])/gu, "$1")
    .replace(/([.,!?:;…])(?=[\p{L}\p{N}])/gu, "$1 ")
    .trim();
}

export function sanitizeNarrationText(input: string) {
  const cleaned = cleanNarrationText(input);
  if (cleaned !== input) console.debug(`TEXT_SANITIZED inputLength=${input.length} outputLength=${cleaned.length} removed=${Math.max(0, input.length - cleaned.length)}`);
  return cleaned;
}
export function chunks(text: string, max = 550): string[] {
  const cleaned = cleanNarrationText(text);
  if (!cleaned) return [];
  // Prefer complete spoken sentences. Unlike the old word loop, this keeps
  // punctuation attached and never cuts through a Vietnamese word.
  const sentences = cleaned.match(/[^.!?…\n]+[.!?…]*|[.!?…]+/gu) || [];
  const out: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) out.push(current.trim());
    current = "";
  };
  const add = (part: string) => {
    part = part.trim();
    if (!part) return;
    if (!current) current = part;
    else if (current.length + part.length + 1 <= max) current += " " + part;
    else {
      flush();
      current = part;
    }
  };
  for (const sentence of sentences) {
    const value = sentence.trim();
    if (!value) continue;
    if (value.length <= max) {
      add(value);
      continue;
    }
    // Only an unusually long sentence is split, at whitespace boundaries.
    // Preserve its original punctuation and spelling for narration.
    for (const word of value.split(/\s+/u)) {
      if (word.length > max) {
        flush();
        // Protect the engine's strict character limit even when importing
        // malformed text with no spaces. Split only this exceptional case;
        // never drop characters.
        for (let i = 0; i < word.length; i += max)
          out.push(word.slice(i, i + max));
      } else add(word);
    }
    flush();
  }
  flush();
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
// Extract explicitly labelled synopsis text before chapter parsing. It is
// project metadata, not chapter narration. Unlabelled prefaces stay untouched.
export function extractStoryStructure(input: string) {
  const normalized = input.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").normalize("NFC");
  const lines = normalized.split("\n");
  const chapterHeading = /^\s*(?:#{1,6}\s*)?(?:chương|chapter|tập|phần)\s+(?:\d+|[IVXLCDM]+|một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười)(?=\s|[:.\-–—]|$)/iu;
  const synopsisHeading = /^\s*(?:#{1,6}\s*)?(?:tóm\s*tắt(?:\s+(?:nội\s*dung|truyện))?|nội\s*dung\s*tóm\s*tắt|giới\s*thiệu(?:\s*truyện)?|văn\s*án|synopsis)\s*[:：-]?\s*(.*)$/iu;
  const titleHeading = /^\s*(?:tên\s*truyện|tựa\s*truyện)\s*[:：]\s*(.+)$/iu;
  const firstChapter = lines.findIndex((line) => chapterHeading.test(line.trim().replace(/^\*\*(.*?)\*\*$/u, "$1")));
  const cutoff = firstChapter >= 0 ? firstChapter : lines.length;
  let summaryStart = -1;
  let inline = "";
  let title: string | undefined;
  for (let i = 0; i < cutoff; i++) {
    const line = lines[i].trim().replace(/^\*\*(.*?)\*\*$/u, "$1");
    if (summaryStart < 0) {
      const t = titleHeading.exec(line);
      if (t) title = cleanNarrationText(t[1]);
      const match = synopsisHeading.exec(line);
      if (match) { summaryStart = i; inline = match[1]; }
    }
  }
  if (summaryStart < 0) return { title, summary: "", body: normalized.trim(), hasSummary: false };
  const summary = cleanNarrationText([inline, ...lines.slice(summaryStart + 1, cutoff)].join("\n"));
  const body = [...lines.slice(0, summaryStart), ...lines.slice(cutoff)].join("\n").trim();
  return { title, summary, body, hasSummary: Boolean(summary) };
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
    const cleaned = cleanNarrationText(group.text.join("\n"));
    if (cleaned) groups.push({ ...group, text: [cleaned] });
    group = { text: [] };
  };
  for (const line of text.split("\n")) {
    const marker = line
      .trim()
      .replace(/^#{1,6}\s*/, "")
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
  if (!groups.length)
    groups.push({ title: "Chương 1", text: [cleanNarrationText(text) || text] });
  return groups.map((g, i) => {
    const chapterText = cleanNarrationText(g.text.join("\n"));
    return {
      id: randomUUID(),
      title: cleanNarrationText(g.title || `Chương ${i + 1}`),
      text: chapterText,
      scenes: plan(chapterText),
    };
  });
}
