import assert from "node:assert/strict";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { processFlowScenes } from "../../modules/pipeline/flow-scenes";
import { renderSceneBuffer } from "../../modules/videoRender/scene";
import { sceneRenderKey } from "../../modules/videoRender/scene-cache";
import { run, verifyVideo } from "../../modules/videoRender/process";
import {
  defaults,
  type Scene,
  type Project,
  type VideoRecord,
} from "../../modules/project/types";
async function main() {
  // Import storage only after switching to an isolated directory: never modify user DB.
  const store = await import("../../modules/project/store");
  const library = await import("../../modules/videoLibrary");
  const { render } = await import("../../modules/videoRender");
  const assetDirectory = path.join(store.root, "assets");
  await mkdir(assetDirectory, { recursive: true });
  const settings = {
    ...defaults,
    imageProvider: "flow-browser" as const,
    audioEnabled: true,
  };
  const scenes: Scene[] = [1, 2, 3].map((index) => ({
    id: randomUUID(),
    text: "Cảnh " + index,
    prompt: "prompt-" + index,
    duration: 0.3,
    approved: false,
  }));
  const chapterId = randomUUID();
  const project: Project = {
    id: randomUUID(),
    name: "Isolated Flow integration",
    createdAt: new Date().toISOString(),
    settings,
    chapters: [{ id: chapterId, title: "Chương 1", text: "Truyện", scenes }],
  };
  store.put("project", project);
  const imageBuffer = await sharp({
    create: { width: 768, height: 512, channels: 3, background: "#cc7711" },
  })
    .png()
    .toBuffer();
  let failSecond = true;
  const generated: string[] = [];
  const persisted: string[] = [];
  const targets = scenes.map((scene) => ({
    scene,
    chapterId,
    chapter: project.chapters[0],
    projectId: project.id,
    prompt: "chapter-master",
  }));
  const deps = {
    assets: assetDirectory,
    ensureVoice: async (scene: Scene) => {
      if (scene.audio) return;
      const audio = randomUUID() + ".wav";
      await run([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.3",
        "-ar",
        "24000",
        path.join(assetDirectory, audio),
      ]);
      scene.audio = audio;
      scene.audioSource = "test-fixture";
      scene.audioStatus = "done";
    },
    generate: async (prompt: string) => {
      generated.push(prompt);
      return { bytes: imageBuffer, model: "test-fixture" };
    },
    render: async (scene: Scene, buffer: Buffer, outputPath: string) => {
      assert.equal(
        buffer,
        imageBuffer,
        "Buffer must pass directly to the renderer without disk IO",
      );
      if (scene === scenes[1] && failSecond)
        throw Object.assign(Error("Encode fixture failure"), {
          code: "SCENE_RENDER_FAILED",
          stage: "SCENE_RENDER",
        });
      await renderSceneBuffer({
        imageBuffer: buffer,
        scene,
        settings,
        outputPath,
        audioPath: path.join(assetDirectory, scene.audio!),
      });
    },
    verify: async (output: string) => {
      await verifyVideo(path.join(assetDirectory, output));
    },
    persist: () => {
      store.mergeProjectChapters(project, [chapterId]);
      persisted.push(JSON.stringify(project));
    },
    publish: async (scene: Scene) =>
      (
        await library.createSceneVideoRecord(
          scene,
          chapterId,
          project,
          "fixture-job",
        )
      ).id,
  };
  const errors = await processFlowScenes(targets, settings, deps);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].sceneIndex, 2);
  assert.equal(errors[0].code, "SCENE_RENDER_FAILED");
  assert.deepEqual(
    scenes.map((scene) => scene.flow!.status),
    ["done", "error", "done"],
  );
  const firstOutputs = [scenes[0].flow!.videoPath, scenes[2].flow!.videoPath];
  assert.equal(store.list<VideoRecord>("video").length, 2);
  assert.ok(
    persisted.some(
      (snapshot) =>
        JSON.parse(snapshot).chapters[0].scenes[0].flow?.status === "done",
    ),
  );
  assert.ok(
    persisted.every(
      (snapshot) =>
        !snapshot.includes("data:image") && !snapshot.includes("base64"),
    ),
  );
  assert.deepEqual(generated, ["chapter-master"]);
  assert.equal(project.chapters[0].chapterImageGenerationCount, 1);
  assert.equal(new Set(scenes.map((s) => s.chapterMasterImage)).size, 1);
  failSecond = false;
  generated.length = 0;
  const retry = await processFlowScenes(targets, settings, deps);
  assert.equal(retry.length, 0);
  assert.deepEqual(
    generated,
    [],
    "retry in the same worker reuses the unfinished chapter's master Buffer",
  );
  assert.deepEqual(
    [scenes[0].flow!.videoPath, scenes[2].flow!.videoPath],
    firstOutputs,
  );
  assert.equal(library.listVideos().length, 3);
  assert.equal(
    store
      .get<Project>(project.id, "project")
      .chapters[0].scenes.filter((scene) => scene.flow?.status === "done")
      .length,
    3,
  );
  const final = await render(scenes, settings, () => {});
  await verifyVideo(path.join(assetDirectory, final.output));
  assert.match(
    await readFile(path.join(assetDirectory, final.srt!), "utf8"),
    /Cảnh 1/,
  );
  const files = await readdir(assetDirectory);
  assert.equal(files.filter((file) => /\.(png|jpe?g)$/i.test(file)).length, 0);
  assert.notEqual(
    sceneRenderKey({ ...scenes[0], text: "Changed narration" }, settings),
    scenes[0].flow!.renderKey,
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
