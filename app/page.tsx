"use client";
import { useEffect, useRef, useState } from "react";
import { imageStyles } from "@/modules/imagePrompt/styles";
import type { providerStatus } from "@/modules/providers/config";
import { Modal } from "./components/modal";
import {
  LayoutDashboard,
  Library,
  Clapperboard,
  Mic,
  Images,
  Captions,
  MonitorPlay,
  Radio,
  Settings as SettingsIcon,
  Plus,
  ArrowUpRight,
  ArrowRight,
  Play,
  Check,
  Upload,
  Film,
  ChevronRight,
  Sparkles,
  BookOpen,
  Clock,
  Pause,
  RotateCcw,
  Download,
  Headphones,
  Layers,
  CheckCircle2,
} from "lucide-react";
import type { Project, Job, Scene, Settings } from "@/modules/project/types";
import { defaults } from "@/modules/project/types";
import { channelTabs } from "@/modules/channelManager";
import {
  voiceFilters,
  filterVoices,
  getVietnameseVoice,
  type VoiceFilter,
} from "@/modules/tts/voices";
const nav = [
  ["Tổng quan", LayoutDashboard],
  ["Dự án truyện", Library],
  ["Tạo video", Clapperboard],
  ["Giọng đọc", Mic],
  ["Ảnh AI", Images],
  ["Phụ đề", Captions],
  ["Xuất video", MonitorPlay],
  ["Quản lý kênh", Radio],
  ["Cài đặt", SettingsIcon],
] as const;
const styles = imageStyles.map((style) => style.name);
const statusLabel: Record<string, string> = {
  queued: "Đang chờ",
  audio: "Tạo lời đọc",
  images: "Tạo ảnh",
  rendering: "Đang xuất video",
  paused: "Tạm dừng",
  done: "Hoàn tất",
  ready: "Tài nguyên đã lưu",
  error: "Có lỗi",
};
type Store = {
  projects: Project[];
  jobs: Job[];
  presets: { id: string; name: string; prompt: string }[];
  hasKey: boolean;
  providers?: Awaited<ReturnType<typeof providerStatus>>;
};
const defaultDraft: Settings = {
  ...defaults,
  ttsProvider: "vieneu-local",
  voice: "ngoc_huyen",
  imageEnabled: true,
  imageProvider: "flux2-local",
  motionMode: "off",
};
const url = (name?: string) => (name ? `/api/files/${name}` : "");
export default function Studio() {
  const [data, setData] = useState<Store>({
    projects: [],
    jobs: [],
    presets: [],
    hasKey: false,
  });
  const [page, setPage] = useState("Tạo video");
  const [pid, setPid] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [chapterId, setChapterId] = useState("");
  const [modal, setModal] = useState(false);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [splitChapters, setSplitChapters] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [merge, setMerge] = useState(false);
  const [channel, setChannel] = useState("YouTube");
  const [draft, setDraft] = useState<Settings>(defaultDraft);
  const [sceneDraft, setSceneDraft] = useState<Scene | null>(null);
  const [previews, setPreviews] = useState<
    Record<string, { file?: string; error?: string; busy?: boolean }>
  >({});
  const [presetName, setPresetName] = useState("");
  const [formError, setFormError] = useState("");
  const [chapterTarget, setChapterTarget] = useState("");
  const [chapterTitle, setChapterTitle] = useState("");
  const [chapterText, setChapterText] = useState("");
  const [voiceFilter, setVoiceFilter] = useState<VoiceFilter>("Tất cả");
  const [loadError, setLoadError] = useState("");
  const requestVersion = useRef(0);
  function newProject() {
    setFormError("");
    setModal(true);
  }
  function newChapter(projectId: string) {
    setChapterTarget(projectId);
    setChapterTitle("");
    setChapterText("");
    setFormError("");
  }
  async function refresh() {
    const version = ++requestVersion.current;
    const r = await fetch("/api/studio");
    if (!r.ok)
      throw Error(
        "Không đọc được dữ liệu. Vui lòng kiểm tra kết nối và thử lại.",
      );
    const snapshot = await r.json();
    if (version === requestVersion.current) {
      setData(snapshot);
      setLoadError("");
    }
  }
  useEffect(() => {
    refresh().catch(() =>
      setLoadError("Không tải được dữ liệu. Đang thử kết nối lại…"),
    );
    const timer = setInterval(
      () =>
        refresh().catch(() =>
          setLoadError("Mất kết nối với ứng dụng. Đang thử kết nối lại…"),
        ),
      2500,
    );
    return () => clearInterval(timer);
  }, []);
  const project = data.projects.find((p) => p.id === pid) || data.projects[0];
  const chapter =
    project?.chapters.find((c) => c.id === chapterId) || project?.chapters[0];
  useEffect(() => {
    if (project) {
      setDraft(project.settings);
      setSelected(project.chapters.map((c) => c.id));
      setChapterId(project.chapters[0]?.id || "");
    }
  }, [project?.id]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 6500);
    return () => clearTimeout(t);
  }, [toast]);
  async function action(body: object, success?: string) {
    setBusy(true);
    setFormError("");
    try {
      const operation = body as { action?: string; kind?: string };
      const endpoint =
        operation.action === "enqueue" && operation.kind === "motion"
          ? "/api/video/generate"
          : operation.action === "enqueue" && operation.kind === "image"
            ? "/api/image/generate"
            : "/api/studio";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error);
      ++requestVersion.current;
      if (d.id && Array.isArray(d.chapters))
        setData((previous) => ({
          ...previous,
          projects: [d, ...previous.projects.filter((p) => p.id !== d.id)],
        }));
      await refresh().catch(() =>
        setLoadError(
          "Đã lưu thay đổi nhưng chưa tải lại được dữ liệu. Đang thử kết nối lại…",
        ),
      );
      if (success) setToast(success);
      return d;
    } catch (e) {
      const message =
        e instanceof TypeError
          ? "Không kết nối được với ứng dụng. Nội dung bạn nhập vẫn được giữ lại; vui lòng thử lại."
          : e instanceof SyntaxError
            ? "Ứng dụng trả về dữ liệu không hợp lệ. Vui lòng thử lại."
            : e instanceof Error
              ? e.message
              : "Có lỗi xảy ra. Vui lòng thử lại.";
      setToast(message);
      setFormError(message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  function currentSettings(): Settings {
    return {
      ...defaultDraft,
      ...draft,
      ttsProvider: draft.ttsProvider || "vieneu-local",
      voice: draft.voice || "ngoc_huyen",
      imageEnabled: draft.imageEnabled !== false,
      imageProvider: draft.imageProvider || "flux2-local",
      motionMode: draft.motionMode || "off",
    };
  }
  async function createStoryProject() {
    const p = (await action(
      {
        action: "create",
        name,
        text,
        splitChapters,
        settings: currentSettings(),
      },
      splitChapters
        ? "Đã tạo dự án và tách chương."
        : "Đã tạo dự án một chương.",
    )) as Project | null;
    if (p) {
      setModal(false);
      setName("");
      setText("");
      setSplitChapters(true);
      openProject(p);
    }
  }
  async function upload(file: File) {
    const f = new FormData();
    f.append("file", file);
    const r = await fetch("/api/upload", { method: "POST", body: f });
    const d = await r.json();
    if (!r.ok) throw Error(d.error);
    return d;
  }
  const done = data.jobs.filter((j) => j.output).length,
    active = data.jobs.filter(
      (j) => !["done", "ready", "error", "paused"].includes(j.status),
    );
  const charCount =
    project?.chapters
      .filter((c) => selected.includes(c.id))
      .reduce(
        (n, c) => n + c.scenes.reduce((n, s) => n + s.text.length, 0),
        0,
      ) || 0;
  const count =
    project?.chapters
      .filter((c) => selected.includes(c.id))
      .reduce((n, c) => n + c.scenes.length, 0) || 0;
  function openProject(p: Project) {
    setPid(p.id);
    setDraft(p.settings);
    setPage("Tạo video");
  }
  async function saveSettings() {
    return action(
      { action: "settings", projectId: project?.id, settings: draft },
      "Đã lưu cấu hình",
    );
  }
  async function enqueue(prepare = false) {
    if (!selected.length) {
      setToast("Chọn ít nhất một chương");
      return;
    }
    if (await saveSettings()) {
      const queued = await action(
        {
          action: "enqueue",
          projectId: project?.id,
          chapterIds: selected,
          merge,
          prepare,
        },
        prepare
          ? "Đã thêm tác vụ tạo tài nguyên"
          : "Đã thêm vào hàng đợi xuất video",
      );
      if (queued) setPage("Xuất video");
    }
  }
  function field<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((s) => ({ ...s, [key]: value }));
  }
  function assetInput(
    key: "music" | "intro" | "outro" | "logo",
    label: string,
    accept: string,
  ) {
    return (
      <label className="upload-row">
        {label}
        <input
          type="file"
          accept={accept}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f)
              try {
                field(key, (await upload(f)).asset);
                setToast("Đã tải lên. Nhấn lưu cấu hình để áp dụng.");
              } catch (e) {
                setToast(String(e));
              }
          }}
        />
        {draft[key] && (
          <span>
            Đã chọn{" "}
            <button
              onClick={(e) => {
                e.preventDefault();
                field(key, undefined);
              }}
            >
              Bỏ
            </button>
          </span>
        )}
      </label>
    );
  }
  async function previewVoice(
    voice: string,
    provider: import("@/modules/tts/local-voices").TTSProvider = "cloud",
  ) {
    const voiceId = voice;
    voice = provider + ":" + voice;
    setPreviews((p) => ({ ...p, [voice]: { busy: true } }));
    try {
      const response = await fetch("/api/tts/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voiceId,
          provider,
          speed: draft.speed,
          pitch: draft.pitch,
          volume: draft.volume,
        }),
      });
      const d = await response.json();
      if (!response.ok) throw Error(d.error);
      setPreviews((p) => ({ ...p, [voice]: { file: d.file } }));
    } catch (e) {
      setPreviews((p) => ({
        ...p,
        [voice]: {
          error:
            e instanceof Error ? e.message : "Không tạo được bản nghe thử.",
        },
      }));
    }
  }
  async function generateMedia(
    kind: "audio" | "image" | "motion",
    scene?: Scene,
  ) {
    if (!chapter || !project) return;
    if (await saveSettings())
      await action(
        {
          action: "enqueue",
          kind,
          projectId: project.id,
          chapterIds: [chapter.id],
          sceneIds: scene ? [scene.id] : undefined,
          merge: true,
        },
        "Đã xếp hàng tạo tài nguyên thật. Tiến trình nền sẽ xử lý.",
      );
  }
  const visibleVoices = (data.providers?.voices || []).filter(
    (v) =>
      voiceFilter === "Tất cả" ||
      v.gender === voiceFilter ||
      v.categories.some((c) => c === voiceFilter),
  );
  const renderReady =
    !!project &&
    selected.length > 0 &&
    project.chapters
      .filter((c) => selected.includes(c.id))
      .every(
        (c) =>
          c.scenes.length > 0 &&
          c.scenes.every(
            (s) =>
              s.audio &&
              s.image &&
              s.audioSource &&
              s.imageSource &&
              s.audioStatus !== "working" &&
              s.imageStatus !== "working",
          ),
      );
  const voiceOptions =
    data.providers?.voices && data.providers.voices.length
      ? [...data.providers.voices].sort(
          (a, b) =>
            Number(b.provider === "vieneu-local") -
            Number(a.provider === "vieneu-local"),
        )
      : [
          {
            id: "ngoc_huyen",
            name: "Ngọc Huyền",
            description: "VieNeu-TTS local, giọng ưu tiên cho sách nói.",
            gender: "Nữ" as const,
            categories: ["Sách nói", "Kể chuyện"],
            provider: "vieneu-local" as const,
            key: "vieneu-local:ngoc_huyen",
            configured: false,
            voiceId: "Ngọc Huyền",
            status: "Đang chờ kiểm tra VieNeu-TTS local",
          },
        ];
  const selectedVoiceKey = `${draft.ttsProvider || "vieneu-local"}:${draft.voice}`;
  const selectedVoice =
    voiceOptions.find((v) => v.key === selectedVoiceKey) || voiceOptions[0];
  const latestOutputJob = [...data.jobs]
    .filter((j) => j.output && (!project || j.projectId === project.id))
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )[0];
  const projectJobs = project
    ? data.jobs.filter((j) => j.projectId === project.id)
    : data.jobs;
  const showCommandCenter = page === "Tổng quan" || page === "Tạo video";
  function jobsView(limit?: number, source = data.jobs) {
    const jobs = limit ? source.slice(0, limit) : source;
    return jobs.length ? (
      <div className="job-list">
        {jobs.map((j) => (
          <div className="job" key={j.id}>
            <div className="job-icon">
              <Film size={20} />
            </div>
            <div className="grow">
              <div className="row">
                <strong>
                  {data.projects.find((p) => p.id === j.projectId)?.name}{" "}
                  <small>· {j.chapterIds.length} chương</small>
                </strong>
                <span className={`badge ${j.status}`}>
                  {statusLabel[j.status]}
                </span>
              </div>
              <p>{j.message}</p>
              {j.status !== "ready" && (
                <div className="progress">
                  <i style={{ width: `${j.progress}%` }} />
                </div>
              )}
              {j.error && <p className="error">{j.error}</p>}
              {j.output && (
                <>
                  <video
                    id={"video-" + j.id}
                    controls
                    preload="metadata"
                    src={url(j.output)}
                    className="output-video"
                  />
                  <div className="row downloads">
                    <a href={url(j.output)} download>
                      <Download size={14} /> MP4
                    </a>
                    <a href={url(j.srt)} download>
                      SRT
                    </a>
                    <a href={url(j.vtt)} download>
                      VTT
                    </a>
                    <button
                      onClick={() =>
                        document
                          .getElementById("video-" + j.id)
                          ?.requestFullscreen()
                          .catch(() => setToast("Không mở được toàn màn hình."))
                      }
                    >
                      Toàn màn hình
                    </button>
                  </div>
                </>
              )}
            </div>
            {j.status !== "ready" && (
              <span className="percent">{j.progress}%</span>
            )}
            {!["done", "ready", "error", "paused"].includes(j.status) && (
              <button
                className="icon-btn"
                aria-label="Tạm dừng tác vụ"
                onClick={() => action({ action: "pause", id: j.id })}
              >
                <Pause size={17} />
              </button>
            )}
            {["paused", "error"].includes(j.status) && (
              <button
                className="icon-btn"
                aria-label="Tiếp tục tác vụ"
                onClick={() =>
                  action({
                    action: j.status === "error" ? "retry" : "resume",
                    id: j.id,
                  })
                }
              >
                <RotateCcw size={17} />
              </button>
            )}
          </div>
        ))}
      </div>
    ) : (
      <div className="empty compact">
        <MonitorPlay />
        <h3>Hàng đợi đang trống</h3>
        <p>Chọn chương và tạo tài nguyên để bắt đầu.</p>
      </div>
    );
  }
  const needsProject =
    ![
      "Tổng quan",
      "Dự án truyện",
      "Tạo video",
      "Quản lý kênh",
      "Xuất video",
    ].includes(page) && !project;
  return (
    <div className="app">
      <aside>
        <a
          className="logo"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("Tổng quan");
          }}
        >
          <span>
            <Clapperboard size={24} />
          </span>
          storyflow<span className="logo-dot">.</span>
        </a>
        <div className="workspace">
          <span className="avatar">S</span>
          <div>
            Không gian của bạn<small>Không gian sáng tạo</small>
          </div>
          <ChevronRight size={15} />
        </div>
        <p className="nav-label">KHÔNG GIAN LÀM VIỆC</p>
        <nav>
          {nav.map(([label, Icon], i) => (
            <button
              key={label}
              aria-label={label}
              className={page === label ? "active" : ""}
              onClick={() => setPage(label)}
            >
              <Icon size={19} />
              <span>{label}</span>
              {label === "Xuất video" && active.length > 0 && (
                <b>{active.length}</b>
              )}
              {i === 7 && <small className="soon">SẮP CÓ</small>}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <div className="local-dot" /> Dữ liệu lưu trên máy
          <small>StoryFlow · Phiên bản 0.2</small>
        </div>
      </aside>
      <div className="main">
        <header>
          <div className="breadcrumb">
            Không gian làm việc <ChevronRight size={14} />{" "}
            <strong>{page}</strong>
          </div>
          <div className="header-right">
            <span className="avatar user">BA</span>
          </div>
        </header>
        <main>
          {loadError && (
            <div className="form-error" role="alert">
              {loadError}
            </div>
          )}
          <div className="page-heading">
            <div>
              <p className="eyebrow">STORYFLOW</p>
              <h1>{page === "Tổng quan" ? "Xưởng kể chuyện của bạn" : page}</h1>
              <p className="muted">
                {page === "Tổng quan"
                  ? "Biến từng chương truyện thành những thước phim."
                  : page === "Tạo video"
                    ? "Từ bản thảo đến video, từng bước một."
                    : "Mọi thứ bạn cần cho câu chuyện tiếp theo."}
              </p>
            </div>
            <button className="primary" onClick={newProject}>
              <Plus size={18} /> Tạo dự án mới
            </button>
          </div>
          {showCommandCenter && (
            <section className="panel command-center">
              <div className="command-title">
                <div>
                  <span className="badge">Bảng điều khiển chính</span>
                  <h2>Làm video truyện trong một màn hình</h2>
                  <p className="muted">
                    Dán truyện, chọn giọng, bật ảnh/phụ đề rồi chạy từng bước.
                    Ảnh động tắt mặc định để video dài nhẹ hơn.
                  </p>
                </div>
                <div className="command-status">
                  <span>{data.projects.length} dự án</span>
                  <span>{active.length} tác vụ đang chạy</span>
                  <span>{done} video đã xuất</span>
                </div>
              </div>
              <div className="command-layout">
                <div className="quick-story">
                  {data.projects.length > 0 && (
                    <label>
                      Dự án đang chọn
                      <select
                        value={project?.id || ""}
                        onChange={(e) => {
                          setPid(e.target.value);
                          const next = data.projects.find(
                            (p) => p.id === e.target.value,
                          );
                          if (next) {
                            setDraft(next.settings);
                            setSelected(next.chapters.map((c) => c.id));
                            setChapterId(next.chapters[0]?.id || "");
                          }
                        }}
                      >
                        {data.projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    Tên truyện / dự án mới
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Ví dụ: Phàm Nhân Tu Tiên chương 1-50"
                    />
                  </label>
                  <label className="upload-box compact-upload">
                    <Upload size={22} />
                    <strong>Tải TXT/DOCX hoặc dán truyện bên dưới</strong>
                    <span>Nội dung tải lên sẽ tự điền vào ô truyện</span>
                    <input
                      type="file"
                      accept=".txt,.docx"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (f) {
                          setBusy(true);
                          try {
                            const d = await upload(f);
                            setText(d.text);
                            if (!name) setName(f.name.replace(/\.[^.]+$/, ""));
                          } catch (e) {
                            setFormError(
                              e instanceof Error
                                ? e.message
                                : "Không đọc được tệp truyện. Vui lòng thử lại.",
                            );
                          } finally {
                            setBusy(false);
                          }
                        }
                      }}
                    />
                  </label>
                  <label>
                    Toàn bộ câu chuyện
                    <textarea
                      rows={11}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder={
                        "Chương 1: Khởi đầu\nDán toàn bộ truyện ở đây...\n\nChương 2: Tiếp diễn..."
                      }
                    />
                  </label>
                  <div className="quick-toggles">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={splitChapters}
                        onChange={(e) => setSplitChapters(e.target.checked)}
                      />{" "}
                      Tự tách chương
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={draft.imageEnabled !== false}
                        onChange={(e) =>
                          field("imageEnabled", e.target.checked)
                        }
                      />{" "}
                      Tạo ảnh minh họa
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={draft.burnSubtitles}
                        onChange={(e) =>
                          field("burnSubtitles", e.target.checked)
                        }
                      />{" "}
                      Thêm phụ đề
                    </label>
                  </div>
                  <button
                    className="primary wide"
                    disabled={busy}
                    onClick={createStoryProject}
                  >
                    {busy ? "Đang tạo dự án..." : "Tạo dự án từ truyện"}
                    <ArrowRight size={17} />
                  </button>
                  {formError && (
                    <div className="form-error" role="alert">
                      {formError}
                    </div>
                  )}
                </div>
                <div className="quick-settings">
                  <div className="quick-grid">
                    <label>
                      Giọng đọc
                      <select
                        value={selectedVoiceKey}
                        onChange={(e) => {
                          const [provider, voice] = e.target.value.split(":");
                          setDraft((p) => ({
                            ...p,
                            ttsProvider:
                              provider as import("@/modules/tts/local-voices").TTSProvider,
                            voice,
                          }));
                        }}
                      >
                        {voiceOptions.map((v) => (
                          <option key={v.key} value={v.key}>
                            {v.name} -{" "}
                            {v.provider === "vieneu-local"
                              ? "VieNeu local"
                              : v.provider === "korva-local"
                                ? "Korva local"
                                : "API"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Phong cách ảnh
                      <select
                        value={draft.style}
                        onChange={(e) => field("style", e.target.value)}
                      >
                        {styles.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Tỉ lệ video
                      <select
                        value={draft.aspect}
                        onChange={(e) =>
                          field("aspect", e.target.value as Settings["aspect"])
                        }
                      >
                        <option>16:9</option>
                        <option>9:16</option>
                      </select>
                    </label>
                    <label>
                      Ảnh động
                      <select
                        value={draft.motionMode || "off"}
                        onChange={(e) =>
                          field(
                            "motionMode",
                            e.target.value as Settings["motionMode"],
                          )
                        }
                      >
                        <option value="off">Tắt cho video dài</option>
                        <option value="selected">Chỉ cảnh đã chọn</option>
                        <option value="all">Tất cả cảnh</option>
                      </select>
                    </label>
                  </div>
                  <label>
                    Mô tả phong cách bổ sung
                    <textarea
                      rows={3}
                      value={draft.customPrompt}
                      onChange={(e) => field("customPrompt", e.target.value)}
                      placeholder="Ví dụ: tu tiên, tiên hiệp, linh khí, tông môn, cổ trang Trung Hoa, màu điện ảnh..."
                    />
                  </label>
                  <div className="quick-toggles">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={merge}
                        onChange={(e) => setMerge(e.target.checked)}
                      />{" "}
                      Ghép chương đã chọn thành một video
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={draft.humanCheck}
                        onChange={(e) => field("humanCheck", e.target.checked)}
                      />{" "}
                      Duyệt trước khi xuất
                    </label>
                  </div>
                  <div className="quick-actions">
                    <button
                      className="secondary"
                      disabled={!!previews[selectedVoice.key]?.busy}
                      onClick={() =>
                        previewVoice(selectedVoice.id, selectedVoice.provider)
                      }
                    >
                      <Play size={14} />
                      {previews[selectedVoice.key]?.busy
                        ? "Đang tạo nghe thử..."
                        : "Nghe thử giọng"}
                    </button>
                    <button
                      className="secondary"
                      disabled={!project || busy}
                      onClick={() => enqueue(true)}
                    >
                      <Images size={16} />
                      Tạo lời đọc & ảnh
                    </button>
                    <button
                      className="primary"
                      disabled={!project || busy || !renderReady}
                      onClick={() => enqueue()}
                    >
                      <Play size={16} />
                      Xuất video
                    </button>
                  </div>
                  {previews[selectedVoice.key]?.file && (
                    <audio
                      controls
                      autoPlay
                      preload="metadata"
                      src={url(previews[selectedVoice.key].file)}
                    />
                  )}
                  {previews[selectedVoice.key]?.error && (
                    <p role="alert" className="form-error">
                      {previews[selectedVoice.key].error}
                    </p>
                  )}
                  <div className="run-summary">
                    <strong>
                      {project
                        ? `${selected.length}/${project.chapters.length} chương đã chọn`
                        : "Chưa chọn dự án"}
                    </strong>
                    <span>{count} cảnh</span>
                    <span>{charCount.toLocaleString("vi-VN")} ký tự TTS</span>
                    <span>
                      ~{Math.max(1, Math.round(charCount / 14 / 60))} phút
                    </span>
                  </div>
                  <div className="notice compact">
                    <p>
                      VieNeu:{" "}
                      {data.providers?.local.vieneu.message ||
                        "đang chờ kiểm tra"}
                    </p>
                    <p>
                      Ảnh:{" "}
                      {draft.imageProvider === "flux2-local"
                        ? "chạy worker FLUX local khi cần tạo ảnh"
                        : data.providers?.image.configured
                          ? "API ảnh đã cấu hình"
                          : "chưa cấu hình API ảnh"}
                    </p>
                    <p>
                      Worker video: mở terminal thứ hai và chạy{" "}
                      <code>npm run worker</code>.
                    </p>
                  </div>
                  <div className="quick-output">
                    <div className="section-head">
                      <h3>Video vừa tạo</h3>
                      <button
                        className="text-btn"
                        onClick={() => setPage("Xuất video")}
                      >
                        Xem hàng đợi <ArrowRight size={14} />
                      </button>
                    </div>
                    {latestOutputJob?.output ? (
                      <>
                        <video
                          controls
                          preload="metadata"
                          className="output-video"
                          src={url(latestOutputJob.output)}
                        />
                        <div className="row downloads">
                          <a href={url(latestOutputJob.output)} download>
                            <Download size={14} /> MP4
                          </a>
                          <a href={url(latestOutputJob.srt)} download>
                            SRT
                          </a>
                          <a href={url(latestOutputJob.vtt)} download>
                            VTT
                          </a>
                        </div>
                      </>
                    ) : (
                      <div className="empty compact mini-empty">
                        <MonitorPlay />
                        <h3>Chưa có video để xem</h3>
                        <p>
                          Sau khi worker xuất xong, MP4 sẽ xuất hiện ngay tại
                          đây.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {projectJobs.length > 0 && (
                <div className="command-jobs">{jobsView(3, projectJobs)}</div>
              )}
            </section>
          )}
          {page === "Tổng quan" && (
            <>
              <section className="stats">
                {[
                  [
                    Library,
                    "Dự án truyện",
                    data.projects.length,
                    "Câu chuyện đang phát triển",
                  ],
                  [
                    BookOpen,
                    "Tổng số chương",
                    data.projects.reduce((n, p) => n + p.chapters.length, 0),
                    "Sẵn sàng để kể lại",
                  ],
                  [Film, "Video hoàn thành", done, "Đã xuất từ FFmpeg"],
                  [
                    Layers,
                    "Tác vụ đang xử lý",
                    active.length,
                    "Trong hàng đợi của bạn",
                  ],
                ].map(([Icon, label, value, note]) => {
                  const I = Icon as typeof Film;
                  return (
                    <div className="stat" key={String(label)}>
                      <div className="row">
                        <span>{String(label)}</span>
                        <I size={19} />
                      </div>
                      <strong>{String(value).padStart(2, "0")}</strong>
                      <small>{String(note)}</small>
                    </div>
                  );
                })}
              </section>
              <section className="start-banner">
                <div>
                  <span className="tag">
                    <Sparkles size={14} /> MỘT CÂU CHUYỆN. NHIỀU KHẢ NĂNG.
                  </span>
                  <h2>
                    Câu chuyện của bạn,
                    <br />
                    sẵn sàng lên hình.
                  </h2>
                  <p>
                    Nhập bản thảo, chọn giọng kể và để StoryFlow
                    <br className="desktop" /> giúp bạn chuẩn bị từng cảnh phim.
                  </p>
                  <button className="primary" onClick={newProject}>
                    Bắt đầu một câu chuyện <ArrowRight size={17} />
                  </button>
                </div>
                <div className="pipeline">
                  <div className="pipeline-card">
                    <span className="step-icon">
                      <BookOpen />
                    </span>
                    <div>
                      <strong>01. Bản thảo</strong>
                      <small>Truyện dài, nội dung nhiều chương</small>
                    </div>
                    <CheckCircle2 size={18} />
                  </div>
                  <div className="pipeline-line" />
                  <div className="pipeline-card">
                    <span className="step-icon purple">
                      <Mic />
                    </span>
                    <div>
                      <strong>02. Giọng kể & hình ảnh</strong>
                      <small>Mỗi phân cảnh, một cảm xúc</small>
                    </div>
                    <Sparkles size={18} />
                  </div>
                  <div className="pipeline-line" />
                  <div className="pipeline-card final">
                    <span className="step-icon dark">
                      <Play fill="currentColor" />
                    </span>
                    <div>
                      <strong>03. Video của bạn</strong>
                      <small>YouTube · Shorts · Reels</small>
                    </div>
                    <span className="mini-badge">MP4</span>
                  </div>
                </div>
              </section>
              <div className="two-col">
                <section className="panel">
                  <div className="section-head">
                    <h2>Dự án gần đây</h2>
                    <button
                      className="text-btn"
                      onClick={() => setPage("Dự án truyện")}
                    >
                      Tất cả <ArrowRight size={15} />
                    </button>
                  </div>
                  {data.projects.length ? (
                    data.projects.slice(0, 3).map((p, i) => (
                      <button
                        className="project-row"
                        key={p.id}
                        onClick={() => openProject(p)}
                      >
                        <span className={`book-cover cover-${i % 3}`}>
                          <BookOpen size={23} />
                        </span>
                        <div>
                          <strong>{p.name}</strong>
                          <small>
                            {p.chapters.length} chương ·{" "}
                            {p.chapters.reduce(
                              (n, c) => n + c.scenes.length,
                              0,
                            )}{" "}
                            cảnh
                          </small>
                        </div>
                        <ChevronRight size={17} />
                      </button>
                    ))
                  ) : (
                    <div className="empty compact">
                      <BookOpen />
                      <h3>Chưa có dự án nào</h3>
                      <p>
                        Dán truyện hoặc tải tệp TXT/DOCX để tạo dự án đầu tiên.
                      </p>
                      <button className="text-btn" onClick={newProject}>
                        Nhập bản thảo <ArrowRight size={16} />
                      </button>
                    </div>
                  )}
                </section>
                <section className="panel">
                  <div className="section-head">
                    <h2>Tiến độ xuất video</h2>
                    <span className="badge">
                      {active.length} đang chờ / chạy
                    </span>
                  </div>
                  {jobsView(2)}
                </section>
              </div>
              <div className="tip">
                <Headphones size={20} />
                <span>
                  <strong>Một bước duyệt, một video chỉn chu.</strong> Bật chế
                  độ duyệt trước để nghe lời đọc, xem ảnh và duyệt cảnh trước
                  khi xuất.
                </span>
              </div>
            </>
          )}
          {page === "Dự án truyện" && (
            <>
              {!data.projects.length && (
                <div className="panel empty compact">
                  <BookOpen size={30} />
                  <h2>Chưa có dự án nào</h2>
                  <p>
                    Dán nội dung hoặc tải tệp truyện lên. Ứng dụng sẽ tự tách
                    chương cho bạn.
                  </p>
                </div>
              )}
              <section className="project-grid">
                {data.projects.map((p, i) => (
                  <button
                    className="project-card"
                    key={p.id}
                    onClick={() => openProject(p)}
                  >
                    <div className={`project-art cover-${i % 3}`}>
                      <BookOpen size={44} />
                      <span>
                        {String(p.chapters.length).padStart(2, "0")} CHƯƠNG
                      </span>
                    </div>
                    <div>
                      <h2>{p.name}</h2>
                      <p>
                        {p.chapters.reduce((n, c) => n + c.scenes.length, 0)}{" "}
                        cảnh ·{" "}
                        {new Date(p.createdAt).toLocaleDateString("vi-VN")}
                      </p>
                      <span className="text-link">
                        Mở dự án <ArrowUpRight size={16} />
                      </span>
                    </div>
                  </button>
                ))}
                <button className="new-card" onClick={newProject}>
                  <Plus size={28} /> Tạo dự án truyện mới
                </button>
              </section>
              {project && (
                <section className="panel chapter-manager">
                  <div className="section-head">
                    <h2>Danh sách chương</h2>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => newChapter(project.id)}
                    >
                      <Plus size={17} />
                      Thêm chương thủ công
                    </button>
                  </div>
                  <label>
                    Dự án quản lý chương
                    <select
                      value={project.id}
                      onChange={(e) => setPid(e.target.value)}
                    >
                      {data.projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="muted" data-testid="chapter-count">
                    Tổng số chương: {project.chapters.length}
                  </p>
                  <div className="manual-chapter-list">
                    {project.chapters.map((c, i) => (
                      <div className="chapter-row" key={c.id}>
                        <span className="badge">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <div className="grow">
                          <strong>{c.title}</strong>
                          <p>
                            {c.text.slice(0, 160)}
                            {c.text.length > 160 ? "…" : ""}
                          </p>
                          <small>{c.scenes.length} cảnh</small>
                        </div>
                        <button
                          className="secondary"
                          onClick={() => {
                            setChapterId(c.id);
                            setPage("Tạo video");
                          }}
                        >
                          Xem chương
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
          {needsProject ? (
            <div className="panel empty">
              <BookOpen size={36} />
              <h2>Bắt đầu với một dự án truyện</h2>
              <p>
                Dán truyện hoặc tải tệp TXT/DOCX. Nội dung không có tiêu đề vẫn
                được tạo thành một chương.
              </p>
              <button className="primary" onClick={newProject}>
                Tạo dự án mới
              </button>
            </div>
          ) : (
            project &&
            ![
              "Tổng quan",
              "Dự án truyện",
              "Quản lý kênh",
              "Xuất video",
            ].includes(page) && (
              <>
                <div className="project-selector">
                  <BookOpen size={18} />
                  <select
                    aria-label="Dự án hiện tại"
                    value={project.id}
                    onChange={(e) => {
                      setPid(e.target.value);
                      setDraft(
                        data.projects.find((p) => p.id === e.target.value)!
                          .settings,
                      );
                    }}
                  >
                    {data.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <span>{project.chapters.length} chương</span>
                </div>
                {page === "Tạo video" && (
                  <>
                    <div className="steps">
                      <span className="selected">
                        1 <b>Chọn chương</b>
                      </span>
                      <ChevronRight />
                      <span>
                        2 <b>Chuẩn bị & duyệt cảnh</b>
                      </span>
                      <ChevronRight />
                      <span>
                        3 <b>Xuất video</b>
                      </span>
                    </div>
                    <div className="editor-grid">
                      <section className="panel">
                        <div className="section-head">
                          <h2>Danh sách chương</h2>
                          <label className="check">
                            <input
                              type="checkbox"
                              checked={
                                selected.length === project.chapters.length
                              }
                              onChange={(e) =>
                                setSelected(
                                  e.target.checked
                                    ? project.chapters.map((c) => c.id)
                                    : [],
                                )
                              }
                            />{" "}
                            Tất cả
                          </label>
                        </div>
                        {project.chapters.map((c, i) => (
                          <div
                            className={`chapter-row ${chapter?.id === c.id ? "chosen" : ""}`}
                            key={c.id}
                          >
                            <input
                              aria-label={`Chọn ${c.title}`}
                              type="checkbox"
                              checked={selected.includes(c.id)}
                              onChange={(e) =>
                                setSelected(
                                  e.target.checked
                                    ? [...selected, c.id]
                                    : selected.filter((x) => x !== c.id),
                                )
                              }
                            />
                            <button onClick={() => setChapterId(c.id)}>
                              <small>
                                CHƯƠNG {String(i + 1).padStart(2, "0")}
                              </small>
                              <strong>{c.title}</strong>
                              <span>
                                {c.scenes.length} cảnh ·{" "}
                                {c.scenes.filter((s) => s.approved).length} đã
                                duyệt
                              </span>
                              <span className="chapter-status">
                                {(() => {
                                  const job = data.jobs.find(
                                    (j) =>
                                      j.projectId === project.id &&
                                      j.chapterIds.includes(c.id),
                                  );
                                  return job
                                    ? job.status === "done" && !job.output
                                      ? "Sẵn sàng duyệt"
                                      : statusLabel[job.status]
                                    : "Chưa xử lý";
                                })()}
                              </span>
                            </button>
                            <ChevronRight size={16} />
                          </div>
                        ))}
                      </section>
                      <section className="panel config">
                        <h2>Thiết lập kịch bản</h2>
                        <label>
                          Chế độ nội dung
                          <select
                            value={draft.mode}
                            onChange={(e) =>
                              field("mode", e.target.value as Settings["mode"])
                            }
                          >
                            <option value="original">
                              Giữ nguyên nội dung
                            </option>
                            <option value="review">
                              Viết lại kiểu đánh giá phim
                            </option>
                            <option value="summary">Tóm tắt chương</option>
                          </select>
                        </label>
                        <label>
                          Phong cách kể chuyện
                          <textarea
                            value={draft.customPrompt}
                            onChange={(e) =>
                              field("customPrompt", e.target.value)
                            }
                            placeholder="Ví dụ: Kể chậm rãi, ấm áp, giữ sự bí ẩn…"
                            rows={3}
                          />
                        </label>
                        <div className="row">
                          <button
                            disabled={busy}
                            className="secondary"
                            onClick={async () => {
                              if (await saveSettings())
                                await action(
                                  {
                                    action: "plan",
                                    projectId: project.id,
                                    chapterIds: selected,
                                  },
                                  "Đã chia lại cảnh. Tài nguyên cũ của các cảnh này được bỏ khỏi dự án.",
                                );
                            }}
                          >
                            <Sparkles size={16} /> Chia lại cảnh
                          </button>
                          <span className="muted small">
                            Thay thế các cảnh đã sửa
                          </span>
                        </div>
                        <hr />
                        <label>
                          Định dạng video
                          <select
                            value={draft.aspect}
                            onChange={(e) =>
                              field(
                                "aspect",
                                e.target.value as Settings["aspect"],
                              )
                            }
                          >
                            <option>16:9</option>
                            <option>9:16</option>
                          </select>
                        </label>
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={merge}
                            onChange={(e) => setMerge(e.target.checked)}
                          />{" "}
                          Ghép chương đã chọn thành một video
                        </label>
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={draft.humanCheck}
                            onChange={(e) =>
                              field("humanCheck", e.target.checked)
                            }
                          />{" "}
                          Duyệt tài nguyên trước khi xuất video
                        </label>
                        <div className="estimate">
                          <strong>Ước tính cho {selected.length} chương</strong>
                          <div>
                            <span>
                              {charCount.toLocaleString("vi-VN")} ký tự TTS
                            </span>
                            <span>{count} ảnh</span>
                            <span>
                              ~{Math.max(1, Math.round(charCount / 14 / 60))}{" "}
                              phút video
                            </span>
                          </div>
                          <small>
                            Xuất dự kiến ~{Math.max(1, count * 2)} phút, tùy
                            máy. Chi phí thực tế phụ thuộc dịch vụ. Chỉ dùng API
                            và tài nguyên thật.
                          </small>
                        </div>
                        <div className="row wrap">
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => enqueue(true)}
                          >
                            <Images size={16} /> Tạo lời đọc & ảnh
                          </button>
                          <button
                            className="primary"
                            disabled={busy || !renderReady}
                            onClick={() => enqueue()}
                          >
                            <Play size={16} /> Xuất {selected.length} chương
                          </button>
                        </div>
                      </section>
                    </div>
                  </>
                )}
                {["Tạo video", "Ảnh AI"].includes(page) && chapter && (
                  <section className="panel scene-panel">
                    <div className="section-head">
                      <div>
                        <h2>
                          {page === "Ảnh AI"
                            ? "Tự động chia cảnh"
                            : "Duyệt phân cảnh"}
                        </h2>
                        <p className="muted">
                          {chapter.title} · Có thể sửa nội dung và prompt từng
                          cảnh
                        </p>
                      </div>
                      <select
                        aria-label="Chọn chương để xem cảnh"
                        value={chapter.id}
                        onChange={(e) => setChapterId(e.target.value)}
                      >
                        {project.chapters.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.title}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-grid">
                      <label>
                        Tạo ảnh
                        <select
                          aria-label="Tạo ảnh"
                          value={draft.imageEnabled === false ? "off" : "on"}
                          onChange={(e) =>
                            field("imageEnabled", e.target.value === "on")
                          }
                        >
                          <option value="on">Bật</option>
                          <option value="off">Tắt</option>
                        </select>
                      </label>
                      <label>
                        Engine ảnh
                        <select
                          aria-label="Engine ảnh"
                          value={draft.imageProvider || "openai"}
                          onChange={(e) =>
                            field(
                              "imageProvider",
                              e.target.value as Settings["imageProvider"],
                            )
                          }
                        >
                          <option value="flux2-local">FLUX.2 local</option>
                          <option value="openai">API OpenAI</option>
                        </select>
                      </label>
                      <label>
                        Ảnh động
                        <select
                          aria-label="Ảnh động"
                          value={draft.motionMode || "off"}
                          onChange={(e) =>
                            field(
                              "motionMode",
                              e.target.value as Settings["motionMode"],
                            )
                          }
                        >
                          <option value="off">Tắt</option>
                          <option value="selected">Chỉ cảnh đã chọn</option>
                          <option value="all">Toàn bộ cảnh</option>
                        </select>
                      </label>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={saveSettings}
                      >
                        Lưu lựa chọn tạo ảnh
                      </button>
                    </div>
                    <p className="muted">
                      Tắt tạo ảnh: dùng ảnh đã có hoặc tải ảnh lên. Ảnh động mặc
                      định tắt; cảnh chưa có clip vẫn dùng ảnh tĩnh.
                    </p>
                    <div className="row wrap media-toolbar">
                      <button
                        className="secondary"
                        disabled={busy || draft.imageEnabled === false}
                        onClick={() => generateMedia("image")}
                      >
                        Tạo ảnh cho toàn bộ chương
                      </button>
                      <button
                        className="secondary"
                        disabled={
                          busy ||
                          !draft.motionMode ||
                          draft.motionMode === "off"
                        }
                        onClick={() => generateMedia("motion")}
                      >
                        Tạo ảnh động cho các cảnh được chọn trong chương
                      </button>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => generateMedia("audio")}
                      >
                        Tạo lời đọc cho toàn bộ chương
                      </button>
                      <label>
                        Tỉ lệ ảnh
                        <select
                          value={draft.aspect}
                          onChange={(e) =>
                            field(
                              "aspect",
                              e.target.value as Settings["aspect"],
                            )
                          }
                        >
                          <option>16:9</option>
                          <option>9:16</option>
                        </select>
                      </label>
                    </div>
                    {(!draft.ttsProvider || draft.ttsProvider === "cloud") &&
                      !data.providers?.tts.configured && (
                        <p className="form-error">Chưa cấu hình API TTS</p>
                      )}
                    {draft.ttsProvider === "vieneu-local" && (
                      <p className="muted">
                        {data.providers?.local.vieneu.message}
                      </p>
                    )}
                    {draft.ttsProvider === "korva-local" && (
                      <p className="muted">
                        {data.providers?.local.korva.message}
                      </p>
                    )}
                    {draft.imageEnabled !== false &&
                      draft.imageProvider !== "flux2-local" &&
                      !data.providers?.image.configured && (
                        <p className="form-error">Chưa cấu hình API tạo ảnh</p>
                      )}
                    {!renderReady && (
                      <p className="muted">
                        Chỉ xuất video khi mọi cảnh đã có tệp lời đọc và ảnh
                        thật.
                      </p>
                    )}
                    <div className="scene-grid">
                      {chapter.scenes.map((s, i) => (
                        <article className="scene" key={s.id}>
                          <div className="scene-image">
                            {s.image && s.imageSource ? (
                              <img
                                src={url(s.image)}
                                alt={`Minh họa cảnh ${i + 1}`}
                              />
                            ) : (
                              <>
                                <Images size={34} />
                                <span>Chưa tạo ảnh minh họa</span>
                              </>
                            )}
                            <b>CẢNH {String(i + 1).padStart(2, "0")}</b>
                            <small>
                              {s.audioSource
                                ? Math.round(s.duration) + "s"
                                : "Chưa có lời đọc"}
                            </small>
                          </div>
                          <div className="scene-body">
                            {draft.motionMode === "selected" && (
                              <label>
                                <input
                                  type="checkbox"
                                  checked={!!s.motionSelected}
                                  disabled={busy}
                                  onChange={(e) =>
                                    action({
                                      action: "scene",
                                      projectId: project.id,
                                      chapterId: chapter.id,
                                      scene: {
                                        ...s,
                                        motionSelected: e.target.checked,
                                      },
                                    })
                                  }
                                />{" "}
                                Chọn cảnh này cho ảnh động
                              </label>
                            )}
                            <p className="muted">
                              {s.audio ? "Đã tạo audio" : "Chưa tạo audio"} ·{" "}
                              {s.image ? "Đã tạo ảnh" : "Chưa tạo ảnh"} ·{" "}
                              {!draft.motionMode || draft.motionMode === "off"
                                ? "Ảnh động tắt"
                                : s.motionStatus === "working"
                                  ? "Đang tạo ảnh động"
                                  : s.motionStatus === "error"
                                    ? "Lỗi ảnh động"
                                    : s.motion
                                      ? "Đã tạo ảnh động"
                                      : "Chưa tạo ảnh động"}
                            </p>
                            {s.motion && (
                              <video
                                controls
                                preload="metadata"
                                style={{ width: "100%" }}
                                src={url(s.motion)}
                              />
                            )}
                            {s.motionError && (
                              <p className="form-error">{s.motionError}</p>
                            )}
                            <p>{s.text}</p>
                            <details>
                              <summary>Mô tả ảnh</summary>
                              <p>{s.prompt}</p>
                            </details>
                            {s.audio && s.audioSource && (
                              <audio
                                controls
                                preload="metadata"
                                src={url(s.audio)}
                              />
                            )}
                            <div className="scene-actions">
                              <button
                                className="secondary"
                                disabled={
                                  busy ||
                                  !s.image ||
                                  !draft.motionMode ||
                                  draft.motionMode === "off" ||
                                  (draft.motionMode === "selected" &&
                                    !s.motionSelected) ||
                                  s.motionStatus === "working"
                                }
                                onClick={() => generateMedia("motion", s)}
                              >
                                Tạo ảnh động cho cảnh này
                              </button>
                              <button
                                className="secondary"
                                disabled={
                                  busy ||
                                  draft.imageEnabled === false ||
                                  s.imageStatus === "working"
                                }
                                onClick={() => generateMedia("image", s)}
                              >
                                {s.imageStatus === "working"
                                  ? "Đang tạo ảnh…"
                                  : s.imageSource
                                    ? "Tạo lại ảnh"
                                    : "Tạo ảnh cảnh này"}
                              </button>
                              <button
                                className="secondary"
                                disabled={busy || s.audioStatus === "working"}
                                onClick={() => generateMedia("audio", s)}
                              >
                                {s.audioStatus === "working"
                                  ? "Đang tạo lời đọc…"
                                  : s.audioSource
                                    ? "Tạo lại lời đọc"
                                    : "Tạo lời đọc cảnh này"}
                              </button>
                              {s.image && s.imageSource && (
                                <a href={url(s.image)} download>
                                  Tải ảnh
                                </a>
                              )}
                              {s.audio && s.audioSource && (
                                <a href={url(s.audio)} download>
                                  Tải MP3
                                </a>
                              )}
                            </div>
                            {s.imageStatus === "done" && s.imageSource && (
                              <p className="media-ok">Đã lưu ảnh thật</p>
                            )}
                            {s.audioStatus === "done" && s.audioSource && (
                              <p className="media-ok">Đã lưu lời đọc thật</p>
                            )}
                            {s.imageError && (
                              <p className="form-error">{s.imageError}</p>
                            )}
                            {s.audioError && (
                              <p className="form-error">{s.audioError}</p>
                            )}
                            <div className="row">
                              <button
                                className="secondary"
                                onClick={() => setSceneDraft({ ...s })}
                              >
                                Chỉnh sửa
                              </button>
                              <button
                                disabled={busy || !s.audio || !s.image}
                                className={s.approved ? "approved" : "text-btn"}
                                onClick={() =>
                                  action({
                                    action: "scene",
                                    projectId: project.id,
                                    chapterId: chapter.id,
                                    scene: { ...s, approved: !s.approved },
                                  })
                                }
                              >
                                <Check size={15} />
                                {s.approved ? "Đã duyệt" : "Duyệt cảnh"}
                              </button>
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                )}
                {page === "Giọng đọc" && (
                  <section className="panel config">
                    <div className="section-head">
                      <div>
                        <h2>Chọn giọng kể cho câu chuyện</h2>
                        <p className="muted">
                          Các cấu hình giọng tiếng Việt để lựa chọn phong cách
                          đọc. Chỉ kết nối giọng được nhà cung cấp cấp quyền;
                          không sao chép giọng cá nhân.
                        </p>
                      </div>
                      <Headphones size={28} />
                    </div>
                    <div className="notice">
                      Nhóm Local miễn phí tạo giọng trên máy. VieNeu cần đang
                      chạy; Korva cần cài CLI và tải mô hình lần đầu. Nhóm API
                      đám mây là lựa chọn riêng và có thể tính phí.
                    </div>
                    <div
                      className="tabs"
                      role="group"
                      aria-label="Lọc giọng đọc"
                    >
                      {voiceFilters.map((filter) => (
                        <button
                          key={filter}
                          className={voiceFilter === filter ? "selected" : ""}
                          aria-pressed={voiceFilter === filter}
                          onClick={() => setVoiceFilter(filter)}
                        >
                          {filter}
                        </button>
                      ))}
                    </div>
                    <p className="muted">
                      Đang chọn:{" "}
                      <strong>
                        {visibleVoices.find(
                          (v) =>
                            v.id === draft.voice &&
                            v.provider === (draft.ttsProvider || "cloud"),
                        )?.name ||
                          getVietnameseVoice(draft.voice)?.name ||
                          "Giọng đã lưu trước đây"}
                      </strong>{" "}
                      · {visibleVoices.length} giọng phù hợp
                    </p>
                    {["local", "cloud"].map((group) => (
                      <section key={group}>
                        <h3>
                          {group === "local"
                            ? "Local miễn phí"
                            : "Dịch vụ API tùy chọn"}
                        </h3>
                        <div className="voice-grid">
                          {visibleVoices
                            .filter((v) =>
                              group === "cloud"
                                ? v.provider === "cloud"
                                : v.provider !== "cloud",
                            )
                            .sort(
                              (a, b) =>
                                Number(b.provider === "vieneu-local") -
                                Number(a.provider === "vieneu-local"),
                            )
                            .map((v) => (
                              <article
                                className={`voice ${draft.voice === v.id && (draft.ttsProvider || "cloud") === v.provider ? "chosen" : ""}`}
                                key={v.key}
                              >
                                <span className="voice-icon">
                                  <Mic size={23} />
                                </span>
                                <strong>{v.name}</strong>
                                <span className="badge">
                                  {v.provider === "vieneu-local"
                                    ? "VieNeu-TTS local"
                                    : v.provider === "korva-local"
                                      ? "KorvaTTS local"
                                      : "API đám mây"}
                                </span>
                                <small>{v.description}</small>
                                <small>
                                  {v.provider === "cloud" && v.configured
                                    ? "Đã cấu hình mã giọng"
                                    : v.status}
                                </small>
                                {v.voiceId && (
                                  <small>Mã dịch vụ: {v.voiceId}</small>
                                )}
                                <button
                                  className="secondary"
                                  aria-label={"Chọn giọng " + v.name}
                                  aria-pressed={
                                    draft.voice === v.id &&
                                    (draft.ttsProvider || "cloud") ===
                                      v.provider
                                  }
                                  onClick={() =>
                                    setDraft((p) => ({
                                      ...p,
                                      voice: v.id,
                                      ttsProvider: v.provider,
                                    }))
                                  }
                                >
                                  {draft.voice === v.id &&
                                  (draft.ttsProvider || "cloud") === v.provider
                                    ? "Đang chọn"
                                    : "Chọn giọng"}
                                </button>
                                <button
                                  className="primary"
                                  disabled={!!previews[v.key]?.busy}
                                  onClick={() => previewVoice(v.id, v.provider)}
                                >
                                  <Play size={14} />
                                  {previews[v.key]?.busy
                                    ? "Đang tạo bản nghe thử…"
                                    : "Nghe thử"}
                                </button>
                                {previews[v.key]?.file && (
                                  <>
                                    <audio
                                      controls
                                      autoPlay
                                      preload="metadata"
                                      src={url(previews[v.key].file)}
                                    />
                                    <a
                                      href={url(previews[v.key].file)}
                                      download
                                    >
                                      Tải MP3 nghe thử
                                    </a>
                                  </>
                                )}
                                {previews[v.key]?.error && (
                                  <p role="alert" className="form-error">
                                    {previews[v.key].error}
                                  </p>
                                )}
                              </article>
                            ))}
                        </div>
                      </section>
                    ))}
                    <p className="muted">
                      Vietnamese TTS Studio - Clone giọng local - đang phát
                      triển
                    </p>
                    <div className="form-grid">
                      {[
                        ["speed", "Tốc độ", 0.5, 2, 0.1],
                        ["pitch", "Cao độ (bán âm)", -6, 6, 1],
                        ["volume", "Âm lượng", 0, 2, 0.1],
                        ["pause", "Nghỉ cuối cảnh (giây)", 0, 3, 0.1],
                      ].map(([key, label, min, max, step]) => (
                        <label key={String(key)}>
                          {label}{" "}
                          <strong>
                            {String(draft[key as keyof Settings])}
                          </strong>
                          <input
                            type="range"
                            min={min}
                            max={max}
                            step={step}
                            value={Number(draft[key as keyof Settings])}
                            onChange={(e) =>
                              field(key as "speed", Number(e.target.value))
                            }
                          />
                        </label>
                      ))}
                    </div>
                    <div className="notice">
                      Câu nghe thử: “Chào bạn, hãy cùng bắt đầu một câu chuyện
                      mới.” Âm thanh chỉ xuất hiện sau khi dịch vụ trả về tệp
                      hợp lệ.
                    </div>
                    <div className="row">
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={saveSettings}
                      >
                        Lưu giọng đọc
                      </button>
                    </div>
                    <p className="muted small">
                      Đổi engine, giọng hoặc thông số đọc sẽ gỡ liên kết audio
                      cũ của các cảnh. Tạo lại lời đọc để áp dụng thiết lập mới.
                    </p>
                  </section>
                )}
                {page === "Ảnh AI" && (
                  <section className="panel config">
                    <h2>Phong cách hình ảnh & Thư viện mô tả ảnh</h2>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={async () => {
                        if (chapter && (await saveSettings()))
                          await action(
                            {
                              action: "plan",
                              projectId: project.id,
                              chapterIds: [chapter.id],
                            },
                            "Đã áp dụng phong cách vào mô tả từng cảnh.",
                          );
                      }}
                    >
                      <Sparkles size={16} />
                      Chia lại cảnh theo phong cách
                    </button>
                    <div className="style-list">
                      {styles.map((s) => (
                        <button
                          className={draft.style === s ? "selected" : ""}
                          key={s}
                          onClick={() => field("style", s)}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                    <label>
                      Mô tả phong cách
                      <textarea
                        value={draft.customPrompt}
                        onChange={(e) => field("customPrompt", e.target.value)}
                        rows={3}
                      />
                    </label>
                    <div className="row">
                      <input
                        placeholder="Tên mẫu"
                        aria-label="Tên mẫu"
                        value={presetName}
                        onChange={(e) => setPresetName(e.target.value)}
                      />
                      <button
                        className="secondary"
                        onClick={() =>
                          action(
                            {
                              action: "preset",
                              name: presetName,
                              prompt: draft.customPrompt,
                            },
                            "Đã lưu vào thư viện",
                          )
                        }
                      >
                        Lưu mẫu
                      </button>
                      <button className="primary" onClick={saveSettings}>
                        Lưu cấu hình
                      </button>
                    </div>
                    {data.presets.map((p) => (
                      <button
                        className="preset"
                        key={p.id}
                        onClick={() => field("customPrompt", p.prompt)}
                      >
                        <Sparkles size={16} />
                        {p.name}
                      </button>
                    ))}
                    <p className="muted">
                      Lưu phong cách rồi dùng “Chia lại cảnh” để áp dụng vào
                      prompt mới.
                    </p>
                  </section>
                )}
                {page === "Phụ đề" && (
                  <div className="two-col">
                    <section className="panel config">
                      <h2>Phụ đề của bạn</h2>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={draft.burnSubtitles}
                          onChange={(e) =>
                            field("burnSubtitles", e.target.checked)
                          }
                        />{" "}
                        Đốt phụ đề vào video
                      </label>
                      <label>
                        Phông chữ
                        <select
                          value={draft.font}
                          onChange={(e) => field("font", e.target.value)}
                        >
                          {[
                            "Arial",
                            "Tahoma",
                            "Verdana",
                            "Times New Roman",
                          ].map((f) => (
                            <option key={f}>{f}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Màu chữ
                        <input
                          type="color"
                          value={draft.color}
                          onChange={(e) => field("color", e.target.value)}
                        />
                      </label>
                      <label>
                        Viền chữ
                        <input
                          type="range"
                          min="0"
                          max="5"
                          value={draft.outline}
                          onChange={(e) =>
                            field("outline", Number(e.target.value))
                          }
                        />
                      </label>
                      <label>
                        Vị trí
                        <select
                          value={draft.position}
                          onChange={(e) =>
                            field(
                              "position",
                              e.target.value as Settings["position"],
                            )
                          }
                        >
                          <option value="bottom">Bên dưới</option>
                          <option value="top">Bên trên</option>
                        </select>
                      </label>
                      <button className="primary" onClick={saveSettings}>
                        Lưu phụ đề
                      </button>
                      <p className="muted small">
                        SRT/VTT dùng thời lượng lời đọc thực tế, chia thời gian
                        theo số từ. MVP chưa có căn chỉnh từng từ bằng nhận dạng
                        tiếng nói.
                      </p>
                    </section>
                    <section className="panel">
                      <h2>Xem trước kiểu chữ</h2>
                      <div
                        className={`subtitle-preview ${draft.position}`}
                        style={{ background: draft.brandColor }}
                      >
                        <span
                          style={{
                            fontFamily: draft.font,
                            color: draft.color,
                            WebkitTextStroke: `${draft.outline / 3}px #222`,
                          }}
                        >
                          Có những câu chuyện
                          <br />
                          chỉ đang chờ được kể.
                        </span>
                      </div>
                      <p className="muted">
                        Tải SRT và VTT từ tác vụ đã hoàn thành trong mục Xuất
                        video.
                      </p>
                    </section>
                  </div>
                )}
                {page === "Cài đặt" && (
                  <div className="two-col">
                    <section className="panel config">
                      <h2>Nhà cung cấp</h2>
                      <div className="notice">
                        <p>
                          {data.providers?.tts.configured
                            ? "Đã cấu hình TTS: " + data.providers.tts.provider
                            : "Chưa cấu hình API TTS"}
                        </p>
                        <p>
                          {data.providers?.image.configured
                            ? "Đã cấu hình tạo ảnh: " +
                              data.providers.image.provider
                            : "Chưa cấu hình API tạo ảnh"}
                        </p>
                      </div>
                      <p className="muted">
                        Cấu hình nhà cung cấp và mã giọng trong .env.local rồi
                        khởi động lại ứng dụng và tiến trình nền. Không có chế
                        độ tạo âm thanh im lặng hay ảnh màu thay thế. “Đã cấu
                        hình” không có nghĩa là khóa đã được dịch vụ xác thực.
                      </p>
                      <h3>Chạy hàng loạt</h3>
                      <p>
                        Chọn tất cả chương trong Tạo video. Tiến trình nền xử lý
                        lần lượt và lưu trạng thái từng tác vụ. Giữ máy bật để
                        chạy qua đêm.
                      </p>
                      <button className="primary" onClick={saveSettings}>
                        Lưu cấu hình
                      </button>
                    </section>
                    <section className="panel config">
                      <h2>Bộ nhận diện thương hiệu</h2>
                      <label>
                        Màu thương hiệu
                        <input
                          type="color"
                          value={draft.brandColor}
                          onChange={(e) => field("brandColor", e.target.value)}
                        />
                      </label>
                      {assetInput(
                        "logo",
                        "Biểu trưng PNG / JPG",
                        "image/png,image/jpeg,image/webp",
                      )}
                      {assetInput("intro", "Video mở đầu · MP4", ".mp4")}
                      {assetInput("outro", "Video kết thúc · MP4", ".mp4")}
                      {assetInput("music", "Nhạc nền · MP3 / WAV", ".mp3,.wav")}
                      <label>
                        Âm lượng nhạc nền ·{" "}
                        {Math.round(draft.musicVolume * 100)}%
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={draft.musicVolume}
                          onChange={(e) =>
                            field("musicVolume", Number(e.target.value))
                          }
                        />
                      </label>
                      <p className="muted small">
                        Video mở đầu/kết thúc dùng âm thanh im lặng; nhạc nền áp
                        dụng cho toàn video. Phông chữ phụ đề đặt ở mục Phụ đề.
                      </p>
                      <button className="primary" onClick={saveSettings}>
                        Lưu Bộ nhận diện thương hiệu
                      </button>
                    </section>
                  </div>
                )}
              </>
            )
          )}
          {page === "Xuất video" && (
            <section className="panel">
              <div className="section-head">
                <div>
                  <h2>Hàng đợi sản xuất</h2>
                  <p className="muted">
                    {data.jobs.length} tác vụ · Tạm dừng có hiệu lực sau công
                    đoạn đang chạy
                  </p>
                </div>
                <span className="badge">Xử lý hàng loạt</span>
              </div>
              <div className="notice">
                Chạy <code>npm run worker</code> trong terminal thứ hai để xử lý
                hàng đợi.
              </div>
              {jobsView()}
            </section>
          )}
          {page === "Quản lý kênh" && (
            <>
              <div className="tabs">
                {channelTabs.map((t) => (
                  <button
                    className={channel === t ? "selected" : ""}
                    key={t}
                    onClick={() => setChannel(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <section className="panel empty coming">
                <div className="coming-icon">
                  <Radio size={38} />
                </div>
                <span className="badge development">Đang phát triển</span>
                <h2>
                  {channel === "YouTube"
                    ? "Kết nối câu chuyện với khán giả"
                    : channel}
                </h2>
                <p>
                  {channel === "YouTube"
                    ? "Quản lý kênh và đăng video YouTube ngay từ studio."
                    : channel === "Facebook Page"
                      ? "Quản lý Page và video Facebook tại một nơi."
                      : channel === "Lịch đăng video"
                        ? "Lên lịch xuất bản nội dung cho từng kênh."
                        : "Theo dõi hiệu quả video và sự phát triển của kênh."}
                </p>
                <p className="muted">
                  Tính năng sẽ có trong phiên bản tiếp theo. Chưa kết nối API.
                </p>
              </section>
            </>
          )}
          <footer>
            StoryFlow Studio <span>Được tạo cho những câu chuyện đáng kể.</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
          <button aria-label="Đóng thông báo" onClick={() => setToast("")}>
            ×
          </button>
        </div>
      )}
      {chapterTarget && (
        <Modal
          label="manual-chapter-title"
          onClose={() => !busy && setChapterTarget("")}
        >
          <div className="section-head">
            <h2 id="manual-chapter-title">Thêm chương thủ công</h2>
            <button
              disabled={busy}
              aria-label="Đóng"
              onClick={() => setChapterTarget("")}
            >
              ×
            </button>
          </div>
          <p className="muted">
            Dự án: {data.projects.find((p) => p.id === chapterTarget)?.name}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              const p = await action(
                {
                  action: "addChapter",
                  projectId: chapterTarget,
                  title: chapterTitle,
                  text: chapterText,
                },
                "Đã thêm chương và cập nhật danh sách.",
              );
              if (p) {
                setPid(p.id);
                setChapterId(p.chapters.at(-1)?.id || "");
                setSelected(
                  p.chapters.map((c: Project["chapters"][number]) => c.id),
                );
                setChapterTarget("");
                setPage("Dự án truyện");
              }
            }}
          >
            <label>
              Tên chương
              <input
                autoFocus
                value={chapterTitle}
                onChange={(e) => setChapterTitle(e.target.value)}
                placeholder="Nhập tên chương"
                maxLength={200}
              />
            </label>
            <label>
              Nội dung chương
              <textarea
                rows={10}
                value={chapterText}
                onChange={(e) => setChapterText(e.target.value)}
                placeholder="Dán hoặc nhập toàn bộ nội dung chương…"
              />
            </label>
            {formError && (
              <div className="form-error" role="alert">
                {formError}
              </div>
            )}
            <button type="submit" className="primary wide" disabled={busy}>
              {busy ? "Đang lưu chương…" : "Lưu chương"}
            </button>
          </form>
        </Modal>
      )}
      {modal && (
        <Modal label="new-project" onClose={() => setModal(false)}>
          <div className="section-head">
            <h2 id="new-project">Bắt đầu câu chuyện mới</h2>
            <button aria-label="Đóng" onClick={() => setModal(false)}>
              ×
            </button>
          </div>
          <label>
            Tên dự án
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nhập tên câu chuyện của bạn"
            />
          </label>
          <label className="upload-box">
            <Upload size={25} />
            <strong>Tải bản thảo lên</strong>
            <span>TXT hoặc DOCX · tối đa 30 MB</span>
            <input
              type="file"
              accept=".txt,.docx"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setBusy(true);
                  try {
                    const d = await upload(f);
                    setText(d.text);
                    if (!name) setName(f.name.replace(/\.[^.]+$/, ""));
                  } catch (e) {
                    setFormError(
                      e instanceof Error
                        ? e.message
                        : "Không đọc được tệp truyện. Vui lòng thử lại.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }
              }}
            />
          </label>
          <label>
            Hoặc dán toàn bộ nội dung
            <textarea
              rows={9}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                "Chương 1: Khởi đầu\nNội dung câu chuyện…\n\nChương 2: Hành trình tiếp nối…"
              }
            />
          </label>
          <p className="muted small">
            Tự nhận diện tiêu đề chương và dòng kết thúc phần. Nếu không có tiêu
            đề, toàn bộ nội dung được lưu thành một chương.
          </p>
          <div className="quick-toggles">
            <label className="check">
              <input
                type="checkbox"
                checked={splitChapters}
                onChange={(e) => setSplitChapters(e.target.checked)}
              />{" "}
              Tự tách chương
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.imageEnabled !== false}
                onChange={(e) => field("imageEnabled", e.target.checked)}
              />{" "}
              Tạo ảnh minh họa
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.burnSubtitles}
                onChange={(e) => field("burnSubtitles", e.target.checked)}
              />{" "}
              Thêm phụ đề
            </label>
          </div>
          {formError && (
            <div className="form-error" role="alert">
              {formError}
            </div>
          )}
          <button
            className="primary wide"
            disabled={busy}
            onClick={createStoryProject}
          >
            {busy
              ? "Đang xử lý…"
              : splitChapters
                ? "Tạo dự án & tách chương"
                : "Tạo dự án một chương"}
            <ArrowRight size={17} />
          </button>
        </Modal>
      )}
      {sceneDraft && (
        <Modal label="scene-title" onClose={() => setSceneDraft(null)}>
          <div className="section-head">
            <h2 id="scene-title">Chỉnh sửa phân cảnh</h2>
            <button aria-label="Đóng" onClick={() => setSceneDraft(null)}>
              ×
            </button>
          </div>
          <label>
            Nội dung lời đọc
            <textarea
              rows={5}
              value={sceneDraft.text}
              onChange={(e) =>
                setSceneDraft({ ...sceneDraft, text: e.target.value })
              }
            />
          </label>
          <label>
            Mô tả ảnh
            <textarea
              rows={4}
              value={sceneDraft.prompt}
              onChange={(e) =>
                setSceneDraft({ ...sceneDraft, prompt: e.target.value })
              }
            />
          </label>
          <label>
            Tải ảnh có sẵn lên
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f)
                  try {
                    setSceneDraft({
                      ...sceneDraft,
                      image: (await upload(f)).asset,
                      approved: false,
                    });
                  } catch (e) {
                    setToast(String(e));
                  }
              }}
            />
          </label>
          <div className="row">
            <button
              className="secondary"
              onClick={() =>
                setSceneDraft({
                  ...sceneDraft,
                  audio: undefined,
                  approved: false,
                })
              }
            >
              Xóa lời đọc để tạo lại
            </button>
            <button
              className="secondary"
              onClick={() =>
                setSceneDraft({
                  ...sceneDraft,
                  image: undefined,
                  approved: false,
                })
              }
            >
              Xóa ảnh để tạo lại
            </button>
          </div>
          <p className="muted small">
            Sửa nội dung sẽ xóa liên kết lời đọc; sửa prompt sẽ xóa liên kết
            ảnh.
          </p>
          <button
            className="primary wide"
            disabled={busy}
            onClick={async () => {
              if (
                await action(
                  {
                    action: "scene",
                    projectId: project?.id,
                    chapterId: chapter?.id,
                    scene: sceneDraft,
                  },
                  "Đã lưu cảnh",
                )
              )
                setSceneDraft(null);
            }}
          >
            Lưu phân cảnh
          </button>
        </Modal>
      )}
    </div>
  );
}
