import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { base } from "./verification.mjs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
const projectId = process.argv[2];
if (!projectId) throw Error("Pass the live shared-image project ID");
const db = new DatabaseSync(path.resolve("data/storyflow.sqlite"));
db.exec("PRAGMA busy_timeout=5000");
const project = JSON.parse(db.prepare("SELECT body FROM records WHERE kind='project' AND id=?").get(projectId).body);
assert.ok(project.name.startsWith("[TEST shared VieNeu"), "Only owned smoke fixtures may be staged for UI verification");
const job = db.prepare("SELECT id,body FROM records WHERE kind='job' AND json_extract(body,'$.projectId')=? ORDER BY rowid DESC").get(projectId);
const snapshot = JSON.parse(job.body);
// A completed pipeline hides its progress panel. Temporarily stage its owned fixture as paused, then restore it.
if (snapshot.status === "done") db.prepare("UPDATE records SET body=? WHERE id=?").run(JSON.stringify({...snapshot, status:"paused", stageProgress:undefined}),job.id);
const browser = await chromium.launch({channel: "chrome", headless: true});
try {
  const page = await browser.newPage();
  await page.addInitScript(id => localStorage.setItem("storyflow-project", id), projectId);
  await page.goto(base);
  await page.getByRole("button", {name: "Tạo video", exact: true}).click();
  await page.getByLabel("Chọn dự án truyện").selectOption(projectId);
  const panel = page.locator(".batch-progress");
  await expect(panel).toContainText("Ảnh: ✓ Dùng ảnh chung");
  const text = await panel.innerText();
  for (const forbidden of ["Ảnh master chương", "Phân tích chương", "Character Bible", "portrait", "gọi API"]) assert.ok(!text.includes(forbidden), forbidden);
  console.log("shared-image progress browser PASS");
} finally {
  await browser.close();
  if (snapshot.status === "done") db.prepare("UPDATE records SET body=? WHERE id=?").run(job.body,job.id);
  db.close();
}
