import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PipelineProgress } from "../app/components/video/PipelineProgress";
import { defaults, type Project, type Job } from "../modules/project/types";

test("progress recognizes API and legacy chapter masters; chapter error never says scene zero", () => {
  const project: Project = {
    id: "p",
    name: "fixture",
    createdAt: "",
    settings: { ...defaults, imageProvider: "gemini" },
    chapters: [
      {
        id: "c",
        title: "Chapter",
        text: "",
        scenes: [],
        apiImage: {
          requestId: "r",
          cacheKey: "",
          projectId: "p",
          chapterId: "c",
          engine: "gemini",
          model: "image",
          prompt: "",
          negativePrompt: "",
          characterBlock: "",
          characterIds: [],
          referenceFiles: [],
          seed: 1,
          status: "error",
          createdAt: "",
          errorCode: "IMAGE_API_FAILED",
          errorMessage: "fixture failed",
        },
      },
    ],
  };
  const job: Job = {
    id: "j",
    projectId: "p",
    chapterIds: ["c"],
    status: "error",
    progress: 0,
    message: "",
    createdAt: "2026-01-01",
    snapshot: { settings: project.settings },
    sceneErrors: [
      {
        chapterId: "c",
        sceneId: "s",
        sceneIndex: 0,
        code: "IMAGE_API_FAILED",
        stage: "CHAPTER_IMAGE",
        message: "fixture failed",
      },
    ],
  };
  const render = () =>
    renderToStaticMarkup(
      <PipelineProgress
        project={project}
        jobs={[job]}
        busy={false}
        act={() => {}}
      />,
    );
  let html = render();
  project.settings.imageEnabled = false;
  job.imageMode = "shared";
  job.sharedImageValid = true;
  const shared = render();
  assert.ok(shared.includes("Ảnh chương: ✓ Dùng ảnh chung"));
  for (const forbidden of [
    "Ảnh master chương",
    "Phân tích chương",
    "Character Bible",
    "portrait",
    "gọi API",
  ])
    assert.ok(!shared.includes(forbidden));
  job.sharedImageValid = false;
  assert.ok(render().includes("Ảnh dùng chung không hợp lệ"));
  project.settings.imageEnabled = true;
  assert.ok(html.includes("Ảnh master chương"));
  assert.ok(html.includes("Character Bible"));
  assert.ok(!html.includes("Cảnh 0"));
  project.chapters[0].apiImage!.status = "ready";
  job.status = "images";
  html = render();
  assert.ok(html.includes("✓ Sẵn sàng"));
  assert.ok(!html.includes("Cảnh 0"));
  project.settings.imageProvider = "flow-browser";
  project.chapters[0].masterImage = {
    requestId: "r",
    projectId: "p",
    chapterId: "c",
    chapterIndex: 0,
    prompt: "",
    status: "ready",
  };
  html = render();
  assert.ok(html.includes("✓ Sẵn sàng"));
  assert.ok(!html.includes("Cảnh 0"));
  assert.ok(!html.includes("Character Bible"));
});
