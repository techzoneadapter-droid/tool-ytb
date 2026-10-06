import { spawn } from "node:child_process";
import { ffmpegConcurrency, withResource } from "../pipeline/resources";
export function run(
  args: string[], cwd?: string, probe = false,
  progress?: { seconds: number; onProgress: (fraction: number) => void },
  inputBuffer?: Buffer,
): Promise<string> {
  const action = () => runProcess(args, cwd, probe, progress, inputBuffer);
  return probe ? action() : withResource("FFmpeg", ffmpegConcurrency, action);
}
function runProcess(
  args: string[],
  cwd?: string,
  probe = false,
  progress?: { seconds: number; onProgress: (fraction: number) => void },
  inputBuffer?: Buffer,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      probe
        ? process.env.FFPROBE_PATH || "ffprobe"
        : process.env.FFMPEG_PATH || "ffmpeg",
      progress ? ["-progress", "pipe:1", "-nostats", ...args] : args,
      { cwd, windowsHide: true },
    );
    let output = "";
    let pending = "";
    p.stdout.on("data", (d) => {
      output = (output + d).slice(-12000);
      if (progress) {
        pending += String(d);
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        for (const line of lines) {
          const match = /^out_time_us=(\d+)/.exec(line);
          if (match)
            try {
              progress.onProgress(
                Math.min(0.99, Number(match[1]) / 1000000 / progress.seconds),
              );
            } catch (e) {
              p.kill();
              reject(e);
            }
        }
      }
    });
    p.stderr.on("data", (d) => {
      output = (output + d).slice(-12000);
    });
    p.on("error", reject);
    // The still image is written once, directly to FFmpeg. No image temp file.
    p.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET") {
        p.kill();
        reject(error);
      }
    });
    p.stdin.end(inputBuffer);
    p.on("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(Error(`FFmpeg (${code}): ${output.slice(-2000)}`)),
    );
  });
}
export async function verifyVideo(file: string, requireAudio = true) {
  const data = JSON.parse(
    await run(
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
      undefined,
      true,
    ),
  );
  if (
    !data.streams?.some(
      (s: { codec_type: string }) => s.codec_type === "video",
    ) ||
    (requireAudio &&
      !data.streams?.some(
        (s: { codec_type: string }) => s.codec_type === "audio",
      )) ||
    !(Number(data.format?.duration) > 0)
  )
    throw Error("MP4 không có luồng hình/âm thanh hoặc thời lượng hợp lệ.");
  return data;
}
export async function duration(file: string) {
  return Number(
    (
      await run(
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          file,
        ],
        undefined,
        true,
      )
    ).trim(),
  );
}
