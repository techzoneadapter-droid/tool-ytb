import type { Job, Project } from "@/modules/project/types";
import { useEffect, useMemo, useState } from "react";
import { fileURL, isActive } from "../studio-api";

const labels: Record<string, string> = {
  queued: "Đang chờ",
  audio: "Tạo lời đọc",
  images: "Tạo hình ảnh",
  rendering: "Dựng video",
  paused: "Tạm dừng",
  error: "Cần thử lại",
  ready: "Tài nguyên đã lưu",
  done: "Hoàn thành",
};

export function PipelineProgress({
  jobs,
  project,
  busy,
  act,
}: {
  jobs: Job[];
  project: Project;
  busy: boolean;
  act: (action: string, id: string, chapterIds?: string[]) => void;
}) {
  const [now, setNow] = useState(0);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const visible = useMemo(() => {
    const sorted = [...jobs].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    const active = sorted.filter(isActive);
    if (active.length) return active.slice(0, 3);
    // Keep only the newest actionable failure on the Create page.
    // All older attempts live in Video Manager > History.
    return sorted.filter((job) => job.status === "error").slice(0, 1);
  }, [jobs]);

  const hiddenCount = Math.max(
    0,
    jobs.filter(isActive).length - visible.filter(isActive).length,
  );

  if (!visible.length) return null;

  return (
    <div className="job-list">
      {visible.map((job) => {
        const scenes = project.chapters
          .filter((chapter) => job.chapterIds.includes(chapter.id))
          .flatMap((chapter) => chapter.scenes);
        const motion = scenes.filter(
          (scene) =>
            job.snapshot.settings.motionMode === "all" ||
            (job.snapshot.settings.motionMode === "selected" &&
              scene.motionSelected),
        );
        return (
          <section className="card progress-card" key={job.id}>
            <div className="row between">
              <h2>{labels[job.status] || job.status}</h2>
              <strong>{job.progress}%</strong>
            </div>
            <p>
              {job.chapterIds.length === 1
                ? project.chapters.find((chapter) => chapter.id === job.chapterIds[0])
                    ?.title
                : `${job.chapterIds.length} chương`}
            </p>
            <progress max={100} value={job.progress} />
            {job.startedAt && now > 0 && (
              <p className="muted">
                Thời gian từ khi bắt đầu:{" "}
                {Math.max(
                  0,
                  Math.floor(
                    ((job.finishedAt ? Date.parse(job.finishedAt) : now) -
                      Date.parse(job.startedAt)) /
                      60000,
                  ),
                )}{" "}
                phút
              </p>
            )}
            <div className="progress-steps">
              <span>✓ Chuẩn bị dự án</span>
              <span>
                Lời đọc{" "}
                <b>
                  {job.snapshot.settings.audioEnabled === false
                    ? "Dùng lời đọc có sẵn"
                    : `${job.counts?.audio ?? 0} / ${job.counts?.total ?? scenes.length}`}
                </b>
              </span>
              <span>
                Ảnh minh họa{" "}
                <b>
                  {job.snapshot.settings.imageEnabled === false
                    ? job.snapshot.settings.fallbackImage
                      ? job.counts?.image === scenes.length
                        ? "✓ Dùng ảnh chung"
                        : "Kiểm tra ảnh chung"
                      : "Dùng ảnh có sẵn"
                    : `${job.counts?.image ?? 0} / ${scenes.length}`}
                </b>
              </span>
              {motion.length > 0 && (
                <span>
                  Ảnh động{" "}
                  <b>
                    {job.counts?.motion ?? 0} / {motion.length}
                  </b>
                </span>
              )}
              <span>
                Phụ đề{" "}
                <b>
                  {!job.snapshot.settings.burnSubtitles
                    ? "Tắt"
                    : job.subtitlesReady
                      ? "✓"
                      : "Đang chờ"}
                </b>
              </span>
              <span>
                Dựng video{" "}
                <b>
                  {job.status === "rendering" ? "Đang xử lý" : "Đang chờ"}
                </b>
              </span>
            </div>
            <p className="muted">{job.message.replace("FFmpeg", "Ứng dụng")}</p>

            {job.error && (
              <div className="notice error" role="alert">
                {job.counts?.failed
                  ? `${job.counts.failed} tài nguyên chưa tạo được.`
                  : "Chưa hoàn thành video."}{" "}
                Tài nguyên hợp lệ đã được giữ lại.
                <details>
                  <summary>Chi tiết</summary>
                  <pre>{job.error}</pre>
                </details>
              </div>
            )}

            <div className="row">
              {job.status === "error" && (
                <button disabled={busy} onClick={() => act("retry", job.id)}>
                  Thử lại phần lỗi
                </button>
              )}
              {job.status === "paused" && (
                <button disabled={busy} onClick={() => act("resume", job.id)}>
                  Tiếp tục
                </button>
              )}
              {isActive(job) && job.status !== "paused" && (
                <button disabled={busy} onClick={() => act("pause", job.id)}>
                  Tạm dừng
                </button>
              )}
            </div>

            {job.status === "paused" && job.snapshot.settings.humanCheck && (
              <details>
                <summary>Duyệt tài nguyên</summary>
                <div className="review-list">
                  {scenes.map((scene, index) => (
                    <div key={scene.id}>
                      <p>
                        Cảnh {index + 1}: {scene.text}
                      </p>
                      {scene.image && (
                        <img
                          alt={"Minh họa cảnh " + (index + 1)}
                          src={fileURL(scene.image)}
                        />
                      )}
                      {scene.audio && <audio controls src={fileURL(scene.audio)} />}
                    </div>
                  ))}
                </div>
                <button
                  disabled={busy}
                  onClick={() => act("approve", job.id, job.chapterIds)}
                >
                  Duyệt tài nguyên đã xem
                </button>
              </details>
            )}
          </section>
        );
      })}

      {hiddenCount > 0 && (
        <p className="muted compact-job-note">
          + {hiddenCount} tác vụ đang chạy khác. Xem đầy đủ trong Quản lý video.
        </p>
      )}
    </div>
  );
}
