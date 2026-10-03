"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Download,
  Film,
  Merge,
  MoreHorizontal,
  Play,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { Job, Project, VideoRecord } from "@/modules/project/types";
import { fileURL, request } from "../studio-api";

type LibraryData = { videos: VideoRecord[]; history: Job[] };

export function VideoManagerPage({
  projects,
  projectId,
  onProject,
  onCreate,
}: {
  projects: Project[];
  projectId: string;
  onProject: (id: string) => void;
  onCreate: (id: string) => void;
}) {
  const [library, setLibrary] = useState<LibraryData>({ videos: [], history: [] });
  const [query, setQuery] = useState("");
  const [videoQuery, setVideoQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [subtab, setSubtab] = useState<"videos" | "history">("videos");
  const [player, setPlayer] = useState<VideoRecord>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const project = projects.find((p) => p.id === projectId) || projects[0];

  async function refresh() {
    const response = await fetch("/api/videos", { cache: "no-store" });
    if (!response.ok) throw Error("Không đọc được thư viện video.");
    setLibrary(await response.json());
  }

  useEffect(() => {
    void refresh().catch((e) => setError((e as Error).message));
    const timer = setInterval(() => void refresh().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setSelected([]);
    if (project && project.id !== projectId) onProject(project.id);
  }, [project?.id]);

  const projectCounts = useMemo(() => {
    const map = new Map<string, { count: number; latest: string }>();
    for (const video of library.videos) {
      const current = map.get(video.projectId);
      map.set(video.projectId, {
        count: (current?.count || 0) + 1,
        latest:
          !current || video.createdAt > current.latest
            ? video.createdAt
            : current.latest,
      });
    }
    return map;
  }, [library.videos]);

  const videos = useMemo(
    () =>
      library.videos
        .filter((video) => video.projectId === project?.id)
        .filter((video) =>
          video.title.toLocaleLowerCase("vi").includes(videoQuery.toLocaleLowerCase("vi")),
        )
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [library.videos, project?.id, videoQuery],
  );

  const latestVideos = useMemo(() => {
    const latest = new Map<string, VideoRecord>();
    for (const video of videos) {
      const key =
        video.kind === "chapter"
          ? "chapter:" + video.chapterIds.join(",")
          : "merged:" + video.id;
      const current = latest.get(key);
      if (!current || video.version > current.version) latest.set(key, video);
    }
    return [...latest.values()].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  }, [videos]);

  const history = library.history
    .filter((job) => job.projectId === project?.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  async function mutate(body: object, key: string) {
    setBusy(key);
    setError("");
    try {
      await request(body, "/api/videos");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function removeVideo(video: VideoRecord) {
    if (!confirm(`Xóa "${video.title}" khỏi thư viện? Project, lời đọc và ảnh nguồn vẫn được giữ.`))
      return;
    await mutate({ action: "delete", videoId: video.id }, video.id);
    if (player?.id === video.id) setPlayer(undefined);
  }

  async function regenerate(video: VideoRecord) {
    const all = confirm(
      "Nhấn OK để tạo lại toàn bộ tài nguyên AI. Nhấn Cancel để chỉ dựng lại video bằng tài nguyên hiện có.",
    );
    await mutate(
      {
        action: "regenerate",
        videoId: video.id,
        regenerateResources: all,
      },
      video.id,
    );
  }

  async function mergeSelected() {
    const chosen = latestVideos.filter((video) => selected.includes(video.id));
    if (chosen.length < 2) return;
    const title =
      prompt(
        "Tên video sau khi ghép:",
        chosen.length > 1
          ? `${chosen[chosen.length - 1].title} - ${chosen[0].title}`
          : "Video đã ghép",
      ) || "Video đã ghép";
    await mutate(
      { action: "merge", videoIds: chosen.map((video) => video.id), title },
      "merge",
    );
    setSelected([]);
  }

  function formatBytes(bytes: number) {
    if (!bytes) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
  }

  function formatDuration(seconds: number) {
    const total = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  }

  return (
    <>
      <header className="page-header">
        <span className="eyebrow">THƯ VIỆN THÀNH PHẨM</span>
        <h1>Quản lý video</h1>
        <p>Xem, tải, tạo lại và ghép các video đã tạo theo từng dự án.</p>
      </header>

      {error && <p className="notice error">{error}</p>}

      <div className="library-layout">
        <aside className="card library-projects">
          <div className="row between">
            <h2>Dự án video</h2>
            <span className="count">{projects.length}</span>
          </div>
          <label className="search-box">
            <Search size={16} />
            <input
              aria-label="Tìm dự án video"
              placeholder="Tìm dự án…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="library-project-list">
            {projects
              .filter((p) =>
                p.name.toLocaleLowerCase("vi").includes(query.toLocaleLowerCase("vi")),
              )
              .map((p) => {
                const meta = projectCounts.get(p.id);
                return (
                  <button
                    className={"library-project " + (p.id === project?.id ? "active" : "")}
                    key={p.id}
                    onClick={() => onProject(p.id)}
                  >
                    <Film size={18} />
                    <span>
                      <strong>{p.name}</strong>
                      <small>
                        {meta?.count || 0} video
                        {meta?.latest
                          ? " · " + new Date(meta.latest).toLocaleDateString("vi-VN")
                          : ""}
                      </small>
                    </span>
                  </button>
                );
              })}
          </div>
        </aside>

        <section className="card library-main">
          {!project ? (
            <div className="empty">
              <Film size={34} />
              <h2>Chưa có dự án</h2>
              <p>Nhập truyện để bắt đầu tạo video.</p>
            </div>
          ) : (
            <>
              <div className="library-header">
                <div>
                  <h2>{project.name}</h2>
                  <p className="muted">
                    {project.chapters.length} chương · {videos.length} phiên bản video
                  </p>
                </div>
                <button onClick={() => onCreate(project.id)}>Mở trong Tạo video</button>
              </div>

              <div className="library-tabs">
                <button
                  className={subtab === "videos" ? "active" : ""}
                  onClick={() => setSubtab("videos")}
                >
                  Video
                </button>
                <button
                  className={subtab === "history" ? "active" : ""}
                  onClick={() => setSubtab("history")}
                >
                  Lịch sử
                </button>
              </div>

              {subtab === "videos" ? (
                <>
                  <div className="library-toolbar">
                    <label className="search-box">
                      <Search size={16} />
                      <input
                        aria-label="Tìm video"
                        placeholder="Tìm video…"
                        value={videoQuery}
                        onChange={(e) => setVideoQuery(e.target.value)}
                      />
                    </label>
                    {selected.length >= 2 && (
                      <button
                        className="primary"
                        disabled={busy === "merge"}
                        onClick={() => void mergeSelected()}
                      >
                        <Merge size={17} />
                        Ghép {selected.length} video
                      </button>
                    )}
                  </div>

                  {!latestVideos.length ? (
                    <div className="empty library-empty">
                      <Film size={34} />
                      <h2>Chưa có video</h2>
                      <p>Tạo video đầu tiên cho dự án này.</p>
                      <button className="primary" onClick={() => onCreate(project.id)}>
                        Đi tới Tạo video
                      </button>
                    </div>
                  ) : (
                    <div className="video-library-list">
                      {latestVideos.map((video) => (
                        <article className="video-library-row" key={video.id}>
                          <input
                            aria-label={"Chọn " + video.title}
                            type="checkbox"
                            checked={selected.includes(video.id)}
                            onChange={(e) =>
                              setSelected((ids) =>
                                e.target.checked
                                  ? [...ids, video.id]
                                  : ids.filter((id) => id !== video.id),
                              )
                            }
                          />
                          <button
                            className="video-thumb"
                            onClick={() => setPlayer(video)}
                            aria-label={"Xem " + video.title}
                          >
                            <Film size={30} />
                            <span><Play size={14} /></span>
                          </button>
                          <div className="video-library-info">
                            <div className="row">
                              {video.kind === "merged" && <span className="badge">GỘP</span>}
                              <h3>{video.title}</h3>
                            </div>
                            <small>
                              {formatDuration(video.duration)} · {video.width}×{video.height} ·{" "}
                              {formatBytes(video.fileSize)}
                            </small>
                            <small>
                              {new Date(video.createdAt).toLocaleString("vi-VN")}
                              {video.version > 1 ? ` · v${video.version}` : ""}
                            </small>
                            {!video.verified && (
                              <small className="file-missing">⚠ File không còn trên máy</small>
                            )}
                          </div>
                          <div className="video-actions">
                            <button disabled={!video.verified} onClick={() => setPlayer(video)}>
                              <Play size={16} /> Xem
                            </button>
                            <a
                              className="button"
                              aria-disabled={!video.verified}
                              href={video.verified ? fileURL(video.output) + "?download=1" : undefined}
                              download={video.title + ".mp4"}
                            >
                              <Download size={16} /> Tải
                            </a>
                            {video.kind === "chapter" && (
                              <button
                                disabled={busy === video.id}
                                onClick={() => void regenerate(video)}
                              >
                                <RefreshCw size={16} /> Tạo lại
                              </button>
                            )}
                            <details className="video-more">
                              <summary aria-label="Thêm thao tác"><MoreHorizontal size={18} /></summary>
                              <button onClick={() => void removeVideo(video)}>
                                <Trash2 size={16} /> Xóa video
                              </button>
                            </details>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <HistoryList
                  jobs={history}
                  busy={busy}
                  onRetry={(job) =>
                    void request({ action: "retry", id: job.id }, "/api/studio")
                      .then(refresh)
                      .catch((e) => setError((e as Error).message))
                  }
                  onClear={() =>
                    confirm("Dọn các lịch sử đã hoàn thành/lỗi? Video thành phẩm không bị xóa.") &&
                    void mutate({ action: "clearHistory", mode: "done-and-error" }, "history")
                  }
                />
              )}
            </>
          )}
        </section>
      </div>

      {player && (
        <div className="modal-backdrop" onClick={() => setPlayer(undefined)}>
          <section
            className="card video-player-modal"
            role="dialog"
            aria-modal="true"
            aria-label={"Xem " + player.title}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row between">
              <div>
                <h2>{player.title}</h2>
                <small>
                  {formatDuration(player.duration)} · {player.width}×{player.height} ·{" "}
                  {formatBytes(player.fileSize)}
                </small>
              </div>
              <button aria-label="Đóng" onClick={() => setPlayer(undefined)}>
                <X size={18} />
              </button>
            </div>
            <video controls preload="metadata" src={fileURL(player.output)} />
            <div className="row">
              <a
                className="button primary"
                href={fileURL(player.output) + "?download=1"}
                download={player.title + ".mp4"}
              >
                <Download size={17} /> Tải MP4
              </a>
              {player.srt && (
                <a className="button" href={fileURL(player.srt) + "?download=1"} download>
                  <Download size={17} /> Tải SRT
                </a>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function HistoryList({
  jobs,
  busy,
  onRetry,
  onClear,
}: {
  jobs: Job[];
  busy: string;
  onRetry: (job: Job) => void;
  onClear: () => void;
}) {
  const labels: Record<string, string> = {
    pipeline: "Tạo video",
    render: "Dựng lại",
    "merge-video": "Ghép video",
    audio: "Tạo lời đọc",
    image: "Tạo ảnh",
    motion: "Ảnh động",
    prepare: "Chuẩn bị",
  };
  return (
    <div className="history-panel">
      <div className="row between">
        <p className="muted">Tối đa 50 tác vụ gần nhất.</p>
        <button disabled={busy === "history"} onClick={onClear}>
          Dọn lịch sử
        </button>
      </div>
      <div className="history-list">
        {jobs.slice(0, 50).map((job) => (
          <article className="history-row" key={job.id}>
            <time>{new Date(job.createdAt).toLocaleString("vi-VN")}</time>
            <span>{job.chapterIds.length === 1 ? "1 chương" : job.chapterIds.length + " chương"}</span>
            <strong>{labels[job.kind || "render"] || job.kind}</strong>
            <span className={"history-status " + job.status}>
              {job.status === "done"
                ? "✓ Hoàn thành"
                : job.status === "error"
                  ? "✕ Lỗi"
                  : job.status === "paused"
                    ? "Tạm dừng"
                    : "Đang xử lý"}
            </span>
            {job.error && (
              <details>
                <summary>Chi tiết</summary>
                <pre>{job.error}</pre>
              </details>
            )}
            {job.status === "error" && (
              <button onClick={() => onRetry(job)}>Thử lại</button>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
