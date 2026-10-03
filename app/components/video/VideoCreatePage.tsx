"use client";
import { useEffect, useState } from "react";
import { Clapperboard, ImagePlus } from "lucide-react";
import type { Settings } from "@/modules/project/types";
import { imageStyles } from "@/modules/imagePrompt/styles";
import {
  initialSettings,
  request,
  upload,
  isActive,
  fileURL,
  type StudioData,
} from "../studio-api";
import { VoiceSelector } from "./VoiceSelector";
import { AdvancedOptions } from "./AdvancedOptions";
import { VisualProfiles } from "./VisualProfiles";
import { ProviderStatus } from "./ProviderStatus";
import { PipelineProgress } from "./PipelineProgress";
export function VideoCreatePage({
  data,
  projectId,
  onProject,
  refresh,
  onImport,
  onLibrary,
}: {
  data: StudioData;
  projectId: string;
  onProject: (id: string) => void;
  refresh: () => Promise<void>;
  onImport: () => void;
  onLibrary: () => void;
}) {
  const project =
    data.projects.find((p) => p.id === projectId) || data.projects[0];
  const [settings, setSettings] = useState<Settings>(initialSettings),
    [selected, setSelected] = useState<string[]>([]),
    [motion, setMotion] = useState<string[]>([]),
    [merge, setMerge] = useState(false),
    [search, setSearch] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (project) {
      setSettings({ ...initialSettings, ...project.settings });
      setSelected(project.chapters.map((c) => c.id));
      setMotion(
        project.chapters
          .flatMap((c) => c.scenes)
          .filter((s) => s.motionSelected)
          .map((s) => s.id),
      );
      setError("");
      setSearch("");
    }
  }, [project?.id]);
  const jobs = data.jobs.filter((j) => j.projectId === project?.id);
  const active = jobs.some(isActive);
  function change(patch: Partial<Settings>) {
    setSettings((s) => ({ ...s, ...patch }));
  }
  async function start() {
    if (!project) return;
    setBusy(true);
    setError("");
    try {
      if (
        !["modal-vieneu", "pollinations", "vieneu-local", "korva-local"].includes(
          settings.ttsProvider || "",
        )
      )
        throw Error("Chọn VieNeu Cloud, VieNeu Local hoặc Korva để tạo video.");
      if (
        settings.motionMode === "selected" &&
        !project.chapters
          .filter((c) => selected.includes(c.id))
          .some((c) => c.scenes.some((s) => motion.includes(s.id)))
      )
        throw Error("Chọn ít nhất một cảnh để tạo ảnh động.");
      await request({
        action: "settings",
        projectId: project.id,
        settings,
      });
      await request({
        action: "motionSelection",
        projectId: project.id,
        sceneIds: motion,
      });
      await request({
        action: "enqueue",
        projectId: project.id,
        chapterIds: selected,
        merge,
        kind: "pipeline",
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function act(action: string, id: string, chapterIds?: string[]) {
    setBusy(true);
    setError("");
    try {
      if (action === "retry" && project && !active) {
        if (
          !["modal-vieneu", "pollinations", "vieneu-local", "korva-local"].includes(
            settings.ttsProvider || "",
          )
        )
          throw Error("Chọn engine giọng hợp lệ trước khi thử lại.");
        await request({
          action: "settings",
          projectId: project.id,
          settings,
        });
        await request({
          action: "motionSelection",
          projectId: project.id,
          sceneIds: motion,
        });
      }
      await request({ action, id, projectId: project?.id, chapterIds });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function addReferences(files?: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError("");
    try {
      const current = settings.referenceImages || [];
      const next = [...current];
      for (const file of Array.from(files).slice(0, Math.max(0, 10 - current.length))) {
        const result = await upload(file);
        if (!result.asset) throw Error("Ảnh tham chiếu không hợp lệ.");
        next.push(result.asset);
      }
      change({ referenceImages: next });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function fallback(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const d = await upload(file);
      if (!d.asset) throw Error("Chọn tệp ảnh PNG, JPG hoặc WebP.");
      change({ fallbackImage: d.asset, fallbackOnImageError: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="page-header">
        <span className="eyebrow">CÂU CHUYỆN LÊN HÌNH</span>
        <h1>Tạo video</h1>
        <p>Chọn dự án và cấu hình video. StoryFlow lo phần còn lại.</p>
      </header>
      {project && (
        <PipelineProgress
          project={project}
          jobs={jobs}
          busy={busy}
          act={(action, id) => void act(action, id)}
        />
      )}
      <div className="video-grid">
        <div className="video-form">
          <section className="card">
            <div className="row between">
              <h2>Dự án</h2>
              {project && (
                <span className="badge">{project.chapters.length} chương</span>
              )}
            </div>
            <label>
              Chọn dự án truyện
              <select
                value={project?.id || ""}
                onChange={(e) => onProject(e.target.value)}
              >
                {!project && <option value="">Chưa có dự án</option>}
                {data.projects.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {!project ? (
              <div className="empty">
                <p>Nhập câu chuyện đầu tiên để bắt đầu.</p>
                <button className="primary" onClick={onImport}>
                  Nhập truyện
                </button>
              </div>
            ) : (
              <details className="chapter-picker" open>
                <summary>
                  Chương được tạo{" "}
                  <span>
                    {selected.length} / {project.chapters.length}
                  </span>
                </summary>
                <div className="row between">
                  <button
                    className="text-button"
                    disabled={active}
                    onClick={() =>
                      setSelected(project.chapters.map((c) => c.id))
                    }
                  >
                    Chọn tất cả
                  </button>
                  <button
                    className="text-button"
                    disabled={active}
                    onClick={() => setSelected([])}
                  >
                    Bỏ chọn tất cả
                  </button>
                </div>
                {project.chapters.length > 6 && (
                  <input
                    aria-label="Tìm chương"
                    placeholder="Tìm chương…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                )}
                <div className="chapter-checks">
                  {project.chapters
                    .filter((c) =>
                      c.title
                        .toLocaleLowerCase("vi")
                        .includes(search.toLocaleLowerCase("vi")),
                    )
                    .map((c) => (
                      <label className="check" key={c.id}>
                        <input
                          type="checkbox"
                          disabled={active}
                          checked={selected.includes(c.id)}
                          onChange={(e) =>
                            setSelected((ids) =>
                              e.target.checked
                                ? [...ids, c.id]
                                : ids.filter((id) => id !== c.id),
                            )
                          }
                        />
                        {c.title}
                      </label>
                    ))}
                </div>
              </details>
            )}
          </section>
          {project && (
            <>
              <fieldset disabled={active || busy} className="config-fields">
                <VoiceSelector
                  settings={settings}
                  change={change}
                  providers={data.providers}
                />
                <section className="card automation-card">
                  <h2>Tự động hóa</h2>
                  <div className="toggles">
                    {(
                      [
                        {
                          key: "audioEnabled",
                          name: "Tự động tạo lời đọc",
                          hint: "Đọc câu chuyện bằng giọng bạn chọn.",
                        },
                        {
                          key: "imageEnabled",
                          name: "Tự động tạo ảnh minh họa",
                          hint: "Hình ảnh phù hợp với nội dung truyện.",
                        },
                        {
                          key: "burnSubtitles",
                          name: "Tự động thêm phụ đề",
                          hint: "Giúp người xem theo dõi câu chuyện.",
                        },
                      ] as const
                    ).map((t) => (
                      <label className="toggle-row" key={t.key}>
                        <span>
                          <strong>{t.name}</strong>
                          <small>{t.hint}</small>
                        </span>
                        <input
                          type="checkbox"
                          role="switch"
                          checked={settings[t.key] !== false}
                          onChange={(e) =>
                            change({ [t.key]: e.target.checked })
                          }
                        />
                      </label>
                    ))}
                    <label className="toggle-row">
                      <span>
                        <strong>Tạo ảnh động bằng AI</strong>
                        <small>Thêm chuyển động với Wan2.2.</small>
                      </span>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={settings.motionMode !== "off"}
                        onChange={(e) =>
                          change({
                            motionMode: e.target.checked ? "all" : "off",
                          })
                        }
                      />
                    </label>
                  </div>
                  {settings.imageEnabled !== false ? (
                    <div className="inset">
                      <div className="row between">
                        <h3>Ảnh minh họa</h3>
                        <span className="badge">
                          {settings.imageProvider?.startsWith("modal-")
                            ? "Cloud GPU"
                            : "Local"}
                        </span>
                      </div>
                      <label>
                        Engine ảnh
                        <select
                          value={settings.imageProvider || "flux2-local"}
                          onChange={(e) =>
                            change({
                              imageProvider: e.target
                                .value as Settings["imageProvider"],
                            })
                          }
                        >
                          <option value="modal-story">
                            Story AI Cloud · Đồng nhất theo chương
                          </option>
                          <option value="modal-reference">
                            Reference AI Cloud · Ảnh tham chiếu
                          </option>
                          <option value="aihorde">
                            AI Horde · Miễn phí cộng đồng
                          </option>
                          <option value="pollinations">
                            Pollinations · Cloud API
                          </option>
                          <option value="flux2-local">
                            FLUX.2 Local · Chất lượng
                          </option>
                          <option value="local-fast">
                            Local Fast · GPU thấp (cần test)
                          </option>
                          <option value="auto-local">
                            Auto · Chỉ engine đã test
                          </option>
                        </select>
                      </label>
                      <label>
                        Phong cách ảnh
                        <select
                          value={settings.style}
                          onChange={(e) => change({ style: e.target.value })}
                        >
                          {imageStyles.map((s) => (
                            <option key={s.name}>{s.name}</option>
                          ))}
                        </select>
                      </label>
                      {settings.imageProvider === "modal-reference" && (
                        <div className="reference-box">
                          <div className="row between">
                            <div>
                              <strong>Ảnh tham chiếu nhân vật</strong>
                              <small>Tối đa 10 ảnh. Nên dùng nhiều góc của cùng nhân vật.</small>
                            </div>
                            <label className="button">
                              <ImagePlus size={16} />
                              Thêm ảnh
                              <input
                                type="file"
                                accept=".png,.jpg,.jpeg,.webp"
                                multiple
                                hidden
                                onChange={(e) => {
                                  void addReferences(e.target.files);
                                  e.target.value = "";
                                }}
                              />
                            </label>
                          </div>
                          <div className="reference-list">
                            {(settings.referenceImages || []).map((image, index) => (
                              <div className="reference-thumb" key={image}>
                                <img src={fileURL(image)} alt={"Tham chiếu " + (index + 1)} />
                                <button
                                  type="button"
                                  aria-label={"Xóa ảnh tham chiếu " + (index + 1)}
                                  onClick={() =>
                                    change({
                                      referenceImages: (settings.referenceImages || []).filter(
                                        (item) => item !== image,
                                      ),
                                    })
                                  }
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                          </div>
                          {!settings.referenceImages?.length && (
                            <p className="muted">
                              Reference AI chỉ chạy khi đã có ít nhất một ảnh tham chiếu thật.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  ) : null}
                  <div className="inset">
                    {settings.imageEnabled !== false && (
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={!!settings.fallbackOnImageError}
                          onChange={(e) =>
                            change({ fallbackOnImageError: e.target.checked })
                          }
                        />
                        Nếu AI tạo ảnh lỗi, dùng ảnh chung thay thế
                      </label>
                    )}
                  </div>
                  {
                    <div className="inset">
                      <p>
                        Dùng ảnh đã có hoặc tải một ảnh chung cho các cảnh còn
                        thiếu.
                      </p>
                      <label className="button">
                        <ImagePlus size={17} />
                        Ảnh dùng chung
                        <input
                          aria-label="Ảnh dùng chung"
                          type="file"
                          accept=".png,.jpg,.jpeg,.webp"
                          hidden
                          onChange={(e) => void fallback(e.target.files?.[0])}
                        />
                      </label>
                      {settings.fallbackImage && (
                        <>
                          <img
                            className="fallback-preview"
                            alt="Ảnh dùng chung"
                            src={fileURL(settings.fallbackImage)}
                          />
                          <button
                            type="button"
                            onClick={() => change({ fallbackImage: undefined })}
                          >
                            Xóa ảnh
                          </button>
                        </>
                      )}
                    </div>
                  }
                  {settings.audioEnabled === false && (
                    <p className="notice">
                      Sử dụng lời đọc đã có. Cảnh thiếu lời đọc sẽ báo lỗi.
                    </p>
                  )}
                  {settings.motionMode !== "off" && (
                    <div className="inset">
                      <h3>Ảnh động · Wan2.2</h3>
                      <p className="muted">
                        Tạo ảnh động cần GPU mạnh và mất nhiều thời gian hơn.
                      </p>
                      <div className="row">
                        <label className="check">
                          <input
                            type="radio"
                            name="motion"
                            checked={settings.motionMode === "all"}
                            onChange={() => change({ motionMode: "all" })}
                          />
                          Tất cả cảnh
                        </label>
                        <label className="check">
                          <input
                            type="radio"
                            name="motion"
                            checked={settings.motionMode === "selected"}
                            onChange={() => change({ motionMode: "selected" })}
                          />
                          Chỉ cảnh được chọn
                        </label>
                      </div>
                      {settings.motionMode === "selected" && (
                        <div className="motion-scenes">
                          {project.chapters
                            .filter((c) => selected.includes(c.id))
                            .map((c) => (
                              <div key={c.id}>
                                <h4>{c.title}</h4>
                                {c.scenes.map((s, i) => (
                                  <label className="check" key={s.id}>
                                    <input
                                      type="checkbox"
                                      checked={motion.includes(s.id)}
                                      onChange={(e) =>
                                        setMotion((ids) =>
                                          e.target.checked
                                            ? [...ids, s.id]
                                            : ids.filter((id) => id !== s.id),
                                        )
                                      }
                                    />
                                    <span>
                                      Cảnh {i + 1} — {s.text.slice(0, 110)}
                                    </span>
                                  </label>
                                ))}
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  )}
                </section>
                <section className="card format-card">
                  <h2>Định dạng & cách xuất</h2>
                  <div className="aspect-options">
                    {[
                      {
                        value: "16:9",
                        name: "YouTube",
                        hint: "Ngang · 1280 × 720",
                      },
                      {
                        value: "9:16",
                        name: "Shorts / Reels",
                        hint: "Dọc · 720 × 1280",
                      },
                    ].map((a) => (
                      <label
                        key={a.value}
                        className={
                          settings.aspect === a.value
                            ? "choice selected"
                            : "choice"
                        }
                      >
                        <input
                          type="radio"
                          name="aspect"
                          checked={settings.aspect === a.value}
                          onChange={() =>
                            change({ aspect: a.value as Settings["aspect"] })
                          }
                        />
                        <span
                          className={
                            "frame " + (a.value === "9:16" ? "portrait" : "")
                          }
                        />
                        <span>
                          <strong>
                            {a.value} {a.name}
                          </strong>
                          <small>{a.hint}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className="export-options">
                    <label className="check">
                      <input
                        type="radio"
                        name="output"
                        checked={!merge}
                        onChange={() => setMerge(false)}
                      />
                      Tạo video riêng theo từng chương
                    </label>
                    <label className="check">
                      <input
                        type="radio"
                        name="output"
                        checked={merge}
                        onChange={() => setMerge(true)}
                      />
                      Gộp các chương đã chọn thành một video
                    </label>
                  </div>
                </section>
                <AdvancedOptions
                  settings={settings}
                  change={change}
                  onError={setError}
                />
                <VisualProfiles project={project} refresh={refresh} />
              </fieldset>
              {error && (
                <div className="notice error" role="alert">
                  Không thực hiện được yêu cầu.
                  <details>
                    <summary>Chi tiết</summary>
                    <pre>{error}</pre>
                  </details>
                </div>
              )}
              <div className="create-bar">
                <div>
                  <strong>
                    {selected.length} chương · {merge ? 1 : selected.length}{" "}
                    video
                  </strong>
                  <small>
                    {settings.aspect} ·{" "}
                    {settings.burnSubtitles ? "Có phụ đề" : "Không phụ đề"}
                  </small>
                </div>
                <button
                  className="primary"
                  disabled={busy || active || selected.length === 0}
                  onClick={start}
                >
                  <Clapperboard size={19} />
                  {busy
                    ? "Đang xử lý…"
                    : active
                      ? "Đang có tác vụ"
                      : "Bắt đầu tạo video"}
                </button>
              </div>
              {jobs.some((job) => job.status === "done" && job.verified) && (
                <div className="completed-summary">
                  <span>✓ Video hoàn thành đã được lưu vào thư viện.</span>
                  <button className="text-button" onClick={onLibrary}>
                    Mở Quản lý video →
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        <aside className="video-side">
          <ProviderStatus
            providers={data.providers}
            settings={settings}
            refresh={refresh}
          />
          <div className="quiet-tip">
            <Clapperboard size={23} />
            <h3>Từ câu chữ đến video</h3>
            <p>
              Chọn giọng, chọn phong cách, rồi để câu chuyện của bạn lên hình.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
