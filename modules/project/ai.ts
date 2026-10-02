import type { Settings } from "./types";
export async function rewrite(text: string, s: Settings) {
  if (s.mode === "original") return text;
  if (!process.env.OPENAI_API_KEY)
    throw Error("Chưa cấu hình API viết kịch bản");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.TEXT_MODEL || "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Viết kịch bản tiếng Việt, chỉ trả về nội dung. ${s.mode === "summary" ? "Tóm tắt còn khoảng 40% độ dài." : "Chuyển sang văn phong review hấp dẫn, giữ diễn biến chính."} Phong cách: ${s.customPrompt}`,
        },
        { role: "user", content: text },
      ],
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw Error(`Viết kịch bản thất bại (${r.status})`);
  const data = await r.json();
  return data.choices[0].message.content as string;
}
