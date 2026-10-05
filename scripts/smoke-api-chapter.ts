import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  defaults,
  type Project,
  type Job,
  type VideoRecord,
  type ChapterAPIImage,
} from "../modules/project/types";
import { get, list, put, mergeProjectChapters } from "../modules/project/store";
import { startService } from "../modules/providers/services";
import { requireImage } from "../modules/providers/image-api";
import { isImageAPIProvider } from "../modules/providers/image-api-options";
import { processChapterImages } from "../modules/pipeline/chapter-images";

async function main() {
  const provider =
    process.argv.find((arg) => arg.startsWith("--provider="))?.split("=")[1] ||
    "stability";
  if (!isImageAPIProvider(provider))
    throw Error("Chọn một engine API ảnh hợp lệ.");
  const config = requireImage(provider);
  const selectedModel =
    process.argv.find((arg) => arg.startsWith("--model="))?.split("=")[1] ||
    config.model;
  if (
    list<Job>("job").some((job) =>
      ["queued", "audio", "images", "rendering"].includes(job.status),
    )
  )
    throw Error("Chờ tác vụ hiện tại hoàn thành trước khi chạy smoke test.");
  const project: Project = {
    id: randomUUID(),
    name: `[TEST API chapter ${provider}/${selectedModel}]`,
    createdAt: new Date().toISOString(),
    settings: {
      ...defaults,
      imageProvider: provider,
      imageModel: selectedModel,
      imageEnabled: true,
      audioEnabled: false,
      motionMode: "off",
      burnSubtitles: true,
      imageAPIOptions: {
        concurrency: 1,
        retries: 0,
        references: true,
        debug: true,
      },
    },
    chapters: [1, 2].map((index) => ({
      id: randomUUID(),
      title: `Chương ${index}: ${index === 1 ? "Rừng đêm" : "Bình minh"}`,
      text:
        index === 1
          ? "Lâm Hạo là nam, 24 tuổi, tóc đen ngắn, khuôn mặt góc cạnh, mặc áo khoác đen. Lâm Hạo đứng trong rừng ban đêm, cầm thanh kiếm và nhìn ánh trăng."
          : "Lâm Hạo đứng bên dòng sông vào bình minh, cầm thanh kiếm, khuôn mặt bình tĩnh. Ánh sáng dịu phủ lên khu rừng.",
      scenes: [0, 1].map(() => ({
        id: randomUUID(),
        text: "Lâm Hạo cầm kiếm nhìn khu rừng.",
        prompt: "",
        duration: 1,
        approved: false,
      })),
    })),
  };
  put("project", project);
  const jobs: Job[] = project.chapters.map((chapter) => ({
    id: randomUUID(),
    projectId: project.id,
    chapterIds: [chapter.id],
    kind: "pipeline",
    outputMode: "separate",
    status: "queued",
    progress: 0,
    message: "Smoke test API chương",
    createdAt: new Date().toISOString(),
    snapshot: { settings: project.settings },
  }));
  for (const job of jobs) put("job", job);
  await startService("worker");
  const started = Date.now();
  for (;;) {
    const current = jobs.map((job) => get<Job>(job.id, "job"));
    if (current.every((job) => ["done", "error"].includes(job.status))) {
      assert.equal(
        current.filter((job) => job.status === "done").length,
        2,
        JSON.stringify(
          current.map((job) => ({ status: job.status, error: job.error })),
        ),
      );
      break;
    }
    if (Date.now() - started > 300000)
      throw Error("Smoke test vượt quá 5 phút.");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const saved = get<Project>(project.id, "project");
  const masters = saved.chapters.map((chapter) => {
    assert.equal(new Set(chapter.scenes.map((scene) => scene.image)).size, 1);
    assert.equal(chapter.apiImage?.status, "ready");
    return {
      chapterId: chapter.id,
      file: chapter.apiImage!.file,
      model: chapter.apiImage!.model,
      metadata: chapter.apiImage!.metadata,
      referenceFiles: chapter.apiImage!.referenceFiles,
    };
  });
  const history = () =>
    list<ChapterAPIImage>("image_generation_history").filter(
      (image) => image.projectId === saved.id,
    );
  const before = history().length;
  await processChapterImages(saved, saved.chapters, saved.settings, {
    save: () => {
      mergeProjectChapters(
        saved,
        saved.chapters.map((chapter) => chapter.id),
      );
    },
  });
  assert.equal(history().length, before);
  const videos = list<VideoRecord>("video").filter(
    (video) => video.projectId === saved.id,
  );
  assert.equal(videos.length, 2);
  assert.ok(videos.every((video) => video.verified));
  const report = {
    provider,
    projectId: saved.id,
    masters,
    videos: videos.map((video) => ({
      id: video.id,
      output: video.output,
      duration: video.duration,
      width: video.width,
      height: video.height,
    })),
    cacheReuse: "PASS",
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
  };
  await writeFile(
    "data/image-api-chapter-smoke.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
