export function safeTTSErrorBody(body: string) {
  let message = body;
  try {
    const data = JSON.parse(body);
    message =
      typeof data.error?.message === "string"
        ? data.error.message
        : typeof data.detail === "string"
          ? data.detail
          : JSON.stringify(data.detail || data.error || data);
  } catch {
    /* Non-JSON local errors are bounded and scrubbed below. */
  }
  for (const [name, value] of Object.entries(process.env))
    if (
      /key|token|secret|password|cookie|authorization/i.test(name) &&
      value &&
      value.length >= 4
    )
      message = message.split(value).join("[redacted]");
  return message
    .replace(/(?:Bearer\s+)[^\s"<>]+/gi, "Bearer [redacted]")
    .replace(
      /((?:api[_-]?key|token|secret|password|cookie|authorization)["']?\s*[:=]\s*["']?)[^\s,"'<>]+/gi,
      "$1[redacted]",
    )
    .slice(0, 1200);
}
export class TTSError extends Error {
  constructor(
    provider: string,
    voice: string,
    textLength: number,
    chunkIndex: number,
    chunkTotal: number,
    cause: string,
    public status?: number,
  ) {
    super(
      `TTS_ERROR: ${provider} · voice=${voice} · textLength=${textLength} · chunk=${chunkIndex}/${chunkTotal}${status ? ` · HTTP ${status}` : ""} · ${safeTTSErrorBody(cause)}`,
    );
  }
}
