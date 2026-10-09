import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST as studio } from "../../app/api/studio/route";
import { POST as upload } from "../../app/api/upload/route";
import { get } from "../../modules/project/store";
import type { Project } from "../../modules/project/types";

async function request(body: object) {
  const response = await studio(
    new NextRequest("http://localhost/api/studio", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result).slice(0, 500));
  return result;
}

async function main() {
  const text = "Một câu chuyện dài. ".repeat(110000).trim();
  assert.ok(text.length > 2000000);
  const preview = await request({
    action: "previewChapters",
    text,
    splitChapters: false,
  });
  assert.equal(preview.length, 1);
  const project = await request({
    action: "create",
    name: "Truyện dài",
    text,
    splitChapters: false,
  });
  assert.equal(project.chapters[0].text, text);
  const updated = await request({
    action: "addChapter",
    projectId: project.id,
    title: "Chương 2",
    text,
  });
  assert.equal(updated.chapters[1].text, text);
  assert.equal(get<Project>(project.id, "project").chapters[1].text, text);

  // Exercise the former file-size limit using an actual multipart TXT request.
  const fileText = "a".repeat(30 * 1024 * 1024 + 1);
  const form = new FormData();
  form.set("file", new File([fileText], "truyen.txt", { type: "text/plain" }));
  const response = await upload(
    new NextRequest("http://localhost/api/upload", {
      method: "POST",
      body: form,
    }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, fileText);

  const media = new FormData();
  media.set("file", new File([fileText], "video.mp4"));
  const rejected = await upload(
    new NextRequest("http://localhost/api/upload", {
      method: "POST",
      body: media,
    }),
  );
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /30 MB/);
  console.log(
    "Long story preview, creation, append, persistence and TXT upload passed.",
  );
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
