// Explicit migration, never executed at application startup.
import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
const root = path.resolve("data");
const db = new DatabaseSync(path.join(root, "storyflow.sqlite"));
db.exec("PRAGMA busy_timeout=5000");
const rows = db
  .prepare("SELECT id,kind,body FROM records")
  .all()
  .map((r) => ({ ...r, value: JSON.parse(r.body) }));
const jobs = rows.filter(
  (r) => r.kind === "job" && r.value.snapshot?.settings?.provider === "mock",
);
if (
  jobs.some(
    (r) => !["done", "error", "ready", "paused"].includes(r.value.status),
  )
)
  throw Error("Có tác vụ đang chạy; dừng tiến trình cũ trước khi dọn.");
const files = new Set();
const work = new Set();
const updates = [];
for (const row of jobs) {
  for (const field of ["output", "srt", "vtt"])
    if (row.value[field]) files.add(row.value[field]);
  if (row.value.output) work.add(path.parse(row.value.output).name);
}
for (const row of rows.filter((r) => r.kind === "project")) {
  const p = row.value;
  if (p.settings.provider !== "mock") continue;
  for (const c of p.chapters)
    for (const s of c.scenes) {
      if (s.audio && !s.audioSource) {
        files.add(s.audio);
        delete s.audio;
        delete s.audioStatus;
        s.approved = false;
      }
      if (s.image && !s.imageSource) {
        const file = path.join(root, "assets", s.image);
        if (existsSync(file)) {
          const stats = await sharp(file).stats();
          if (stats.channels.every((c) => c.stdev < 0.01)) {
            files.add(s.image);
            delete s.image;
            delete s.imageStatus;
            s.approved = false;
          } else {
            s.imageSource = "upload";
            s.imageStatus = "done";
          }
        } else delete s.image;
      }
    }
  p.settings.provider = "openai";
  updates.push(p);
}
const keep = new Set();
for (const row of rows.filter((r) => r.kind === "project")) {
  const p = updates.find((p) => p.id === row.id) || row.value;
  for (const c of p.chapters)
    for (const s of c.scenes)
      for (const f of [s.audio, s.image]) if (f) keep.add(f);
  for (const f of [
    p.settings.logo,
    p.settings.intro,
    p.settings.outro,
    p.settings.music,
  ])
    if (f) keep.add(f);
}
db.exec("BEGIN IMMEDIATE");
try {
  for (const p of updates)
    db.prepare("UPDATE records SET body=? WHERE kind='project' AND id=?").run(
      JSON.stringify(p),
      p.id,
    );
  for (const j of jobs)
    db.prepare("DELETE FROM records WHERE kind='job' AND id=?").run(j.id);
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
} finally {
  db.close();
}
let removed = 0;
for (const name of files) {
  if (keep.has(name) || !/^[a-f0-9-]+\.(mp4|wav|mp3|png|srt|vtt)$/.test(name))
    continue;
  const target = path.resolve(root, "assets", name);
  if (!target.startsWith(path.join(root, "assets") + path.sep))
    throw Error("Unsafe path");
  rmSync(target, { force: true });
  removed++;
}
for (const id of work) {
  if (!/^[a-f0-9-]+$/.test(id)) continue;
  const target = path.resolve(root, "work", id);
  if (!target.startsWith(path.join(root, "work") + path.sep))
    throw Error("Unsafe path");
  rmSync(target, { force: true, recursive: true });
}
console.log(
  JSON.stringify({
    preservedProjects: updates.length,
    removedMockJobs: jobs.length,
    removedFiles: removed,
    removedWorkDirectories: work.size,
  }),
);
