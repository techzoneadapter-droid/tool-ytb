import "dotenv/config";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
import { randomUUID } from "node:crypto";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { list, put, updateJob } from "../modules/project/store";
import { defaults, type Project, type Job } from "../modules/project/types";
import {
  ensureCharacterBible,
  buildChapterImagePrompt,
} from "../modules/imagePrompt/chapter";
import { processProjectFlowScenes } from "../modules/pipeline/flow-runtime";
import { startService } from "../modules/providers/services";
import { waitForFlowSession } from "../modules/providers/flow-browser";
import { assets, render } from "../modules/videoRender";
import { verifyVideo } from "../modules/videoRender/process";
import { createVideoRecord } from "../modules/videoLibrary";

async function main() {
  const report: Record<string, unknown> = {
    ok: false,
    live: true,
    referenceImage: "NOT CURRENTLY VERIFIED",
  };
  try {
    await startService("flow");
    await waitForFlowSession();
    const source = list<Project>("project").find(
      (p) =>
        p.settings.imageProvider === "flow-browser" &&
        p.chapters.some((c) => c.scenes.length >= 2),
    );
    if (!source)
      throw Error(
        "Không có chương Flow với ít nhất hai cảnh để kiểm tra live.",
      );
    const selected = source.chapters
      .filter((c) => c.scenes.length >= 2)
      .slice(0, 2);
    if (selected.length < 2)
      throw Error(
        "Cần hai chương có ít nhất hai cảnh cho kiểm tra live liên chương.",
      );
    const project: Project = {
      id: randomUUID(),
      name: "Flow live · chapter master",
      createdAt: new Date().toISOString(),
      settings: {
        ...defaults,
        ...source.settings,
        audioEnabled: !process.argv.includes("--without-audio"),
        imageProvider: "flow-browser",
        fallbackOnImageError: false,
        motionMode: "off",
        humanCheck: false,
      },
      characterBible: structuredClone(ensureCharacterBible(source)),
      chapters: selected.map((c) => ({
        ...structuredClone(c),
        id: randomUUID(),
        masterImage: undefined,
        scenes: c.scenes
          .slice(0, 3)
          .map((s) => ({
            id: randomUUID(),
            text: s.text,
            prompt: s.prompt,
          duration: Math.min(s.duration, 3),
            approved: false,
          })),
      })),
    };
    const job: Job = {
      id: randomUUID(),
      projectId: project.id,
      chapterIds: project.chapters.map((c) => c.id),
      status: "images",
      progress: 0,
      message: "Live chapter smoke",
      kind: "pipeline",
      createdAt: project.createdAt,
      snapshot: { settings: project.settings },
    };
    const previous = new Set(
      (await readdir(assets)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)),
    );
    const prompts = project.chapters.map((c) =>
      buildChapterImagePrompt(project, c, project.settings),
    );
    const shared = project.characterBible!.characters.filter((c) =>
      selected.every((ch) => ch.text.includes(c.name)),
    );
    if (!shared.length)
      throw Error(
        "Hai chương không có cùng nhân vật được nhận diện để kiểm tra consistency.",
      );
    report.sharedCharacters = shared.map((c) => c.name);
    report.characterBible = shared.every((c) =>
      prompts.every((p) => p.includes(JSON.stringify(c))),
    );
    put("project", project);
    put("job", job);
    const errors = await processProjectFlowScenes(
      project,
      job,
      project.chapters.flatMap((c) => c.scenes),
      (e) =>
        process.stdout.write(
          JSON.stringify({
            chapterId: e.chapterId,
            status: e.status,
            stage: e.stage,
          }) + "\n",
        ),
    );
    if (errors.length) {
      updateJob(job.id, { status: "error", sceneErrors: errors });
      throw Object.assign(Error(errors[0].message), errors[0]);
    }
    const videos = [];
    for (const chapter of project.chapters) {
      if (
        chapter.chapterImageGenerationCount !== 1 ||
        new Set(chapter.scenes.map((s) => s.chapterMasterImage)).size !== 1
      )
        throw Error("Chapter master mapping invariant failed.");
      if (chapter.masterImage?.submitCount !== 1 || chapter.masterImage.imageCount !== 1)
        throw Error("Live must observe exactly one submit and x1 image per chapter.");
      const result = await render(chapter.scenes, project.settings, () => {});
      await verifyVideo(path.join(assets, result.output));
      const completed = updateJob(job.id, {
        ...result,
        chapterIds: [chapter.id],
        status: "done",
        verified: true,
        progress: 100,
      });
      videos.push((await createVideoRecord(completed, project)).id);
    }
    const newImages = (await readdir(assets)).filter(
      (f) => /\.(png|jpe?g|webp)$/i.test(f) && !previous.has(f),
    );
    if (newImages.length) throw Error("Intermediate generated images found.");
    Object.assign(report, {
      ok: true,
      projectId: project.id,
      videos,
      chapters: 2,
      generations: 2,
      intermediateImages: 0,
    });
  } catch (error) {
    const typed = error as { code?: string; stage?: string; message?: string };
    Object.assign(report, {
      code: typed.code || "FLOW_CHAPTER_SMOKE_FAILED",
      stage: typed.stage,
      message: typed.message,
    });
    process.exitCode = 1;
  } finally {
    await mkdir("data/flow-debug", { recursive: true });
    await writeFile(
      "data/flow-debug/chapter-live-verification.json",
      JSON.stringify(report, null, 2),
    );
    process.stdout.write(JSON.stringify(report) + "\n");
  }
}
void main();
