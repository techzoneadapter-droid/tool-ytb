import path from "node:path";
import os from "node:os";
import { constants } from "node:fs";
import { copyFile, link, mkdir, stat } from "node:fs/promises";
import type { VideoRecord } from "../project/types";

/**
 * The library stores UUID-like *basenames*, never absolute MP4 paths.
 * After moving to another PC the SQLite rows may survive while data/assets does not.
 * Restore a missing filename from known local workspaces without rewriting SQLite.
 * Hard links avoid doubling storage when both locations are on the same NTFS volume.
 */
type VideoFiles = Pick<VideoRecord, "output" | "srt" | "vtt" | "fileSize">;
export type MediaRecoveryReport = {
  videosRestored: number;
  filesRestored: number;
  videosMissing: number;
  foldersChecked: string[];
  errors: string[];
};
const safeAsset = /^[a-f0-9-]+\.(mp4|srt|vtt)$/i;

function candidates(input: string): string[] {
  const value = path.resolve(input);
  return [
    value,
    path.join(value, "assets"),
    path.join(value, "data", "assets"),
    path.join(value, "workspace", "data", "assets"),
  ];
}
export function defaultRecoveryRoots(dataRoot: string): string[] {
  const workspace = path.dirname(dataRoot);
  const userData = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "StoryFlow");
  return [
    workspace,
    path.dirname(workspace),
    path.join(userData, "workspace"),
    // Older users often copied drive E/F into folders on the new D drive.
    "D:\\ổ E\\YTB",
    "D:\\ổ F\\YTB",
    "D:\\ổ D\\YTB",
    "E:\\YTB",
    "F:\\YTB",
    ...(process.env.STORYFLOW_MEDIA_RECOVERY_ROOTS || "").split(path.delimiter).filter(Boolean),
  ];
}
async function safeStat(file: string) {
  try {
    const info = await stat(file);
    return info.isFile() && info.size > 0 ? info : undefined;
  } catch { return undefined; }
}
export async function restoreMissingVideoFiles(
  records: VideoFiles[],
  destination: string,
  searchRoots: string[],
): Promise<MediaRecoveryReport> {
  const report: MediaRecoveryReport = { videosRestored: 0, filesRestored: 0, videosMissing: 0, foldersChecked: [], errors: [] };
  const dirs = [...new Set(searchRoots.flatMap(candidates).map(p => path.resolve(p)))];
  const targetDir = path.resolve(destination);
  const sources: string[] = [];
  for (const dir of dirs) {
    if (dir === targetDir) continue;
    try {
      if ((await stat(dir)).isDirectory()) sources.push(dir);
    } catch { /* Old drive may not be mounted. */ }
  }
  report.foldersChecked = sources;
  await mkdir(targetDir, { recursive: true });
  const needed = new Map<string, number | undefined>();
  for (const item of records) {
    if (item.output && safeAsset.test(item.output) && item.output.toLowerCase().endsWith(".mp4")) {
      needed.set(item.output, item.fileSize || undefined);
      for (const sidecar of [item.srt, item.vtt])
        if (sidecar && safeAsset.test(sidecar) && !needed.has(sidecar)) needed.set(sidecar, undefined);
    }
  }
  const restored = new Set<string>();
  for (const [name, expectedSize] of needed) {
    const target = path.join(targetDir, name);
    if (await safeStat(target)) continue;
    for (const dir of sources) {
      const source = path.join(dir, name);
      const info = await safeStat(source);
      if (!info || (expectedSize && info.size !== expectedSize)) continue;
      try {
        // Never replace a destination that appeared during recovery.
        try { await link(source, target); }
        catch (e) {
          const err = e as NodeJS.ErrnoException;
          if (err.code === "EEXIST") break;
          if (err.code !== "EXDEV" && err.code !== "EPERM" && err.code !== "ENOTSUP")
            throw e;
          await copyFile(source, target, constants.COPYFILE_EXCL);
        }
        restored.add(name);
        report.filesRestored++;
        break;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "EEXIST") break;
        report.errors.push(`${name}: ${err.message}`);
      }
    }
  }
  for (const record of records) {
    if (!record.output || !safeAsset.test(record.output)) continue;
    if (restored.has(record.output)) report.videosRestored++;
    if (!(await safeStat(path.join(targetDir, record.output)))) report.videosMissing++;
  }
  return report;
}
