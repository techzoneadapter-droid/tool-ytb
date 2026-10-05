import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Project, Job, VideoRecord } from "./types";
export const root = path.resolve("data");
mkdirSync(root, { recursive: true });
const db = new DatabaseSync(path.join(root, "storyflow.sqlite"));
db.exec(
  "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL)",
);
export function list<T>(kind: string): T[] {
  return (
    db
      .prepare("SELECT body FROM records WHERE kind=? ORDER BY rowid DESC")
      .all(kind) as { body: string }[]
  ).map((r) => JSON.parse(r.body));
}
export function get<T>(id: string, kind: string): T {
  const r = db
    .prepare("SELECT body FROM records WHERE id=? AND kind=?")
    .get(id, kind) as { body: string } | undefined;
  if (!r) throw Error("Không tìm thấy dữ liệu.");
  return JSON.parse(r.body);
}
export function put(
  kind: string,
  item: Project | Job | { id: string; [key: string]: unknown },
) {
  db.prepare(
    "INSERT INTO records VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
  ).run(item.id, kind, JSON.stringify(item));
  return item;
}
export function remove(kind: string, id: string) {
  db.prepare("DELETE FROM records WHERE id=? AND kind=?").run(id, kind);
}
export function updateJob(id: string, patch: Partial<Job>) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const job = get<Job>(id, "job");
    Object.assign(job, patch);
    put("job", job);
    db.exec("COMMIT");
    return job;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function mergeProjectChapters(source: Project, chapterIds: string[]) {
  const wanted = new Set(chapterIds);
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = get<Project>(source.id, "project");
    const replacements = new Map(
      source.chapters
        .filter((chapter) => wanted.has(chapter.id))
        .map((chapter) => [chapter.id, chapter]),
    );
    current.characterBible ||= source.characterBible;
    if (current.characterBible && source.characterBible) {
      for (const incoming of source.characterBible.characters) {
        const existing = current.characterBible.characters.find(
          (character) => character.characterId === incoming.characterId,
        );
        if (!existing) current.characterBible.characters.push(incoming);
        else {
          for (const key of [
            "hairColor",
            "skinColor",
            "accessories",
            "vibe",
            "normalizedDescription",
            "normalizedPrompt",
            "primary",
          ] as const) {
            if (existing[key] === undefined)
              Object.assign(existing, { [key]: incoming[key] });
          }
          if (
            incoming.portrait &&
            (!existing.portrait ||
              incoming.portrait.createdAt >= existing.portrait.createdAt)
          )
            existing.portrait = incoming.portrait;
        }
      }
      current.characterBible.visualStyle ||= source.characterBible.visualStyle;
    }
    current.chapters = current.chapters.map(
      (chapter) => replacements.get(chapter.id) || chapter,
    );
    put("project", current);
    db.exec("COMMIT");
    return current;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function claim(): Job | undefined {
  db.exec("BEGIN IMMEDIATE");
  try {
    const job = list<Job>("job")
      .reverse()
      .find((j) => j.status === "queued");
    if (job) {
      job.status = "audio";
      job.startedAt ||= new Date().toISOString();
      job.finishedAt = undefined;
      job.message = "Bắt đầu xử lý";
      put("job", job);
    }
    db.exec("COMMIT");
    return job;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Delete project/job records only. Media files can be shared by caches and are not removed here.
export function removeProjects(ids: string[]) {
  const wanted = new Set(ids);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const id of wanted) get<Project>(id, "project");
    const blocked = new Set(
      list<Job>("job")
        .filter(
          (job) =>
            wanted.has(job.projectId) &&
            ["queued", "audio", "images", "rendering", "paused"].includes(
              job.status,
            ),
        )
        .map((job) => job.projectId),
    );
    if (blocked.size)
      throw Error(
        `Không thể xóa ${blocked.size} dự án vì đang có tác vụ chạy. Hãy hủy hoặc chờ tác vụ hoàn thành.`,
      );
    const videos = list<VideoRecord>("video").filter((video) =>
      wanted.has(video.projectId),
    );
    for (const id of wanted) {
      db.prepare(
        "DELETE FROM records WHERE json_extract(body, '$.projectId')=?",
      ).run(id);
      remove("project", id);
    }
    db.exec("COMMIT");
    return { deleted: wanted.size, videos };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function removeProject(id: string) {
  return removeProjects([id]);
}

export function deleteVideoRecords(ids: string[]) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const videos = [...new Set(ids)].map((id) => get<VideoRecord>(id, "video"));
    for (const video of videos) remove("video", video.id);
    // A deleted legacy video must not reappear on the next GET migration.
    const retainedJobs = new Set(
      list<VideoRecord>("video").map((video) => video.sourceJobId),
    );
    for (const id of new Set(
      videos.map((video) => video.sourceJobId).filter(Boolean),
    )) {
      if (retainedJobs.has(id)) continue;
      const job = list<Job>("job").find((job) => job.id === id);
      if (job) put("job", { ...job, videoLibraryDeleted: true });
    }
    db.exec("COMMIT");
    return videos;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
