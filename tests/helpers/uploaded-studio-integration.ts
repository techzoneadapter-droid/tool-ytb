import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { POST } from "../../app/api/studio/route";
import { get, put, list } from "../../modules/project/store";
import type { Project } from "../../modules/project/types";

async function post(body: object) {
  const response = await POST(
    new NextRequest("http://localhost/api/studio", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
}
async function main() {
  // A missing upload must be detected before starting any service or paid request.
  globalThis.fetch = async () => {
    throw Error("Unexpected external request");
  };
  const created = await post({
    action: "create",
    name: "First",
    text: "Chương 1\nMột câu chuyện.",
    settings: {
      imageEnabled: true,
      ttsProvider: "edge-online",
      voice: "vi-VN-HoaiMyNeural",
    },
  });
  assert.equal(created.status, 200);
  const project = created.body as Project;
  assert.equal(project.settings.imageEnabled, false);
  for (const kind of ["pipeline", "render", "motion", "prepare", "image"]) {
    const result = await post({
      action: "enqueue",
      projectId: project.id,
      chapterIds: [project.chapters[0].id],
      kind,
    });
    assert.equal(result.status, 400);
    assert.match(
      result.body.error,
      kind === "image" ? /đã được bỏ/ : /tải.*ảnh/,
    );
    assert.equal(list("job").length, 0);
  }
  assert.equal(
    (await post({ action: "createVideo", name: "Blocked", text: "Story" }))
      .status,
    400,
  );
  assert.equal(list("project").length, 1);
  const image = randomUUID() + ".png";
  await mkdir("data/assets", { recursive: true });
  await writeFile(
    "data/assets/" + image,
    await sharp({
      create: { width: 32, height: 32, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer(),
  );
  put("upload", { id: image });
  const selected = await post({
    action: "settings",
    projectId: project.id,
    settings: {
      ...project.settings,
      imageEnabled: true,
      fallbackImage: image,
      logo: image,
      musicVolume: 0.3,
    },
  });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  assert.equal(
    get<Project>(project.id, "project").settings.fallbackImage,
    image,
  );
  assert.equal(selected.body.settings.imageEnabled, false);
  assert.equal(selected.body.settings.logo, image);
  assert.equal(selected.body.settings.musicVolume, 0.3);
  const second = await post({
    action: "create",
    name: "Second",
    text: "Một truyện khác.",
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.settings.fallbackImage, undefined);
  assert.equal(
    get<Project>(project.id, "project").settings.fallbackImage,
    image,
  );
  const removed = await post({
    action: "settings",
    projectId: project.id,
    settings: { ...selected.body.settings, fallbackImage: undefined },
  });
  assert.equal(removed.status, 200);
  assert.equal(
    get<Project>(project.id, "project").settings.fallbackImage,
    undefined,
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
