"use client";
import { useMemo, useState } from "react";
import type { Project } from "@/modules/project/types";

function stamp(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${minutes}:${String(rest).padStart(2, "0")}`;
}
function safeFileName(name: string) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 90);
}
export function YoutubePublishPanel({ project, selectedIds, merged }: {
  project: Project;
  selectedIds: string[];
  merged: boolean;
}) {
  const [notice, setNotice] = useState("");
  const selected = useMemo(() => project.chapters.filter((c) => selectedIds.includes(c.id)), [project, selectedIds]);
  const storyTitle = project.storyTitle || project.name;
  const items = useMemo(() => selected.map((chapter) => {
    const index = project.chapters.findIndex((c) => c.id === chapter.id) + 1;
    const numberMatch = chapter.title.match(/^(?:Chương|Chapter)\s+(\d+)/iu);
    const number = numberMatch ? Number(numberMatch[1]) : index;
    const title = `${storyTitle} | Chương ${number}: ${chapter.title.replace(/^(?:Chương|Chapter)\s+[^:：.\-–—]+\s*[:：.\-–—]?\s*/iu, "") || chapter.title}`;
    // Only an estimate until completed media duration has been measured.
    const estimatedSeconds = chapter.scenes.reduce((sum, scene) => sum + Math.max(0, scene.duration || 0), 0);
    return { chapter, title, estimatedSeconds, number };
  }), [project, selected, storyTitle]);
  const playlistName = `${storyTitle} – Truyện Audio Trọn Bộ`;
  const summary = (project.synopsis || "").trim();
  const compilationTitle = `${storyTitle} | Tổng hợp chương ${items[0]?.number ?? 1}–${items[items.length - 1]?.number ?? 1} | Truyện Audio`;
  const titles = merged ? [compilationTitle] : items.map((item) => item.title);
  const descriptionFor = (index: number) => {
    const title = merged ? compilationTitle : items[index]?.title || storyTitle;
    const intro = summary ? `${summary}\n\n` : "";
    const chapterDetails = merged
      ? `\n\nDanh sách chương:\n${items.map((item) => `Chương ${item.number}: ${item.chapter.title}`).join("\n")}`
      : `\n\nChương ${items[index]?.number}: ${items[index]?.chapter.title || ""}`;
    return `${title}\n\n${intro}Truyện do tác giả kênh tự sáng tác và thực hiện.${chapterDetails}\n\nPlaylist: ${playlistName}\n#TruyenAudio #TruyenChu`;
  };
  const metadata = titles.map((title, index) => `${title}\n\n${descriptionFor(index)}`).join("\n\n==========\n\n");
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setNotice("Đã sao chép vào bộ nhớ tạm."); }
    catch { setNotice("Không thể sao chép tự động, vui lòng chọn và sao chép văn bản."); }
  };
  const download = () => {
    const blob = new Blob([metadata], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safeFileName(storyTitle) + "-youtube-metadata.txt";
    link.click();
    URL.revokeObjectURL(url);
    setNotice("Đã chuẩn bị file tiêu đề và mô tả.");
  };
  if (!items.length) return null;
  return (
    <section className="card" aria-label="Chuẩn bị xuất bản YouTube">
      <h2>Xuất bản YouTube</h2>
      <p className="muted">Chuẩn bị nội dung đăng YouTube từ các chương đã chọn; không tự đăng video và không thay đổi giọng đọc.</p>
      <p><strong>Playlist đề xuất:</strong> {playlistName}</p>
      {summary && <details><summary>Tóm tắt truyện để giới thiệu</summary><p style={{whiteSpace:"pre-wrap"}}>{summary}</p></details>}
      <div className="row" style={{flexWrap:"wrap",gap:8}}>
        <button type="button" className="secondary" onClick={() => void copy(playlistName)}>Sao chép tên playlist</button>
        <button type="button" className="secondary" onClick={() => void copy(metadata)}>Sao chép tiêu đề và mô tả</button>
        <button type="button" className="secondary" onClick={download}>Lưu nội dung đăng (.txt)</button>
      </div>
      <details>
        <summary>Xem trước {titles.length} tiêu đề video</summary>
        <ol>{titles.map((title, i) => <li key={i}>{title}</li>)}</ol>
      </details>
      {merged && (
        <p className="muted">Lưu ý: Mốc thời gian chính xác phải lấy từ file MP4 hoàn thành. Không tự điền timestamp ước tính vào mô tả YouTube.</p>
      )}
      {notice && <small role="status">{notice}</small>}
    </section>
  );
}
