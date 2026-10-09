import test from "node:test";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { POST as generate } from "../app/api/image/generate/route";
import {
  POST as connect,
  GET as providers,
} from "../app/api/image/providers/route";
import { VideoCreatePage } from "../app/components/video/VideoCreatePage";
import { defaults, type Project, type Scene } from "../modules/project/types";
import { uploadedImageSettings } from "../modules/project/uploaded-image";
import { sceneRenderKey } from "../modules/videoRender/scene-cache";

test("uploaded-only policy keeps narration, motion, subtitles and branding options intact", () => {
  const old = {
    ...defaults,
    imageEnabled: true,
    imageProvider: "gemini" as const,
    fallbackImage: "chosen.png",
    intro: "intro.mp4",
    outro: "outro.mp4",
    music: "music.wav",
    logo: "logo.png",
    ttsProvider: "edge-online" as const,
    motionMode: "selected" as const,
  };
  assert.deepEqual(uploadedImageSettings(old), { ...old, imageEnabled: false });
  assert.equal(old.imageEnabled, true);
});

test("generation and connection routes reject even legacy valid payloads without contacting an API", async () => {
  for (const route of [generate, connect]) {
    const response = await route(
      new NextRequest("http://localhost/api/image/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "gemini",
          action: "connect",
          key: "fixture",
          prompt: "test",
        }),
      }),
    );
    assert.equal(response.status, 410);
    assert.match((await response.json()).error, /tải lên/);
    assert.equal(
      (
        await route(
          new NextRequest("http://localhost/api/image/generate", {
            method: "POST",
            headers: { origin: "http://other.example" },
          }),
        )
      ).status,
      403,
    );
  }
  assert.deepEqual(await (await providers()).json(), {
    ok: true,
    enabled: false,
    providers: {},
  });
});

test("changing the single uploaded image invalidates old scene video caches", () => {
  const scene: Scene = {
    id: "scene",
    text: "test",
    prompt: "",
    duration: 2,
    approved: true,
  };
  const old = { ...defaults, imageEnabled: true, fallbackImage: "first.png" };
  const first = uploadedImageSettings(old);
  const second = { ...first, fallbackImage: "second.png" };
  assert.notEqual(sceneRenderKey(scene, old), sceneRenderKey(scene, first));
  assert.notEqual(sceneRenderKey(scene, first), sceneRenderKey(scene, second));
});

test("video form has one uploaded image and retains all other production controls", () => {
  const project: Project = {
    id: "project",
    name: "fixture",
    createdAt: "",
    settings: defaults,
    chapters: [{ id: "chapter", title: "Chương 1", text: "text", scenes: [] }],
  };
  const html = renderToStaticMarkup(
    <VideoCreatePage
      data={{ projects: [project], jobs: [] }}
      projectId={project.id}
      onProject={() => {}}
      refresh={async () => {}}
      onImport={() => {}}
      onLibrary={() => {}}
    />,
  );
  for (const label of [
    "Ảnh cho toàn bộ video",
    "Ảnh dùng chung",
    "Tự động thêm phụ đề",
    "Intro",
    "Outro",
    "Logo",
    "Nhạc nền",
    "Gộp các chương",
    "Wan2.2",
  ])
    assert.ok(html.includes(label), label);
  for (const label of [
    "Engine ảnh",
    "Tự động tạo ảnh minh họa",
    "API key",
    "JSON Cookie",
    "Ảnh tham chiếu nhân vật",
    "FLUX.2",
  ])
    assert.ok(!html.includes(label), label);
});

test("studio rejects missing images before queueing and persists each project's selected image", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const path = await import("node:path");
  const repo = process.cwd();
  const directory = await mkdtemp(
    path.join(tmpdir(), "storyflow-uploaded-studio-"),
  );
  try {
    await promisify(execFile)(
      process.execPath,
      [
        "--import",
        pathToFileURL(path.join(repo, "node_modules/tsx/dist/loader.mjs")).href,
        path.join(repo, "tests/helpers/uploaded-studio-integration.ts"),
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: path.join(repo, "tsconfig.json"),
        },
        windowsHide: true,
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
