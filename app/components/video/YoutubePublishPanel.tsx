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

/** Trích đoạn mô tả chính xác từ nội dung chương (không bịa đặt, lấy câu thật). */
function accurateChapterDescription(text: string, maxLen = 380): string {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const sentences = clean.split(/(?<=[.!?\u2026])\s+/u).filter((s) => s.trim().length > 10);
  let out = "";
  for (const sent of sentences) {
    const next = out ? out + " " + sent : sent;
    if (next.length > maxLen) break;
    out = next;
  }
  if (!out) out = clean.slice(0, maxLen);
  const trimmed = out.trim();
  return trimmed.length < clean.length ? trimmed.replace(/\s+\S*$/u, "") + "…" : trimmed;
}

export function YoutubePublishPanel({
  project,
  selectedIds,
  merged,
}: {
  project: Project;
  selectedIds: string[];
  merged: boolean;
}) {
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const selected = useMemo(
    () => project.chapters.filter((c) => selectedIds.includes(c.id)),
    [project, selectedIds],
  );
  const storyTitle = project.storyTitle || project.name;

  const items = useMemo(() => {
    return selected.map((chapter) => {
      const index = project.chapters.findIndex((c) => c.id === chapter.id) + 1;
      const numberMatch = chapter.title.match(/^(?:Chương|Chapter)\s+(\d+)/iu);
      const number = numberMatch ? Number(numberMatch[1]) : index;
      const cleanTitle = chapter.title.replace(
        /^(?:Chương|Chapter)\s+[^:：.\-–—]+\s*[:：.\-–—]?\s*/iu,
        "",
      );
      const title = `${storyTitle} | Chương ${number}: ${cleanTitle || chapter.title}`;
      const estimatedSeconds = chapter.scenes.reduce(
        (sum, scene) => sum + Math.max(0, scene.duration || 0),
        0,
      );
      const accurate = accurateChapterDescription(chapter.text);
      return { chapter, title, estimatedSeconds, number, accurate };
    });
  }, [project, selected, storyTitle]);

  const playlistName = `${storyTitle} – Truyện Audio Trọn Bộ`;
  const summary = (project.synopsis || "").trim();
  const compilationTitle = `${storyTitle} | Tổng hợp chương ${items[0]?.number ?? 1}–${items[items.length - 1]?.number ?? 1} | Truyện Audio`;

  const descriptionFor = (index: number) => {
    if (merged) {
      const list = items.map((item) => `Chương ${item.number}: ${item.chapter.title}`).join("\n");
      return `${compilationTitle}\n\n${summary ? summary + "\n\n" : ""}Danh sách chương:\n${list}\n\nTruyện do tác giả kênh tự sáng tác và thực hiện.\n\nPlaylist: ${playlistName}\n#TruyenAudio #TruyenChu`;
    }
    const item = items[index];
    if (!item) return "";
    const body = item.accurate || "Nội dung chương đang được chuẩn bị.";
    return `${item.title}\n\n${body}\n\nTruyện do tác giả kênh tự sáng tác và thực hiện.\n\nPlaylist: ${playlistName}\n#TruyenAudio #TruyenChu`;
  };

  const titles = merged ? [compilationTitle] : items.map((item) => item.title);
  const metadata = titles
    .map((title, index) => `${title}\n\n${descriptionFor(index)}`)
    .join("\n\n==========\n\n");

  const copy = async (value: string, label = "nội dung") => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`Đã sao chép ${label} vào bộ nhớ tạm.`);
    } catch {
      setNotice("Không thể sao chép tự động, vui lòng chọn và sao chép văn bản.");
    }
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
      <p className="muted" style={{ marginBottom: 12 }}>
        Tự động viết tiêu đề và mô tả chính xác từ nội dung từng chương. Không tự đăng video.
      </p>

      <div className="row between" style={{ marginBottom: 14, alignItems: "flex-start" }}>
        <div>
          <strong style={{ fontSize: 13 }}>Playlist đề xuất</strong>
          <p style={{ margin: "4px 0 0", fontSize: 13 }}>{playlistName}</p>
        </div>
        <button type="button" className="secondary" onClick={() => void copy(playlistName, "tên playlist")}>Sao chép</button>
      </div>

      {summary && (
        <details style={{ marginBottom: 12 }}>
          <summary>Tóm tắt truyện (giới thiệu)</summary>
          <p style={{ whiteSpace: "pre-wrap", marginTop: 8, fontSize: 13 }}>{summary}</p>
        </details>
      )}

      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        <button type="button" className="secondary" onClick={() => void copy(metadata, "toàn bộ tiêu đề + mô tả")}>Sao chép tất cả</button>
        <button type="button" className="secondary" onClick={download}>Lưu (.txt)</button>
      </div>

      <details open>
        <summary style={{ marginBottom: 10 }}>
          Danh sách {titles.length} video · Tiêu đề & Mô tả
        </summary>
        <div style={{ maxHeight: 420, overflow: "auto", display: "grid", gap: 10, paddingRight: 4 }}>
          {(merged ? [{ title: compilationTitle, accurate: summary || "Tổng hợp các chương đã chọn.", number: 0, chapter: { id: "merged", title: compilationTitle, text: "", scenes: [] } as any }] : items).map((item, index) => {
            const desc = descriptionFor(merged ? 0 : index);
            const isOpen = expanded === item.chapter.id;
            return (
              <div
                key={item.chapter.id || index}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "10px 12px",
                  background: "#fafafa",
                }}
              >
                <div className="row between" style={{ alignItems: "flex-start", gap: 8 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <strong style={{ fontSize: 13, display: "block", lineHeight: 1.35 }}>
                      {merged ? item.title : `${item.number}. ${item.title}`}
                    </strong>
                    <p className="muted" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>
                      {item.accurate || "(Chưa có nội dung mô tả)"}
                    </p>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
                    <button type="button" className="text-button" style={{ fontSize: 11, padding: "2px 0" }} onClick={() => void copy(item.title, "tiêu đề")}>
                      Sao chép tiêu đề
                    </button>
                    <button type="button" className="text-button" style={{ fontSize: 11, padding: "2px 0" }} onClick={() => void copy(desc, "mô tả")}>
                      Sao chép mô tả
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  className="text-button"
                  style={{ fontSize: 11, marginTop: 6, padding: 0 }}
                  onClick={() => setExpanded(isOpen ? null : item.chapter.id)}
                >
                  {isOpen ? "▼ Ẩn mô tả đầy đủ" : "▶ Xem mô tả đầy đủ"}
                </button>
                {isOpen && (
                  <pre style={{ marginTop: 8, fontSize: 12, background: "#fff", padding: 8, borderRadius: 6, border: "1px solid var(--border)" }}>
                    {desc}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      </details>

      {merged && (
        <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
          Lưu ý: Mốc thời gian chính xác phải lấy từ file MP4 hoàn thành. Không tự điền timestamp ước tính vào mô tả YouTube.
        </p>
      )}
      {notice && <small role="status" style={{ display: "block", marginTop: 10 }}>{notice}</small>}
    </section>
  );
}
