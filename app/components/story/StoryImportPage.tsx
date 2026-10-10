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
    [chapters, setChapters] = useState<{ title: string }[]>([]),
    [synopsis, setSynopsis] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [created, setCreated] = useState<Project>(),
    [file, setFile] = useState<File>(),
    [drag, setDrag] = useState(false);
  useEffect(() => {
    let active = true;
    setChapters([]);
    setSynopsis("");
    if (!text.trim()) return;
    const timer = setTimeout(() => {
      request<{ chapters: { title: string }[]; synopsis: string }>({
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
