"use client";
import { useEffect, useState } from "react";
import {
  Upload,
  ArrowRight,
  BookOpen,
  MoreHorizontal,
  FileText,
} from "lucide-react";
import type { Project } from "@/modules/project/types";
import { request, upload } from "../studio-api";
export function StoryImportPage({
  projects,
  refresh,
  onOpen,
}: {
  projects: Project[];
  refresh: () => Promise<void>;
  onOpen: (id: string) => void;
}) {
  const [name, setName] = useState(""),
    [text, setText] = useState(""),
    [split, setSplit] = useState(true),
    [chapters, setChapters] = useState<{ title: string; length?: number; sample?: string }[]>([]),
    [omitted, setOmitted] = useState<number[]>([]),
    [showAllChapters, setShowAllChapters] = useState(false),
    [synopsis, setSynopsis] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [created, setCreated] = useState<Project>(),
    [file, setFile] = useState<File>(),
    [drag, setDrag] = useState(false);
  useEffect(() => {
    let active = true;
    setChapters([]);
    setOmitted([]);
    setSynopsis("");
    if (!text.trim()) return;
    const timer = setTimeout(() => {
      request<{ chapters: { title: string; length?: number; sample?: string }[]; synopsis: string }>({
        action: "previewStructure",
        text,
        splitChapters: split,
      })
        .then((result) => {
          if (active) {
            setChapters(result.chapters);
            setSynopsis(result.synopsis);
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }, 450);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [text, split]);
  async function readFile(f?: File) {
    if (!f) return;
    setError("");
    setBusy(true);
    try {
      if (!/\.(txt|docx)$/i.test(f.name))
        throw Error("Vui lòng chọn tệp TXT hoặc DOCX.");
      const d = await upload(f);
      setText(d.text || "");
      setFile(f);
      setCreated(undefined);
      if (!name) setName(f.name.replace(/\.[^.]+$/, ""));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    setBusy(true);
    setError("");
    try {
      const p = await request<Project>({
        action: "create",
        name,
        text,
        splitChapters: split,
        omittedChapterIndices: omitted,
      });
      setCreated(p);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function manage(p: Project, action: "rename" | "delete") {
    const value =
      action === "rename"
        ? window.prompt("Tên dự án mới", p.name)
        : window.confirm(
            `Xóa dự án “${p.name}”? Thao tác này xóa dự án và lịch sử video, giữ tệp tài nguyên trên máy.`,
          );
    if (!value) return;
    setBusy(true);
    try {
      await request({
        action,
        projectId: p.id,
        ...(action === "rename" ? { name: value } : {}),
      });
      await refresh();
      if (created?.id === p.id) setCreated(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="page-header">
        <span className="eyebrow">TỪ TRANG SÁCH ĐẾN THƯỚC PHIM</span>
        <h1>Nhập truyện</h1>
        <p>Tạo dự án truyện mới bằng cách dán nội dung hoặc tải file.</p>
      </header>
      <div className="import-grid">
        <section className="card import-card">
          <div className="section-title">
            <span className="icon-soft">
              <FileText size={21} />
            </span>
            <div>
              <h2>Câu chuyện của bạn</h2>
              <p>Bắt đầu bằng một câu chuyện hay.</p>
            </div>
          </div>
          <label>
            Tên dự án
            <input
              placeholder="Ví dụ: Hành trình qua miền ký ức"
              value={name}
              maxLength={120}
              onChange={(e) => {
                setName(e.target.value);
                setCreated(undefined);
              }}
            />
          </label>
          <div
            className={"upload-zone " + (drag ? "dragging" : "")}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              void readFile(e.dataTransfer.files[0]);
            }}
          >
            <Upload size={24} />
            <div>
              <strong>Kéo thả truyện vào đây</strong>
              <span>TXT hoặc DOCX · Không giới hạn số ký tự</span>
            </div>
            <label className="button secondary">
              Tải file truyện
              <input
                aria-label="Tải file truyện"
                type="file"
                accept=".txt,.docx"
                hidden
                disabled={busy}
                onChange={(e) => {
                  void readFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          {file && (
            <p className="file-meta">
              {file.name} · {(file.size / 1024).toFixed(1)} KB ·{" "}
              {text.length.toLocaleString("vi-VN")} ký tự
            </p>
          )}
          <label>
            Nội dung truyện
            <textarea
              aria-label="Nội dung truyện"
              className="story-text"
              placeholder="Dán toàn bộ truyện vào đây…"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setFile(undefined);
                setCreated(undefined);
              }}
            />
          </label>
          <div className="row between">
            <label className="check">
              <input
                type="checkbox"
                checked={split}
                onChange={(e) => setSplit(e.target.checked)}
              />
              Tự động tách chương
            </label>
            <small>{text.length.toLocaleString("vi-VN")} ký tự</small>
          </div>
          {synopsis && (
            <details className="chapter-preview">
              <summary>✓ Đã nhận diện tóm tắt truyện riêng ({synopsis.length.toLocaleString("vi-VN")} ký tự)</summary>
              <p style={{ whiteSpace: "pre-wrap", maxHeight: 180, overflowY: "auto" }}>{synopsis}</p>
              <small>Phần này được lưu cho video giới thiệu, không đưa vào lời đọc chương 1.</small>
            </details>
          )}
          {chapters.length > 0 && (
            <details className="chapter-preview">
              <summary>Đã phát hiện {chapters.length} chương</summary>
              <ol>
                {chapters.map((c, i) => (
                  <li key={i}>{c.title}</li>
                ))}
              </ol>
            </details>
          )}
          {chapters.length > 0 && split && (
            <section className="chapter-preview" aria-label="Kiểm tra chương nghi ngờ">
              <h3>Kiểm tra chương rác trước khi tạo dự án</h3>
              <p className="muted">Các chương đáng ngờ chỉ được cảnh báo, không tự xóa. Tích chọn để bỏ qua khi tạo dự án. Nội dung gốc không bị thay đổi.</p>
              {(() => {
                const numberOf = (title: string) => /^\\s*(?:chương|chapter|tập|phần)\\s+(\\d+)\\b/i.exec(title)?.[1];
                const counts = new Map<string, number>();
                chapters.forEach(c => { const n = numberOf(c.title); if (n) counts.set(n, (counts.get(n) || 0) + 1); });
                const flagged = chapters.map((c, i) => {
                  const reasons: string[] = [];
                  const n = numberOf(c.title);
                  if (n && (counts.get(n) || 0) > 1) reasons.push("Trùng số chương");
                  if ((c.length ?? 0) < 100) reasons.push("Nội dung quá ngắn");
                  if (/^(?:chương|chapter|tập|phần)\\s+\\d+\\s*$/i.test(c.title) && (c.length ?? 0) < 400) reasons.push("Tiêu đề trống hoặc phần mở đầu ngắn");
                  if (/quảng cáo|truy cập website|đọc truyện tại|nguồn truyện|ủng hộ tác giả|website:/i.test(c.sample || "")) reasons.push("Có dấu hiệu quảng cáo");
                  return { ...c, i, reasons };
                });
                const visible = showAllChapters ? flagged : flagged.filter(c => c.reasons.length > 0);
                return <>
                  <p><strong>{flagged.filter(c => c.reasons.length).length} chương nghi ngờ</strong> / {chapters.length} chương · Đã chọn bỏ qua {omitted.length}</p>
                  <div className="row">
                    <button type="button" className="text-button" onClick={() => setShowAllChapters(!showAllChapters)}>{showAllChapters ? "Chỉ xem cảnh báo" : "Xem tất cả chương"}</button>
                    <button type="button" className="text-button" onClick={() => setOmitted([])}>Bỏ toàn bộ lựa chọn xóa</button>
                  </div>
                  <div style={{ maxHeight: 340, overflowY: "auto" }}>
                    {visible.map(c => <label key={c.i} style={{ display: "block", padding: 8, borderBottom: "1px solid #ddd" }}>
                      <input type="checkbox" checked={omitted.includes(c.i)} onChange={e => setOmitted(old => e.target.checked ? [...old, c.i] : old.filter(i => i !== c.i))} />
                      {" "}Chương {c.i + 1}: <strong>{c.title}</strong> · {c.length ?? 0} ký tự
                      {c.reasons.length > 0 && <span style={{ color: "#a45b00" }}> — {c.reasons.join(", ")}</span>}
                      <details><summary>Xem nội dung phát hiện</summary><p style={{ whiteSpace: "pre-wrap" }}>{c.sample || "(Không có nội dung)"}</p></details>
                    </label>)}
                  </div>
                </>;
              })()}
            </section>
          )}
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          {created ? (
            <div className="notice success">
              <strong>✓ Đã tạo dự án · {created.chapters.length} chương</strong>
              <button className="primary" onClick={() => onOpen(created.id)}>
                Chuyển sang Tạo video
                <ArrowRight size={17} />
              </button>
            </div>
          ) : (
            <button
              className="primary wide"
              disabled={busy || !name.trim() || !text.trim()}
              onClick={create}
            >
              {busy ? "Đang xử lý…" : "Tạo dự án truyện"}
              <ArrowRight size={18} />
            </button>
          )}
        </section>
        <aside className="recent">
          <div className="row between">
            <h2>Dự án gần đây</h2>
            <span className="count">{projects.length}</span>
          </div>
          <p className="muted">Tiếp tục câu chuyện đang dang dở.</p>
          {!projects.length ? (
            <div className="card empty">
              <BookOpen size={32} />
              <h3>Câu chuyện đầu tiên</h3>
              <p>Dự án đã tạo sẽ xuất hiện tại đây.</p>
            </div>
          ) : (
            <div className="project-list">
              {projects.map((p) => (
                <article className="card project-card" key={p.id}>
                  <span className="book-tile">
                    <BookOpen size={22} />
                  </span>
                  <div className="project-info">
                    <h3>{p.name}</h3>
                    <small>
                      {p.chapters.length} chương ·{" "}
                      {new Date(p.createdAt).toLocaleDateString("vi-VN")}
                    </small>
                    <button
                      className="text-button"
                      onClick={() => onOpen(p.id)}
                    >
                      Mở dự án <ArrowRight size={14} />
                    </button>
                  </div>
                  <details className="project-menu">
                    <summary aria-label={"Thao tác " + p.name}>
                      <MoreHorizontal size={20} />
                    </summary>
                    <div>
                      <button
                        disabled={busy}
                        onClick={() => manage(p, "rename")}
                      >
                        Đổi tên
                      </button>
                      <button
                        className="danger-text"
                        disabled={busy}
                        onClick={() => manage(p, "delete")}
                      >
                        Xóa
                      </button>
                    </div>
                  </details>
                </article>
              ))}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
