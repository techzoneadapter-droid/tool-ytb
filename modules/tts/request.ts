import type { TTSRequestProgress } from "../project/types";
import { TTSError, safeTTSErrorBody } from "./errors";

export type TTSRequestOptions = {
  sceneId?: string;
  chapterId?: string;
  onRequestProgress?: (event: TTSRequestProgress) => void;
  acquire?: (onWait: (limit: number) => void) => Promise<() => void>;
};
export async function fetchTTSChunk(
  url: string,
  payload: object,
  voice: string,
  text: string,
  chunkIndex: number,
  totalChunks: number,
  options: TTSRequestOptions = {},
) {
  const timeoutMs = Math.max(
    1,
    Number(process.env.TTS_REQUEST_TIMEOUT_MS) || 120000,
  );
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    let startedAt = new Date().toISOString(),
      lastProgressAt = startedAt;
    let engineLimit: number | undefined;
    let httpStatus: number | undefined;
    let timedOut = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let release: (() => void) | undefined;
    const emit = (
      state: TTSRequestProgress["state"],
      detail?: string,
      limit?: number,
    ) => {
      if (limit !== undefined) engineLimit = limit;
      options.onRequestProgress?.({
        provider: "VieNeu Local",
        voice,
        sceneId: options.sceneId,
        chapterId: options.chapterId,
        chunkIndex,
        totalChunks,
        textLength: text.length,
        attempt,
        startedAt,
        lastProgressAt,
        timeoutMs,
        state,
        detail: detail ? safeTTSErrorBody(detail) : undefined,
        engineLimit,
      });
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    };
    try {
      release = await options.acquire?.((limit) =>
        emit("waiting", "Đang chờ lượt VieNeu", limit),
      );
      startedAt = lastProgressAt = new Date().toISOString();
      emit("running");
      arm();
      heartbeat = setInterval(
        () =>
          emit(
            "running",
            Date.now() - Date.parse(lastProgressAt) > 30000
              ? "VieNeu đang xử lý..."
              : undefined,
          ),
        1000,
      );
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: controller.signal,
      });
      const buffers: Uint8Array[] = [];
      httpStatus = response.status;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            if (result.value.length) {
              buffers.push(result.value);
              lastProgressAt = new Date().toISOString();
              arm();
              emit("running");
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      const bytes = Buffer.concat(buffers);
      if (!response.ok)
        throw new TTSError(
          "VieNeu Local",
          voice,
          text.length,
          chunkIndex,
          totalChunks,
          safeTTSErrorBody(bytes.toString()),
          response.status,
        );
      if (
        bytes.toString("ascii", 0, 4) !== "RIFF" ||
        bytes.toString("ascii", 8, 12) !== "WAVE"
      )
        throw Error("Không trả về WAV hợp lệ");
      emit("done");
      return bytes;
    } catch (error) {
      const status = error instanceof TTSError ? error.status : httpStatus;
      const cause = timedOut
        ? `TTS_REQUEST_TIMEOUT: Timeout sau ${timeoutMs / 1000} giây`
        : error instanceof Error
          ? error.message
          : String(error);
      if (
        attempt === 3 ||
        (!timedOut && status !== undefined && status !== 429 && status < 500)
      ) {
        emit("error", cause);
        throw new TTSError(
          "VieNeu Local",
          voice,
          text.length,
          chunkIndex,
          totalChunks,
          `chapter=${options.chapterId || "unknown"} scene=${options.sceneId || "unknown"} ${cause}`,
          status,
        );
      }
      emit("retry", `${cause} · Đang thử lại ${attempt + 1}/3`);
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      controller.abort();
      release?.();
    }
    const delays = (process.env.TTS_RETRY_BACKOFF_MS || "1000,3000")
      .split(",")
      .map(Number);
    await new Promise((resolve) =>
      setTimeout(resolve, delays[attempt - 1] || 1),
    );
  }
  throw Error("TTS_ERROR: hết lượt thử");
}
