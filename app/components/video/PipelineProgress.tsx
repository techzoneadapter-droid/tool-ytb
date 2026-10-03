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
  queued: "Đang chuẩn bị",
  audio: "Đang tạo lời đọc",
  images: "Đang tạo hình ảnh",
  rendering: "Đang dựng video",
  paused: "Đã tạm dừng",
  error: "Có lỗi cần xử lý",
  cancelled: "Đã hủy",
  ready: "Tài nguyên đã sẵn sàng",
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
  act: (action: string, id: string) => void;
}) {
  const data = useMemo(() => {
    const sorted = [...jobs].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    const active = sorted.filter(isActive);
    const visible = active.length
      ? active
      : sorted
          .filter((job) => ["error", "cancelled"].includes(job.status))
          .slice(0, 1);

    if (!visible.length) return null;

    const weight = visible.reduce(
      (sum, job) => sum + Math.max(1, job.chapterIds.length),
      0,
    );
    const progress = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          visible.reduce(
            (sum, job) =>
              sum + job.progress * Math.max(1, job.chapterIds.length),
            0,
          ) / Math.max(1, weight),
        ),
      ),
    );
    const chapterIds = new Set(visible.flatMap((job) => job.chapterIds));
    const rendered = visible.reduce(
      (sum, job) =>
        sum +
        (job.outputs?.length ||
          job.counts?.rendered ||
          (job.status === "done" && job.verified ? job.chapterIds.length : 0)),
      0,
    );
    const current =
      visible.find((job) => ["rendering", "images", "audio"].includes(job.status)) ||
      visible[0];
    const failed = visible.filter((job) => job.status === "error").length;
    const cancelled = visible.filter((job) => job.status === "cancelled").length;

    return {
      progress,
      chapters: chapterIds.size,
      rendered,
      current,
      failed,
      cancelled,
      activeCount: active.length,
    };
  }, [jobs]);

  if (!data) return null;

  return (
    <section className={"batch-progress " + (data.failed ? "has-error" : "")}>
      <div className="batch-progress-top">
        <div className="batch-progress-copy">
          <strong>{labels[data.current.status] || "Đang xử lý"}</strong>
          <span>{data.current.message}</span>
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

      <div className="batch-progress-footer">
        <div className="batch-progress-meta">
          <span>{data.chapters} chương trong lô</span>
          <span>{data.rendered}/{data.chapters} video hoàn thành</span>
          {data.activeCount > 1 && <span>{data.activeCount} tác vụ đang xử lý</span>}
          {data.failed > 0 && <span>{data.failed} tác vụ lỗi</span>}
          {data.cancelled > 0 && <span>{data.cancelled} tác vụ đã hủy</span>}
        </div>

        <div className="batch-progress-actions">
          {["queued", "audio", "images", "rendering"].includes(
            data.current.status,
          ) && (
            <>
              <button
                disabled={busy}
                onClick={() => act("pause", data.current.id)}
                title="Tạm dừng sau bước đang xử lý"
              >
                <Pause size={15} />
                Tạm dừng
              </button>
              <button
                className="danger-outline"
                disabled={busy}
                onClick={() => {
                  if (confirm("Hủy tác vụ đang chạy? Tài nguyên hợp lệ đã tạo sẽ vẫn được giữ lại."))
                    act("cancel", data.current.id);
                }}
              >
                <XCircle size={15} />
                Hủy
              </button>
            </>
          )}

          {data.current.status === "paused" && (
            <>
              <button
                className="primary"
                disabled={busy}
                onClick={() => act("resume", data.current.id)}
              >
                <Play size={15} />
                Tiếp tục
              </button>
              <button
                className="danger-outline"
                disabled={busy}
                onClick={() => {
                  if (confirm("Hủy hẳn tác vụ đang tạm dừng?"))
                    act("cancel", data.current.id);
                }}
              >
                <XCircle size={15} />
                Hủy
              </button>
            </>
          )}

          {["error", "cancelled"].includes(data.current.status) && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => act("restart", data.current.id)}
            >
              <RotateCcw size={15} />
              Chạy lại
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
