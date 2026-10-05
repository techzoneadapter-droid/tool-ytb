import type { Job, Project } from "@/modules/project/types";
import { useMemo } from "react";
import { Pause, Play, RotateCcw, XCircle } from "lucide-react";
import { isActive } from "../studio-api";

function formatTime(seconds?: number) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `${Math.ceil(seconds)} giây`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} giờ ${rest} phút` : `${hours} giờ`;
}

const labels: Record<string, string> = {
  queued: "Đang chờ lượt",
  audio: "Đang tạo lời đọc",
  images: "Đang tạo hình ảnh",
  rendering: "Đang dựng video",
  paused: "Đã tạm dừng",
  error: "Có video cần chạy lại",
  cancelled: "Đã hủy",
  ready: "Tài nguyên đã sẵn sàng",
  done: "Hoàn thành",
};

export function PipelineProgress({
  jobs,
  project,
  busy,
  act,
  actMany,
}: {
  jobs: Job[];
  project: Project;
  busy: boolean;
  act: (action: string, id: string) => void;
  actMany?: (action: string, ids: string[]) => void;
}) {
  const data = useMemo(() => {
    const sorted = [...jobs].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    const focus =
      sorted.find(isActive) ||
      sorted.find((job) => ["error", "cancelled"].includes(job.status));
    if (!focus) return null;

    const batchJobs = focus.batchId
      ? sorted
          .filter((job) => job.batchId === focus.batchId)
          .sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0))
      : [focus];

    const running = batchJobs.filter((job) =>
      ["audio", "images", "rendering"].includes(job.status),
    );
    const queued = batchJobs.filter((job) => job.status === "queued");
    const paused = batchJobs.filter((job) => job.status === "paused");
    const failedJobs = batchJobs.filter((job) => job.status === "error");
    const cancelledJobs = batchJobs.filter((job) => job.status === "cancelled");
    const done = batchJobs.filter(
      (job) =>
        job.status === "done" &&
        (job.verified || !!job.outputs?.some((output) => output.verified)),
    );

    const current =
      running.find((job) => job.status === "rendering") ||
      running.find((job) => job.status === "images") ||
      running.find((job) => job.status === "audio") ||
      queued[0] ||
      paused[0] ||
      failedJobs[0] ||
      cancelledJobs[0] ||
      batchJobs[0];

    const total = Math.max(
      focus.batchTotal || 0,
      batchJobs.length,
      new Set(batchJobs.flatMap((job) => job.chapterIds)).size,
    );
    const progress = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          batchJobs.reduce(
            (sum, job) =>
              sum +
              (job.status === "done" && job.verified ? 100 : job.progress),
            0,
          ) / Math.max(1, total),
        ),
      ),
    );

    return {
      progress,
      total,
      done: done.length,
      running,
      queued,
      paused,
      failedJobs,
      cancelledJobs,
      current,
      batchJobs,
    };
  }, [jobs]);

  if (!data) return null;

  const invokeMany = (action: string, targets: Job[]) => {
    const ids = targets.map((job) => job.id);
    if (!ids.length) return;
    if (actMany) actMany(action, ids);
    else ids.forEach((id) => act(action, id));
  };

  const stoppable = [...data.running, ...data.queued];
  const resumable = data.paused;
  const retryable = [...data.failedJobs, ...data.cancelledJobs];

  return (
    <section
      className={
        "batch-progress " + (data.failedJobs.length ? "has-error" : "")
      }
    >
      <div className="batch-progress-top">
        <div className="batch-progress-copy">
          <strong>{labels[data.current.status] || "Đang xử lý"}</strong>
          <span>
            {data.current.batchIndex !== undefined
              ? `Video ${data.current.batchIndex + 1}/${data.total} · `
              : ""}
            {data.current.message}
          </span>
        </div>
        <strong className="batch-progress-percent">{data.progress}%</strong>
      </div>

      <div
        className="batch-progress-track"
        role="progressbar"
        aria-label="Tiến độ tạo video"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={data.progress}
      >
        <span style={{ width: data.progress + "%" }} />
      </div>

      {data.current.stageProgress && (
        <div className="batch-progress-live">
          <div>
            <span className="live-dot" />
            <strong>Công đoạn</strong>
            <span>
              {data.current.stageProgress.label} ·{" "}
              {Math.min(
                data.current.stageProgress.current,
                data.current.stageProgress.total,
              )}
              /{data.current.stageProgress.total}
            </span>
          </div>
          <div>
            <strong>Đang xử lý</strong>
            <span>{data.current.stageProgress.detail}</span>
          </div>
          <div>
            <strong>Hiệu suất</strong>
            <span>
              {data.current.stageProgress.concurrency
                ? `${data.current.stageProgress.concurrency} luồng`
                : "1 luồng"}
              {data.current.stageProgress.ratePerMinute
                ? ` · ${data.current.stageProgress.ratePerMinute.toFixed(1)} mục/phút`
                : ""}
              {data.current.stageProgress.elapsedSeconds
                ? ` · đã chạy ${formatTime(data.current.stageProgress.elapsedSeconds)}`
                : ""}
              {data.current.stageProgress.etaSeconds
                ? ` · còn khoảng ${formatTime(data.current.stageProgress.etaSeconds)}`
                : ""}
            </span>
          </div>
        </div>
      )}

      {project.chapters
        .filter((chapter) =>
          data.batchJobs.some((job) => job.chapterIds.includes(chapter.id)),
        )
        .map((chapter) => {
          const image =
            project.settings.imageProvider === "flow-browser"
              ? chapter.masterImage
              : chapter.apiImage;
          const chapterJobs = data.batchJobs.filter((job) =>
            job.chapterIds.includes(chapter.id),
          );
          const rendered =
            project.settings.imageProvider === "flow-browser"
              ? chapter.scenes.filter((scene) => scene.flow?.status === "done")
                  .length
              : chapterJobs.some(
                    (job) =>
                      job.verified ||
                      job.outputs?.some(
                        (output) =>
                          output.verified &&
                          output.chapterIds.includes(chapter.id),
                      ),
                  )
                ? chapter.scenes.length
                : Math.min(
                    chapter.scenes.length,
                    Math.max(
                      0,
                      ...chapterJobs.map((job) => job.counts?.rendered || 0),
                    ),
                  );
          const apiStage = chapter.apiImageProgress || chapter.apiImage?.stage;
          return (
            <div className="batch-progress-live" key={chapter.id}>
              <strong>{chapter.title}</strong>
              <span>
                Ảnh master chương:{" "}
                {image?.status === "ready"
                  ? "✓ Sẵn sàng"
                  : image?.status === "error"
                    ? "Lỗi · " + image.errorCode
                    : image
                      ? "Đang tạo ảnh master…"
                      : "Đang chờ"}
              </span>
              {project.settings.imageProvider !== "flow-browser" && (
                <>
                  <small>
                    Phân tích chương → Character Bible → tạo/dùng lại portrait →
                    tạo prompt → gọi API → lưu master image → dựng video
                  </small>
                  <span>
                    {chapterJobs.some((job) => job.status === "rendering")
                      ? "Dựng video"
                      : apiStage?.label || "Phân tích chương"}
                    {apiStage?.detail ? " · " + apiStage.detail : ""}
                  </span>
                </>
              )}
              <span>
                Dựng video: {rendered}/{chapter.scenes.length} cảnh
              </span>
              {image?.status === "error" && (
                <details>
                  <summary>Chi tiết lỗi ảnh chương</summary>
                  {image.errorMessage}
                </details>
              )}
            </div>
          );
        })}

      {data.batchJobs.some((job) => job.sceneErrors?.length) && (
        <details className="notice">
          <summary>Lỗi cảnh · các MP4 đã hoàn thành được giữ nguyên</summary>
          {data.batchJobs.flatMap((job) =>
            (job.sceneErrors || []).map((error) => (
              <p
                key={job.id + error.sceneId}
                role="alert"
                style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
              >
                {project.chapters.find((c) => c.id === error.chapterId)
                  ?.masterImage?.status === "error" ||
                error.stage === "CHAPTER_IMAGE" ||
                (error.sceneIndex === 0 &&
                  project.chapters.find((c) => c.id === error.chapterId)
                    ?.apiImage?.status === "error")
                  ? "Ảnh master chương"
                  : `Cảnh ${error.sceneIndex}`}{" "}
                · <strong>{error.code}</strong> · {error.stage}
                <br />
                {error.message}
              </p>
            )),
          )}
        </details>
      )}
      {data.failedJobs
        .filter((job) => !job.sceneErrors?.length)
        .map(
          (job) =>
            job.error && (
              <details
                key={job.id}
                role="alert"
                style={{
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  fontFamily: "inherit",
                }}
              >
                <summary>Video chưa hoàn thành · Chi tiết</summary>
                <pre>
                  {job.batchIndex !== undefined
                    ? `Video ${job.batchIndex + 1}: `
                    : ""}
                  {job.error}
                </pre>
              </details>
            ),
        )}

      <div className="batch-progress-footer">
        <div className="batch-progress-meta">
          <span>
            ✓ {data.done}/{data.total} video đã lưu
          </span>
          {data.running.length > 0 && (
            <span>{data.running.length} video đang chạy song song</span>
          )}
          {data.queued.length > 0 && (
            <span>{data.queued.length} video đang chờ</span>
          )}
          {data.paused.length > 0 && (
            <span>{data.paused.length} video tạm dừng</span>
          )}
          {data.failedJobs.length > 0 && (
            <span>{data.failedJobs.length} video lỗi riêng</span>
          )}
        </div>

        <div className="batch-progress-actions">
          {stoppable.length > 0 && (
            <>
              <button
                disabled={busy}
                onClick={() => invokeMany("pause", stoppable)}
                title="Tạm dừng toàn bộ lô; video đã hoàn thành vẫn được giữ"
              >
                <Pause size={15} />
                Tạm dừng lô
              </button>
              <button
                className="danger-outline"
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      "Hủy các video chưa hoàn thành? Video đã tạo xong vẫn nằm trong Quản lý video.",
                    )
                  )
                    invokeMany("cancel", stoppable);
                }}
              >
                <XCircle size={15} />
                Hủy phần còn lại
              </button>
            </>
          )}

          {resumable.length > 0 && !stoppable.length && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => invokeMany("resume", resumable)}
            >
              <Play size={15} />
              Tiếp tục lô
            </button>
          )}

          {retryable.length > 0 && !stoppable.length && !resumable.length && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => invokeMany("restart", retryable)}
            >
              <RotateCcw size={15} />
              Chạy lại video lỗi
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
