import { codePath } from "../project/code-path";
import { spawn } from "node:child_process";
import { access, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { Settings } from "../project/types";
import { duration } from "../videoRender/process";

export const edgeVoices = [
  {
    id: "vi-VN-HoaiMyNeural",
    name: "Hoài My",
    gender: "Nữ",
    description: "Microsoft Edge Read Aloud · tiếng Việt · không cần API key",
    categories: ["Kể chuyện", "Review", "Nhanh"],
  },
  {
    id: "vi-VN-NamMinhNeural",
    name: "Nam Minh",
    gender: "Nam",
    description: "Microsoft Edge Read Aloud · tiếng Việt · không cần API key",
    categories: ["Kể chuyện", "Review", "Nhanh"],
  },
] as const;

export function hasEdgeVoice(id: string) {
  return edgeVoices.some((voice) => voice.id === id);
}

function percent(value: number) {
  const rounded = Math.round(value);
  return rounded > 0 ? "+" + rounded + "%" : rounded + "%";
}

async function runEdge(
  text: string,
  file: string,
  settings: Settings,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const rate = percent((settings.speed - 1) * 100);
  const pitch = percent(settings.pitch * 6);
  const volume = percent((settings.volume - 1) * 100);
  const args = [
    codePath("node_modules/node-edge-tts/bin.js"),
    "-t",
    text,
    "-f",
    file,
    "-v",
    settings.voice,
    "-l",
    "vi-VN",
    "-r",
    rate,
    "--pitch",
    pitch,
    "--volume",
    volume,
    "--timeout",
    "30000",
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        Error(
          "Edge TTS quá thời gian. Kiểm tra kết nối mạng hoặc đổi engine giọng.",
        ),
      );
    }, 120000);
    child.stderr?.on("data", (chunk) => {
      error += String(chunk);
      if (error.length > 3000) error = error.slice(-3000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          Error(
            "Edge TTS không tạo được audio." +
              (error.trim() ? " " + error.trim() : ""),
          ),
        );
    });
  });
}

export async function speakEdge(
  text: string,
  file: string,
  settings: Settings,
) {
  try {
    await runEdge(text, file, settings);
    await access(file);
    const seconds = await duration(file);
    if (!(seconds > 0)) throw Error("Edge TTS trả file audio không hợp lệ.");
    return seconds;
  } catch (error) {
    await unlink(file).catch(() => {});
    throw error;
  }
}
