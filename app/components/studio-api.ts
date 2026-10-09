import type { Project, Job, Settings } from "@/modules/project/types";
import type { providerStatus } from "@/modules/providers/config";
import { defaults } from "@/modules/project/types";
export type StudioData = {
  projects: Project[];
  jobs: Job[];
  providers?: Awaited<ReturnType<typeof providerStatus>>;
};
export const initialSettings: Settings = {
  ...defaults,
  ttsProvider: "vieneu-local",
  voice: "ngoc_huyen",
  imageProvider: "aihorde",
  imageEnabled: false,
  audioEnabled: true,
  motionMode: "off",
};
export async function request<T = unknown>(
  body: object,
  endpoint = "/api/studio",
): Promise<T> {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok || data.ok === false)
    throw Error(data.error || data.message || "Không thực hiện được yêu cầu.");
  return data;
}
export async function upload(
  file: File,
): Promise<{ text?: string; asset?: string }> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch("/api/upload", { method: "POST", body: form });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "Không tải được tệp.");
  return data;
}
export const fileURL = (file?: string) => (file ? "/api/files/" + file : "");
export const isActive = (job: Job) =>
  ["queued", "audio", "images", "rendering", "paused"].includes(job.status);
