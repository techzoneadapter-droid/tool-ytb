import { spawn } from "node:child_process";
import { run } from "./process";

// Probe a REAL encoding, not just the presence of h264_nvenc in -encoders.
// A bundled FFmpeg may advertise NVENC on systems without a compatible NVIDIA GPU.
let nvencProbe: Promise<boolean> | undefined;
export async function supportsNVENC(): Promise<boolean> {
  const mode = (process.env.STORYFLOW_VIDEO_ENCODER || "auto").toLowerCase();
  if (mode === "cpu" || mode === "libx264") return false;
  nvencProbe ||= new Promise<boolean>((resolve) => {
    const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "color=c=black:s=128x72:r=1", "-frames:v", "1", "-an",
      "-c:v", "h264_nvenc", "-f", "null", "-",
    ], { windowsHide: true, stdio: "ignore" });
    let settled = false;
    const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); };
    const timer = setTimeout(() => { child.kill(); finish(false); }, 12000);
    child.once("error", () => finish(false));
    child.once("close", code => finish(code === 0));
  });
  return nvencProbe;
}

export function encodingArgs(gpu: boolean, fast = false): string[] {
  return gpu
    ? ["-c:v", "h264_nvenc", "-preset", "p3", "-cq", fast ? "27" : "24", "-b:v", "0", "-pix_fmt", "yuv420p"]
    : ["-c:v", "libx264", "-preset", fast ? "ultrafast" : "veryfast", "-crf", fast ? "24" : "23", "-pix_fmt", "yuv420p"];
}

export async function encodeWithFallback(
  makeArgs: (videoArgs: string[]) => string[],
  cwd?: string,
  progress?: { seconds: number; onProgress: (fraction: number) => void },
  fast = false,
): Promise<void> {
  if (await supportsNVENC()) {
    try {
      await run(makeArgs(encodingArgs(true, fast)), cwd, false, progress);
      return;
    } catch (error) {
      // GPU may disappear, reach an encoder-session limit, or have outdated drivers.
      // Retry this one output on CPU; never mark the video complete on NVENC failure.
      console.warn("StoryFlow: NVENC failed; retrying with libx264:", error instanceof Error ? error.message.slice(0, 400) : error);
    }
  }
  await run(makeArgs(encodingArgs(false, fast)), cwd, false, progress);
}
