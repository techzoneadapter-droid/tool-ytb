"use client";

import { useEffect, useMemo, useState, useRef } from "react";
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
  refreshProjects,
}: {
  projects: Project[];
  projectId: string;
  onProject: (id: string) => void;
  onCreate: (id: string) => void;
  refreshProjects: () => Promise<void>;
}) {
  const [library, setLibrary] = useState<LibraryData>({
    videos: [],
    history: [],
  });
  const [query, setQuery] = useState("");
  const [videoQuery, setVideoQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const operation = useRef(false);
  const libraryVersion = useRef(0);
  const [subtab, setSubtab] = useState<"videos" | "history">("videos");
  const [player, setPlayer] = useState<VideoRecord>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const project = projects.find((p) => p.id === projectId) || projects[0];
  const visibleProjects = projects.filter((p) =>
    p.name.toLocaleLowerCase("vi").includes(query.toLocaleLowerCase("vi")),
  );

  async function refresh() {
    const version = ++libraryVersion.current;
    const response = await fetch("/api/videos", { cache: "no-store" });
    if (!response.ok) throw Error("Không đọc được thư viện video.");
    const snapshot = await response.json();
    if (version === libraryVersion.current) setLibrary(snapshot);
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
          video.title
            .toLocaleLowerCase("vi")
            .includes(videoQuery.toLocaleLowerCase("vi")),
        )
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [library.videos, project?.id, videoQuery],
  );

  const latestVideos = useMemo(() => {
    const latest = new Map<string, VideoRecord>();
    for (const video of videos) {
      const key =
        video.kind === "scene"
          ? "scene:" + video.sceneId
          : video.kind === "chapter"
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
    if (operation.current) return false;
    operation.current = true;
    setBusy(key);
    setError("");
    try {
      await request(body, "/api/videos");
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy("");
      operation.current = false;
    }
  }

  async function removeVideo(video: VideoRecord) {
    if (
      !confirm(
        `Xóa "${video.title}" khỏi thư viện? Project, lời đọc và ảnh nguồn vẫn được giữ.`,
      )
    )
      return;
    if (await mutate({ action: "delete", videoId: video.id }, video.id)) {
      setSelected((ids) => ids.filter((id) => id !== video.id));
      if (player?.id === video.id) setPlayer(undefined);
    }
  }

  async function deleteSelectedVideos() {
    if (operation.current || !selected.length) return;
    const ids = [...selected];
    if (
      !confirm(
        `Bạn có chắc muốn xóa ${ids.length} video đã chọn?\n\nCác file MP4/SRT/VTT không còn được sử dụng sẽ bị xóa khỏi máy.\nẢnh nguồn, audio nguồn và dự án vẫn được giữ.\n\nHành động này không thể hoàn tác.`,
      )
    )
      return;
    if (await mutate({ action: "deleteMany", videoIds: ids }, "deleteVideos")) {
      setSelected([]);
      if (player && ids.includes(player.id)) setPlayer(undefined);
    }
  }

  async function deleteSelectedProjects() {
    if (operation.current || !selectedProjects.length) return;
    const ids = [...selectedProjects];
    const count = library.videos.filter((video) =>
      ids.includes(video.projectId),
    ).length;
    if (
      !confirm(
        `Bạn sắp xóa:\n\n${ids.length} dự án\n${count} video thành phẩm\n\nCác tác vụ, lịch sử và dữ liệu thuộc các dự án này sẽ bị xóa.\n\nHành động này không thể hoàn tác.\n\nTiếp tục?`,
      )
    )
      return;
    operation.current = true;
    setBusy("deleteProjects");
    setError("");
    try {
      await request({ action: "deleteProjects", projectIds: ids });
      setSelectedProjects([]);
      setSelected([]);
      if (player && ids.includes(player.projectId)) setPlayer(undefined);
      if (project && ids.includes(project.id))
        onProject(projects.find((p) => !ids.includes(p.id))?.id || "");
      await Promise.all([refreshProjects(), refresh()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      operation.current = false;
      setBusy("");
    }
  }

  async function regenerate(video: VideoRecord, regenerateResources = false) {
    if (
      regenerateResources &&
      !confirm(
        "Tạo lại toàn bộ lời đọc/ảnh cần thiết rồi dựng video mới? Bản video hiện tại vẫn được giữ cho đến khi bản mới hoàn tất.",
      )
    )
      return;
    await mutate(
      {
        action: "regenerate",
        videoId: video.id,
        regenerateResources,
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
    const ok = await mutate(
      { action: "merge", videoIds: chosen.map((video) => video.id), title },
      "merge",
    );
    if (ok) setSelected([]);
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
          <div className="library-selection-toolbar">
            <SelectAll
              label="Chọn tất cả dự án"
              ids={visibleProjects.map((p) => p.id)}
              selected={selectedProjects}
              setSelected={setSelectedProjects}
              disabled={!!busy}
            />
            {selectedProjects.length > 0 && (
              <>
                <small>Đã chọn {selectedProjects.length} dự án</small>
                <button
                  className="danger-outline"
                  disabled={!!busy}
                  onClick={() => void deleteSelectedProjects()}
                >
                  <Trash2 size={15} />
                  {busy === "deleteProjects"
                    ? "Đang xóa..."
                    : `Xóa ${selectedProjects.length} dự án`}
                </button>
              </>
            )}
          </div>
          <div className="library-project-list">
            {visibleProjects.map((p) => {
              const meta = projectCounts.get(p.id);
              return (
                <div className="library-project-row" key={p.id}>
                  <input
                    type="checkbox"
                    aria-label={"Chọn dự án " + p.name}
                    checked={selectedProjects.includes(p.id)}
                    disabled={!!busy}
                    onChange={(e) =>
                      setSelectedProjects((ids) =>
                        e.target.checked
                          ? [...new Set([...ids, p.id])]
                          : ids.filter((id) => id !== p.id),
                      )
                    }
                  />
                  <button
                    className={
                      "library-project " +
                      (p.id === project?.id ? "active" : "")
                    }
                    disabled={!!busy}
                    onClick={() => onProject(p.id)}
                  >
                    <Film size={18} />
                    <span>
                      <strong>{p.name}</strong>
                      <small>
                        {meta?.count || 0} video
                        {meta?.latest
                          ? " · " +
                            new Date(meta.latest).toLocaleDateString("vi-VN")
                          : ""}
                      </small>
                    </span>
                  </button>
                </div>
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
                    {project.chapters.length} chương · {videos.length} phiên bản
                    video
                  </p>
                </div>
                <button onClick={() => onCreate(project.id)}>
                  Mở trong Tạo video
                </button>
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
                    <SelectAll
                      label="Chọn tất cả video"
                      ids={latestVideos.map((video) => video.id)}
                      selected={selected}
                      setSelected={setSelected}
                      disabled={!!busy}
                    />
                    {selected.length > 0 && (
                      <small>Đã chọn {selected.length} video</small>
                    )}
                    {selected.length >= 2 && (
                      <button
                        className="primary"
                        disabled={!!busy}
                        onClick={() => void mergeSelected()}
                      >
                        <Merge size={17} />
                        Ghép {selected.length} video
                      </button>
                    )}
                    {selected.length > 0 && (
                      <button
                        className="danger-outline"
                        disabled={!!busy}
                        onClick={() => void deleteSelectedVideos()}
                      >
                        <Trash2 size={16} />
                        {busy === "deleteVideos"
                          ? "Đang xóa..."
                          : `Xóa ${selected.length} video`}
                      </button>
                    )}
                  </div>

                  {!latestVideos.length ? (
                    <div className="empty library-empty">
                      <Film size={34} />
                      <h2>Chưa có video</h2>
                      <p>Tạo video đầu tiên cho dự án này.</p>
                      <button
                        className="primary"
                        onClick={() => onCreate(project.id)}
                      >
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
                            disabled={!!busy}
                            checked={selected.includes(video.id)}
                            onChange={(e) =>
                              setSelected((ids) =>
                                e.target.checked
                                  ? [...new Set([...ids, video.id])]
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
                            <span>
                              <Play size={14} />
                            </span>
                          </button>
                          <div className="video-library-info">
                            <div className="row">
                              {video.kind === "merged" && (
                                <span className="badge">GỘP</span>
                              )}
                              {video.kind === "scene" && (
                                <span className="badge">CẢNH</span>
                              )}
                              <h3>{video.title}</h3>
                            </div>
                            <small>
                              {formatDuration(video.duration)} · {video.width}×
                              {video.height} · {formatBytes(video.fileSize)}
                            </small>
                            <small>
                              {new Date(video.createdAt).toLocaleString(
                                "vi-VN",
                              )}
                              {video.version > 1 ? ` · v${video.version}` : ""}
                            </small>
                            {!video.verified && (
                              <small className="file-missing">
                                ⚠ File không còn trên máy
                              </small>
                            )}
                          </div>
                          <div className="video-actions">
                            <button
                              disabled={!video.verified}
                              onClick={() => setPlayer(video)}
                            >
                              <Play size={16} /> Xem
                            </button>
                            <a
                              className="button"
                              aria-disabled={!video.verified}
                              href={
                                video.verified
                                  ? fileURL(video.output) + "?download=1"
                                  : undefined
                              }
                              download={video.title + ".mp4"}
                            >
                              <Download size={16} /> Tải
                            </a>
                            {video.kind === "chapter" && (
                              <button
                                disabled={busy === video.id}
                                onClick={() => void regenerate(video, false)}
                                title="Dùng lại lời đọc và ảnh hiện có, chỉ dựng lại MP4"
                              >
                                <RefreshCw size={16} /> Dựng lại
                              </button>
                            )}
                            <details className="video-more">
                              <summary aria-label="Thêm thao tác">
                                <MoreHorizontal size={18} />
                              </summary>
                              {video.kind === "chapter" && (
                                <button
                                  disabled={busy === video.id}
                                  onClick={() => void regenerate(video, true)}
                                >
                                  <RefreshCw size={16} /> Tạo lại toàn bộ
                                </button>
                              )}
                              <button
                                disabled={!!busy}
                                onClick={() => void removeVideo(video)}
                              >
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
                  onRetry={(retryJobs) =>
                    void Promise.all(
                      retryJobs.map((job) =>
                        request({ action: "retry", id: job.id }, "/api/studio"),
                      ),
                    )
                      .then(refresh)
                      .catch((e) => setError((e as Error).message))
                  }
                  onClear={() =>
                    confirm(
                      "Dọn các lịch sử đã hoàn thành/lỗi? Video thành phẩm không bị xóa.",
                    ) &&
                    void mutate(
                      { action: "clearHistory", mode: "done-and-error" },
                      "history",
                    )
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
                  {formatDuration(player.duration)} · {player.width}×
                  {player.height} · {formatBytes(player.fileSize)}
                </small>
              </div>
              <button aria-label="Đóng" onClick={() => setPlayer(undefined)}>
                <X size={18} />
              </button>
            </div>
            <video controls preload="metadata" src={fileURL(player.output)}>
              {player.kind === "scene" && player.vtt && (
                <track
                  kind="subtitles"
                  src={fileURL(player.vtt)}
                  srcLang="vi"
                  label="Tiếng Việt"
                  default
                />
              )}
            </video>
            <div className="row">
              <a
                className="button primary"
                href={fileURL(player.output) + "?download=1"}
                download={player.title + ".mp4"}
              >
                <Download size={17} /> Tải MP4
              </a>
              {player.srt && (
                <a
                  className="button"
                  href={fileURL(player.srt) + "?download=1"}
                  download
                >
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

function SelectAll({
  label,
  ids,
  selected,
  setSelected,
  disabled,
}: {
  label: string;
  ids: string[];
  selected: string[];
  setSelected: React.Dispatch<React.SetStateAction<string[]>>;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const checked = ids.length > 0 && ids.every((id) => selected.includes(id));
  const partial = !checked && ids.some((id) => selected.includes(id));
  useEffect(() => {
    if (input.current) input.current.indeterminate = partial;
  }, [partial]);
  return (
    <label className="library-select-all">
      <input
        ref={input}
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled || !ids.length}
        onChange={(e) => {
          const ticked = e.target.checked;
          setSelected((current) =>
            ticked
              ? [...new Set([...current, ...ids])]
              : current.filter((id) => !ids.includes(id)),
          );
        }}
      />
      Chọn tất cả
    </label>
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
  onRetry: (jobs: Job[]) => void;
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

  const groups = useMemo(() => {
    const map = new Map<string, Job[]>();
    for (const job of jobs) {
      const key = job.batchId ? "batch:" + job.batchId : "job:" + job.id;
      const group = map.get(key) || [];
      group.push(job);
      map.set(key, group);
    }
    return [...map.entries()]
      .map(([id, batchJobs]) => {
        batchJobs.sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0));
        const total = Math.max(batchJobs[0]?.batchTotal || 0, batchJobs.length);
        const done = batchJobs.filter((job) => job.status === "done").length;
        const errors = batchJobs.filter((job) => job.status === "error");
        const cancelled = batchJobs.filter((job) => job.status === "cancelled");
        const running = batchJobs.filter((job) =>
          ["audio", "images", "rendering"].includes(job.status),
        ).length;
        const queued = batchJobs.filter(
          (job) => job.status === "queued",
        ).length;
        const paused = batchJobs.filter(
          (job) => job.status === "paused",
        ).length;
        return {
          id,
          jobs: batchJobs,
          first: batchJobs[0],
          total,
          done,
          errors,
          cancelled,
          running,
          queued,
          paused,
          createdAt: batchJobs.map((job) => job.createdAt).sort()[0],
        };
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [jobs]);

  return (
    <div className="history-panel">
      <div className="row between">
        <p className="muted">Tối đa 50 lô gần nhất.</p>
        <button disabled={busy === "history"} onClick={onClear}>
          Dọn lịch sử
        </button>
      </div>
      <div className="history-list">
        {groups.slice(0, 50).map((group) => {
          const retryable = [...group.errors, ...group.cancelled];
          const finished = group.done === group.total;
          return (
            <article className="history-row" key={group.id}>
              <time>{new Date(group.createdAt).toLocaleString("vi-VN")}</time>
              <span>
                {group.total === 1
                  ? "1 video"
                  : `${group.done}/${group.total} video`}
              </span>
              <strong>
                {labels[group.first?.kind || "render"] ||
                  group.first?.kind ||
                  "Tác vụ"}
              </strong>
              <span
                className={
                  "history-status " +
                  (finished
                    ? "done"
                    : group.errors.length
                      ? "error"
                      : group.paused
                        ? "paused"
                        : "running")
                }
              >
                {finished
                  ? "✓ Hoàn thành"
                  : group.errors.length
                    ? `✕ ${group.errors.length} video lỗi`
                    : group.running
                      ? `${group.running} đang chạy · ${group.queued} chờ`
                      : group.paused
                        ? `${group.paused} tạm dừng`
                        : "Đang xử lý"}
              </span>
              {group.errors.length > 0 && (
                <details>
                  <summary>Chi tiết lỗi</summary>
                  {group.errors.slice(0, 8).map((job) => (
                    <pre key={job.id}>
                      {job.batchIndex !== undefined
                        ? `Video ${job.batchIndex + 1}: `
                        : ""}
                      {job.error || job.message}
                    </pre>
                  ))}
                  {group.errors.length > 8 && (
                    <p className="muted">
                      + {group.errors.length - 8} lỗi khác
                    </p>
                  )}
                </details>
              )}
              {retryable.length > 0 && !group.running && !group.queued && (
                <button onClick={() => onRetry(retryable)}>
                  Thử lại {retryable.length} video
                </button>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
