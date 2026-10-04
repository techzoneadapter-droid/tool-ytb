import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export type ChromeProfile = { id: string; name: string; email: string };
const selectionFile = path.resolve("data/flow-profile-selection.json");
export function chromeUserDataDir() {
  return process.env.FLOW_CHROME_USER_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Google", "Chrome", "User Data");
}
export async function listChromeProfiles() {
  let profiles: ChromeProfile[] = [];
  try {
    const root = chromeUserDataDir();
    const local = JSON.parse(await readFile(path.join(root, "Local State"), "utf8"));
    const dirs = new Set((await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name));
    profiles = Object.entries(local.profile?.info_cache || {}).filter(([id]) => /^(Default|Profile \d+)$/.test(id) && dirs.has(id)).map(([id, value]) => {
      const info = value as { name?: string; user_name?: string };
      return { id, name: info.name || id, email: info.user_name || "" };
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("Không đọc được profile Chrome. Kiểm tra FLOW_CHROME_USER_DATA_DIR.");
  }
  let selectedProfile = "";
  let selectedTab = "";
  try {
    const selection = JSON.parse(await readFile(selectionFile, "utf8"));
    selectedProfile = selection.profileId || "";
    selectedTab = selection.tabId || "";
  } catch {}
  return { profiles, selectedTab, selectedProfile: profiles.some(p => p.id === selectedProfile) ? selectedProfile : "" };
}
export async function saveFlowSelection(profileId: string, tabId: string) {
  const { profiles } = await listChromeProfiles();
  if (!profiles.some(profile => profile.id === profileId)) throw Error("Hãy chọn profile Chrome hợp lệ.");
  await mkdir(path.dirname(selectionFile), { recursive: true });
  await writeFile(selectionFile, JSON.stringify({ profileId, tabId }));
}
