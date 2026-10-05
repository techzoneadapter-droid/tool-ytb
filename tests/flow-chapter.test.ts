import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { processFlowScenes } from "../modules/pipeline/flow-scenes";
import {
  buildChapterImagePrompt,
  ensureCharacterBible,
} from "../modules/imagePrompt/chapter";
import { chapterMotionFilter } from "../modules/videoRender/scene";
import { defaults, type Project, type Scene } from "../modules/project/types";

test("two chapters generate twice, three scenes share each chapter Buffer, and transient encode retries reuse it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flow-chapter-"));
  try {
    const project: Project = {
      id: "project",
      name: "fixture",
      createdAt: "now",
      settings: defaults,
      chapters: [0, 1].map((n) => ({
        id: "chapter" + n,
        title: "Chapter " + n,
        text: "Lâm Hạo bước đi.",
        scenes: [0, 1, 2].map((i) => ({
          id: `${n}-${i}`,
          text: "fixture",
          prompt: "fixture",
          duration: 1,
          approved: false,
        })),
      })),
    };
    const buffers = [Buffer.from("chapter0"), Buffer.from("chapter1")];
    let calls = 0;
    const retries = new Map<string, number>();
    const targets = project.chapters.flatMap((chapter, n) =>
      chapter.scenes.map((scene) => ({
        scene,
        chapter,
        chapterId: chapter.id,
        chapterIndex: n,
        projectId: project.id,
        prompt: "master" + n,
      })),
    );
    const errors = await processFlowScenes(targets, defaults, {
      assets: directory,
      ensureVoice: async () => {},
      persist: () => {
        assert.ok(!JSON.stringify(project).includes('"type":"Buffer"'));
      },
      generate: async (prompt, _aspect, _stage, mapping) => {
        calls++;
        const n = Number(prompt.at(-1));
        assert.equal(mapping?.chapterId, "chapter" + n);
        assert.match(mapping!.requestId, /^flow_/);
        return { bytes: buffers[n], model: "fixture" };
      },
      render: async (scene: Scene, buffer) => {
        assert.equal(buffer, buffers[Number(scene.id[0])]);
        retries.set(scene.id, (retries.get(scene.id) || 0) + 1);
        if (scene.id === "0-1" && retries.get(scene.id) === 1)
          throw Error("transient encode");
      },
      verify: async () => {},
      publish: async (scene) => "video-" + scene.id,
    });
    assert.equal(errors.length, 0);
    assert.equal(calls, 2);
    assert.equal(retries.get("0-1"), 2);
    for (const chapter of project.chapters) {
      assert.equal(chapter.chapterImageGenerationCount, 1);
      assert.equal(chapter.masterImage?.status, "ready");
      assert.equal(
        new Set(chapter.scenes.map((s) => s.chapterMasterImage)).size,
        1,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CharacterBible is frozen across chapters and included in both prompts", () => {
  const character = {
    name: "Lâm Hạo",
    descriptor: "24 years old, angular face, short black hair, black jacket",
  };
  const project: Project = {
    id: "p",
    name: "p",
    createdAt: "now",
    settings: defaults,
    chapters: [0, 1].map((n) => ({
      id: String(n),
      title: String(n),
      text: "Lâm Hạo enters the forest.",
      scenes: [],
      visualProfile: {
        style: defaults.style,
        seed: n,
        characters: [character],
        locations: [],
        era: "",
        clothing: "",
        visualNotes: "",
      },
    })),
  };
  const bible = ensureCharacterBible(project);
  project.chapters[1].visualProfile!.characters[0] = {
    name: "Lâm Hạo",
    descriptor: "different face",
  };
  const prompts = project.chapters.map((c) =>
    buildChapterImagePrompt(project, c, defaults),
  );
  assert.equal(ensureCharacterBible(project), bible);
  for (const prompt of prompts) {
    assert.ok(prompt.includes(character.descriptor));
    assert.ok(!prompt.includes("different face"));
  }
  assert.equal(bible.referenceImageStatus, "NOT CURRENTLY VERIFIED");
});

test("motion presets are deterministic, different, and preserve aspect ratio", () => {
  const filters = [0, 1, 2, 3, 4].map((i) =>
    chapterMotionFilter(1280, 720, 2, i),
  );
  assert.equal(new Set(filters).size, 5);
  assert.equal(filters[0], chapterMotionFilter(1280, 720, 2, 5));
  assert.ok(
    filters.every((f) => f.includes("force_original_aspect_ratio=increase")),
  );
});
