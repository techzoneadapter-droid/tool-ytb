import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Project, Job } from "./types";
export const root = path.resolve("data");
mkdirSync(root, { recursive: true });
const db = new DatabaseSync(path.join(root, "storyflow.sqlite"));
db.exec(
  "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL)",
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
export function claim(): Job | undefined {
  db.exec("BEGIN IMMEDIATE");
  try {
    const job = list<Job>("job")
      .reverse()
      .find((j) => j.status === "queued");
    if (job) {
      job.status = "audio";
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
