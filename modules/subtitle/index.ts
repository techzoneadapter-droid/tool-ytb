import type { Scene } from "../project/types";
function time(sec: number, vtt = false) {
  const n = Math.round(sec * 1000);
  return `${String(Math.floor(n / 3600000)).padStart(2, "0")}:${String(Math.floor(n / 60000) % 60).padStart(2, "0")}:${String(Math.floor(n / 1000) % 60).padStart(2, "0")}${vtt ? "." : ","}${String(n % 1000).padStart(3, "0")}`;
}
export function subtitles(scenes: Scene[], vtt = false) {
  let offset = 0,
    index = 0;
  const cues: string[] = [];
  for (const s of scenes) {
    const words = s.text.trim() ? s.text.trim().split(/\s+/) : [];
    for (let i = 0; i < words.length; i += 12) {
      const end = Math.min(i + 12, words.length);
      cues.push(
        `${++index}\n${time(offset + (s.duration * i) / words.length, vtt)} --> ${time(offset + (s.duration * end) / words.length, vtt)}\n${words.slice(i, end).join(" ")}`,
      );
    }
    offset += s.duration;
  }
  return (vtt ? "WEBVTT\n\n" : "") + cues.join("\n\n") + "\n";
}
