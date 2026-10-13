"use client";
import { useEffect, useRef, useState } from "react";
import { Clapperboard, ImagePlus } from "lucide-react";
import type { Settings } from "@/modules/project/types";
import {
  uploadedImageSettings,
  uploadedImageRequired,
} from "@/modules/project/uploaded-image";
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
import { ProviderStatus } from "./ProviderStatus";
import { PipelineProgress } from "./PipelineProgress";
import { YoutubePublishPanel } from "./YoutubePublishPanel";
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
      setSettings(
        uploadedImageSettings({ ...initialSettings, ...project.settings }),
      );
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
  const creating = useRef(false);
  const progressPanel = useRef<HTMLDivElement>(null);
  function change(patch: Partial<Settings>) {
    setSettings((s) => ({ ...s, ...patch }));
  }
  async function start() {
    if (!project || creating.current || active) return;
    creating.current = true;
    setBusy(true);
    setError("");
    try {
      const missing = project.chapters.filter(c => selected.includes(c.id) && !c.scenes.every(scene => scene.imageSource === "chapter-upload" && scene.image));
      if (missing.length && !settings.fallbackImage)
        throw Error("Chưa có ảnh cho: " + missing.map(c => c.title).slice(0, 8).join(", ") + ". Hãy tải ảnh từng chương hoặc chọn ảnh chung.");
      if (
        ![
          "modal-vieneu",
          "edge-online",
          "pollinations",
          "vieneu-local",
          "korva-local",
        ].includes(settings.ttsProvider || "")
      )
        throw Error("Chọn một engine giọng đọc hợp lệ để tạo video.");
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
      creating.current = false;
      setBusy(false);
    }
  }
  async function createSynopsisVideo() {
    if (!project?.synopsis?.trim() || busy || active) return;
    creating.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await request<{ projectId: string }>({
        action: "createSynopsisVideo",
        projectId: project.id,
        settings,
      });
      await refresh();
      onProject(response.projectId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      creating.current = false;
      setBusy(false);
    }
  }
  async function repairDuplicateChapter() {
    if (!project || active || busy) return;
    if (!window.confirm("Xóa chương 1 giả ngắn khỏi danh sách dự án? Chương 1 thật, nội dung và các video đã hoàn thành sẽ được giữ nguyên.")) return;
    setBusy(true);
    setError("");
    try {
      await request({ action: "repairDuplicateChapters", projectId: project.id });
      await refresh();
      setSelected((ids) => ids.filter((id) => id !== project.chapters[0]?.id));
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  }
  async function act(action: string, id: string, chapterIds?: string[]) {
    setBusy(true);
    setError("");
    try {
      if (["retry", "restart"].includes(action) && project && !active) {
        if (
          ![
            "modal-vieneu",
            "edge-online",
            "pollinations",
            "vieneu-local",
            "korva-local",
          ].includes(settings.ttsProvider || "")
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
  async function actMany(action: string, ids: string[]) {
    if (!ids.length) return;
    setBusy(true);
    setError("");
    try {
      await Promise.all(
        ids.map((id) => request({ action, id, projectId: project?.id })),
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveSharedImage(asset?: string) {
    const next = uploadedImageSettings({ ...settings, fallbackImage: asset });
    if (project)
      await request({
        action: "settings",
        projectId: project.id,
        settings: next,
      });
    setSettings(next);
    await refresh();
  }
  async function removeSharedImage() {
    setBusy(true);
    setError("");
    try {
      await saveSharedImage();
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
      await saveSharedImage(d.asset);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function assignChapterImage(chapterId: string, file?: File) {
    if (!project || !file || busy || active) return;
    setBusy(true);
    setError("");
    try {
      const response = await upload(file);
      if (!response.asset) throw Error("Ảnh không hợp lệ.");
      await request({ action: "setChapterImages", projectId: project.id, assignments: [{ chapterId, image: response.asset }] });
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function removeChapterImage(chapterId: string) {
    if (!project || busy || active) return;
    setBusy(true);
    setError("");
    try {
      await request({ action: "setChapterImages", projectId: project.id, assignments: [{ chapterId, image: null }] });
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function uploadChapterImages(files: FileList | null) {
    if (!project || !files?.length || busy || active) return;
    const chapters = project.chapters.filter(c => selected.includes(c.id));
    const chapterNumber = (value: string) => {
      const m = value.match(/(?:ch(?:ương|uong|apter)?[\s._-]*)?(\d+)(?!.*\d)/iu);
      return m ? Number(m[1]) : undefined;
    };
    const numbers = new Map<number, string[]>();
    for (const chapter of chapters) {
      const n = chapterNumber(chapter.title);
      if (n !== undefined) numbers.set(n, [...(numbers.get(n) || []), chapter.id]);
    }
    const assignments: {chapterId: string; file: File}[] = [];
    const unmatched: string[] = [];
    const used = new Set<string>();
    for (const file of Array.from(files)) {
      const n = chapterNumber(file.name.replace(/\.[^.]+$/, ""));
      const matches = n === undefined ? [] : (numbers.get(n) || []).filter(id => !used.has(id));
      if (matches.length !== 1) { unmatched.push(file.name); continue; }
      used.add(matches[0]);
      assignments.push({chapterId: matches[0], file});
    }
    if (!assignments.length) {
      setError("Không ghép được ảnh nào. Đặt tên ảnh theo số chương, ví dụ: Chuong_4.png, Chuong_5.jpg; hoặc chọn ảnh thủ công ở từng chương.");
      return;
    }
    if (unmatched.length && !window.confirm("Có " + unmatched.length + " ảnh không ghép được chính xác theo số chương: " + unmatched.slice(0, 8).join(", ") + ". Chỉ tải " + assignments.length + " ảnh ghép đúng. Tiếp tục?")) return;
    setBusy(true);
    setError("");
    try {
      const saved: {chapterId: string; image: string}[] = [];
      for (const assignment of assignments) {
        const data = await upload(assignment.file);
        if (!data.asset) throw Error("Ảnh " + assignment.file.name + " không hợp lệ.");
        saved.push({chapterId: assignment.chapterId, image: data.asset});
      }
      await request({ action: "setChapterImages", projectId: project.id, assignments: saved });
      await refresh();
      if (unmatched.length) setError("Đã gán " + saved.length + " ảnh đúng chương. " + unmatched.length + " ảnh chưa ghép được; hãy kiểm tra và gán thủ công.");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <>
      <header className="page-header">
        <span className="eyebrow">CÂU CHUYỆN LÊN HÌNH</span>
        <h1>Tạo video</h1>
        <p>Chọn dự án và cấu hình video. StoryFlow lo phần còn lại.</p>
      </header>
      {project && (
        <div ref={progressPanel}>
          <PipelineProgress
            project={project}
            jobs={jobs}
            busy={busy}
            act={(action, id) => void act(action, id)}
            actMany={(action, ids) => void actMany(action, ids)}
          />
        </div>
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
            {project && project.chapters.length > 1 &&
              /^chương\s*1\s*$/iu.test(project.chapters[0].title) &&
              /^chương\s*1\s*[:：.\-–—]\s*\S/iu.test(project.chapters[1].title) &&
              project.chapters[0].text.length <= 400 && (
                <div className="notice error">
                  <strong>Phát hiện chương 1 giả đứng trước chương 1 thật.</strong>
                  <p>Hãy sửa danh sách trước khi tạo video để tránh đọc trùng chương và sai số thứ tự.</p>
                  <button type="button" className="secondary" disabled={busy || active} onClick={() => void repairDuplicateChapter()}>
                    Sửa chương trùng trong dự án
                  </button>
                </div>
              )}
            <label>
              Chọn dự án truyện
              <select
                value={project?.id || ""}
                disabled={busy}
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
                    disabled={busy}
                    onClick={() =>
                      setSelected(project.chapters.map((c) => c.id))
                    }
                  >
                    Chọn tất cả
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
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
                          disabled={busy}
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
              {active && (
                <div className="notice" role="status">
                  Dự án đang có tác vụ đang chạy, chờ hoặc tạm dừng. Bạn vẫn có
                  thể chỉnh cấu hình và chọn chương cho lần chạy sau; tác vụ
                  hiện tại dùng cấu hình đã lưu.
                  <button
                    className="text-button"
                    onClick={() =>
                      progressPanel.current?.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                      })
                    }
                  >
                    Xem tác vụ / tạm dừng / hủy
                  </button>
                </div>
              )}
              <fieldset disabled={busy} className="config-fields">
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
                  {
                    <div className="inset">
                      <h3>Ảnh cho toàn bộ video</h3>
                      <p>
                        Một ảnh bạn tải lên được dùng cho tất cả cảnh và chương
                        đã chọn. Ảnh được lưu riêng theo dự án.
                      </p>
                      <label className="button">
                        <ImagePlus size={17} />
                        Ảnh dùng chung
                        <input
                          aria-label="Ảnh dùng chung"
                          disabled={active}
                          type="file"
                          accept=".png,.jpg,.jpeg,.webp"
                          hidden
                          onChange={(e) => {
                            void fallback(e.target.files?.[0]);
                            e.target.value = "";
                          }}
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
                            onClick={() => void removeSharedImage()}
                            disabled={active}
                          >
                            Xóa ảnh
                          </button>
                        </>
                      )}
                    </div>
                  }
                  <div className="inset" aria-label="Ảnh riêng từng chương">
                    <h3>Ảnh riêng cho từng video / chương</h3>
                    <p>Chọn nhiều ảnh một lần. Tên ảnh phải chứa đúng số chương (ví dụ Chuong_4.png → Chương 4). Không tự ghép theo thứ tự để tránh nhầm nội dung.</p>
                    <label className="button">
                      <ImagePlus size={17} /> Thêm ảnh hàng loạt
                      <input type="file" multiple accept=".png,.jpg,.jpeg,.webp" hidden disabled={busy || active}
                        onChange={e => { void uploadChapterImages(e.target.files); e.target.value = ""; }} />
                    </label>
                    <div style={{maxHeight: 420, overflowY: "auto", marginTop: 12}}>
                      {project.chapters.filter(c => selected.includes(c.id)).map(chapter => {
                        const image = chapter.backgroundImage || chapter.scenes.find(scene => scene.imageSource === "chapter-upload")?.image;
                        return <div key={chapter.id} className="row between" style={{padding: "8px 0", borderBottom: "1px solid #e6e6ef", gap: 10}}>
                          <div style={{minWidth: 0, flex: 1}}>
                            <strong>{chapter.title}</strong>
                            <small style={{display: "block"}}>{image ? "Đã gán ảnh riêng" : settings.fallbackImage ? "Đang dùng ảnh chung" : "Chưa có ảnh"}</small>
                          </div>
                          {image && <img src={fileURL(image)} alt={"Ảnh " + chapter.title} style={{width: 70, height: 44, objectFit: "cover", borderRadius: 6}} />}
                          <label className="button" style={{cursor: busy || active ? "not-allowed" : "pointer"}}>
                            {image ? "Đổi ảnh" : "Chọn ảnh"}
                            <input type="file" accept=".png,.jpg,.jpeg,.webp" hidden disabled={busy || active}
                              onChange={e => { void assignChapterImage(chapter.id, e.target.files?.[0]); e.target.value = ""; }} />
                          </label>
                          {image && <button type="button" disabled={busy || active} onClick={() => void removeChapterImage(chapter.id)}>Xóa</button>}
                        </div>;
                      })}
                    </div>
                  </div>
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
                      <span>
                        Tạo video riêng theo từng chương
                        <small>
                          Mỗi video chạy độc lập; video nào xong sẽ lưu ngay vào
                          Quản lý video.
                        </small>
                      </span>
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
                {project.synopsis?.trim() && (
                  <section className="card" aria-label="Video giới thiệu truyện">
                    <h2>Video giới thiệu / tóm tắt truyện</h2>
                    <p className="muted">Tạo một video độc lập từ phần tóm tắt đã lưu ({project.synopsis.length.toLocaleString("vi-VN")} ký tự). Dùng ảnh chung và giọng đọc đang chọn; không thay đổi 504 chương truyện.</p>
                    <details>
                      <summary>Xem nội dung tóm tắt</summary>
                      <p style={{ whiteSpace: "pre-wrap", maxHeight: 180, overflowY: "auto" }}>{project.synopsis}</p>
                    </details>
                    <button className="primary" type="button" disabled={busy || active || !settings.fallbackImage} onClick={() => void createSynopsisVideo()}>
                      <Clapperboard size={18} />
                      {busy ? "Đang xử lý…" : "Tạo video tóm tắt truyện"}
                    </button>
                    <small>Video sẽ được lưu trong một dự án giới thiệu riêng để không làm thay đổi thứ tự và số lượng chương gốc.</small>
                  </section>
                )}
                <YoutubePublishPanel project={project} selectedIds={selected} merged={merge} />
                <AdvancedOptions
                  settings={settings}
                  change={change}
                  onError={setError}
                />
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
                {active && (
                  <button
                    className="text-button"
                    onClick={() =>
                      progressPanel.current?.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                      })
                    }
                  >
                    Quản lý tác vụ hiện tại
                  </button>
                )}
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
