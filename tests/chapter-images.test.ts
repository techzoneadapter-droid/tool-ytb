import test from "node:test";
import assert from "node:assert/strict";
import { unlink, readFile, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { processChapterImages } from "../modules/pipeline/chapter-images";
import { defaults, type Project } from "../modules/project/types";
import { prepareCharacterBible } from "../modules/imagePrompt/character-consistency";
import { buildAnalyzedPrompt } from "../modules/imagePrompt/prompt-builder";
import { generateAPIImage } from "../modules/providers/image-api";
import {
  ImagePipelineError,
  imageCapabilities,
} from "../modules/providers/api-image-provider";
import { validateImageBaseURL } from "../modules/providers/image-api-options";
import { connectImageAPI } from "../modules/providers/image-api-connect";
import { root } from "../modules/project/store";
import { render } from "../modules/videoRender";
import { verifyVideo } from "../modules/videoRender/process";

function fixture(): Project {
  return {
    id: randomUUID(),
    name: "chapter image test",
    createdAt: new Date().toISOString(),
    settings: {
      ...defaults,
      imageProvider: "gemini",
      imageModel: "gemini-3.1-flash-image",
      audioEnabled: false,
      burnSubtitles: false,
      imageAPIOptions: { retries: 0 },
    },
    chapters: [0, 1].map((index) => ({
      id: randomUUID(),
      title: `Chương ${index + 1}`,
      text: `Lâm Hạo 24 tuổi, tóc đen ngắn, khuôn mặt góc cạnh, mặc áo đen. Lâm Hạo bước vào rừng ban đêm và cầm kiếm.`,
      scenes: [0, 1, 2].map(() => ({
        id: randomUUID(),
        text: "Lâm Hạo đi trong rừng.",
        prompt: "old scene prompt",
        duration: 0.3,
        approved: false,
      })),
    })),
  };
}
async function image() {
  return sharp({
    create: { width: 640, height: 360, channels: 3, background: "#447799" },
  })
    .png()
    .toBuffer();
}
function cleanup(t: test.TestContext, project: Project) {
  t.after(async () => {
    const files = new Set([
      ...project.chapters.flatMap((c) =>
        c.apiImage?.file ? [c.apiImage.file] : [],
      ),
      ...(project.characterBible?.characters.flatMap((c) =>
        c.portrait ? [c.portrait.file] : [],
      ) || []),
    ]);
    for (const file of files) {
      await unlink(path.join(root, "assets", file)).catch(() => {});
      await unlink(path.resolve("public/generated/images", file)).catch(
        () => {},
      );
    }
  });
}
test("one portrait per main character, one master per chapter, all scenes share it, restart/retry never regenerates paid images", async (t) => {
  const project = fixture();
  cleanup(t, project);
  const bytes = await image();
  const calls: { prompt: string; references: string[] }[] = [];
  const run = (p: Project) =>
    processChapterImages(p, p.chapters, p.settings, {
      save: () => {},
      load: () => p,
      history: () => {},
      generate: async (_provider, prompt, _aspect, _seed, _model, input) => {
        calls.push({
          prompt,
          references:
            input?.references?.map((r) => r.bytes.toString("base64")) || [],
        });
        return {
          bytes,
          engine: "gemini",
          model: p.settings.imageModel!,
          metadata: { attempts: 1, usage: { output_tokens: 12 } },
        };
      },
    });
  assert.deepEqual(await run(project), []);
  assert.equal(calls.length, 3);
  assert.match(calls[0].prompt, /Canonical character reference portrait/);
  assert.equal(calls[1].references[0], calls[2].references[0]);
  for (const chapter of project.chapters) {
    assert.equal(new Set(chapter.scenes.map((scene) => scene.image)).size, 1);
    assert.equal(chapter.apiImage?.metadata?.usage?.output_tokens, 12);
    assert.match(chapter.apiImage!.prompt, /STYLE:.*\nSCENE:.*\nCHARACTERS:/s);
  }
  const restarted = JSON.parse(JSON.stringify(project)) as Project;
  restarted.settings.imageAPIOptions = {
    ...restarted.settings.imageAPIOptions,
    retries: 4,
    timeoutSeconds: 300,
    debug: true,
    concurrency: 1,
  };
  assert.deepEqual(await run(restarted), []);
  assert.equal(calls.length, 3);
  const analysis = restarted.chapters[0].imageAnalysis;
  assert.equal(
    buildAnalyzedPrompt(
      restarted.chapters[0],
      restarted.characterBible!,
      restarted.settings,
    ).analysis,
    analysis,
  );
  restarted.chapters[0].text += " Lâm Hạo chạy ra khỏi rừng.";
  assert.notEqual(
    buildAnalyzedPrompt(
      restarted.chapters[0],
      restarted.characterBible!,
      restarted.settings,
    ).analysis.cacheKey,
    analysis?.cacheKey,
  );
});
test("failed chapter leaves other masters intact; retry only generates the missing chapter; unsupported references are omitted", async (t) => {
  const project = fixture();
  project.settings.imageProvider = "stability";
  project.settings.imageModel = "core";
  cleanup(t, project);
  const bytes = await image();
  let failing = true;
  let calls = 0;
  const deps = {
    save: () => {},
    history: () => {},
    generate: async (
      _provider: string | undefined,
      prompt: string,
      _aspect: "16:9" | "9:16",
      _seed?: number,
      _model?: string,
      input?: Parameters<typeof generateAPIImage>[5],
    ) => {
      calls++;
      assert.equal(input?.references?.length, 0);
      if (failing && prompt.includes("Chương 1"))
        throw new ImagePipelineError("IMAGE_API_FAILED", "HTTP 429", 429);
      return {
        bytes,
        engine: "stability",
        model: "core",
        metadata: { attempts: 1 },
      };
    },
  };
  const errors = await processChapterImages(
    project,
    project.chapters,
    project.settings,
    deps,
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "IMAGE_API_FAILED");
  assert.equal(project.chapters[1].apiImage?.status, "ready");
  const retained = project.chapters[1].apiImage!.file;
  failing = false;
  assert.deepEqual(
    await processChapterImages(
      project,
      project.chapters,
      project.settings,
      deps,
    ),
    [],
  );
  assert.equal(calls, 3);
  assert.equal(project.chapters[1].apiImage?.file, retained);
});
test("canonical identities survive later conflicting descriptions; ambiguous chapters have bounded prompts and negative block", () => {
  const project = fixture();
  const bible = prepareCharacterBible(project);
  const canonical = bible.characters[0].normalizedPrompt;
  project.chapters[1].text =
    "Lâm Hạo tóc đỏ, mặc áo trắng đứng bên sông. Lâm Hạo bị thương nhưng vẫn cầm kiếm.";
  const result = buildAnalyzedPrompt(
    project.chapters[1],
    prepareCharacterBible(project),
    project.settings,
  );
  assert.equal(bible.characters[0].normalizedPrompt, canonical);
  assert.match(result.characterBlock, /short hair; color: black/);
  assert.ok(result.analysis.explicitChanges.length);
  assert.match(result.prompt, /NEGATIVE:/);
  const empty = { ...project.chapters[0], text: "", imageAnalysis: undefined };
  assert.match(
    buildAnalyzedPrompt(empty, bible, project.settings).prompt,
    /quiet establishing/,
  );
  assert.ok(result.prompt.length <= 12000);
});
test("custom API connects to catalog, downloads URL without credentials, retries 429 with stable request ID and passes configured capability fields", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "chapter-api-config-"));
  const old = process.env.IMAGE_API_CONFIG_DIR;
  process.env.IMAGE_API_CONFIG_DIR = dir;
  t.after(async () => {
    if (old === undefined) delete process.env.IMAGE_API_CONFIG_DIR;
    else process.env.IMAGE_API_CONFIG_DIR = old;
    await rm(dir, { recursive: true, force: true });
  });
  const bytes = await image();
  const ids: string[] = [];
  let imageCalls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/models"))
        return Response.json({
          data: [{ id: "flux-image" }, { id: "glm-5.3" }],
        });
      if (url === "https://assets.example/master.png") {
        assert.equal(new Headers(init.headers).get("authorization"), null);
        return new Response(bytes, {
          headers: { "content-type": "image/png" },
        });
      }
      assert.equal(url, "https://images.example/v1/images/generations");
      const body = JSON.parse(String(init.body));
      assert.equal(body.n, 1);
      assert.equal(body.seed, 42);
      assert.equal(body.negative_prompt, "blur");
      ids.push(new Headers(init.headers).get("x-client-request-id")!);
      imageCalls++;
      return imageCalls === 1
        ? new Response("secret-key-must-stay-hidden", { status: 429 })
        : Response.json({
            data: [{ url: "https://assets.example/master.png" }],
            usage: { output_tokens: 25, prompt: "hidden" },
          });
    },
  );
  const connection = await connectImageAPI(
    "api-compatible",
    "test-private-key",
    "https://images.example/v1",
    "flux-image",
  );
  assert.deepEqual(
    connection.models.map((m) => m.id),
    ["flux-image"],
  );
  const generated = await generateAPIImage(
    "api-compatible",
    "scene",
    "16:9",
    42,
    undefined,
    {
      options: { retries: 1, supportsSeed: true, supportsNegativePrompt: true },
      negativePrompt: "blur",
    },
  );
  assert.deepEqual(generated.bytes, bytes);
  assert.equal(generated.metadata.attempts, 2);
  assert.equal(ids[0], ids[1]);
  assert.deepEqual(generated.metadata.usage, { output_tokens: 25 });
  assert.equal(imageCapabilities("openai", "gpt-image-1").supportsSeed, false);
  assert.throws(() => validateImageBaseURL("https://secret@images.example/v1"));
  assert.throws(() =>
    validateImageBaseURL("https://images.example/v1?key=secret"),
  );
});
test("Gemini and GPT receive cached portrait bytes through their native reference formats", async (t) => {
  const old = [
    process.env.GEMINI_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.IMAGE_API_CONFIG_DIR,
  ];
  const dir = await mkdtemp(path.join(tmpdir(), "reference-config-"));
  process.env.IMAGE_API_CONFIG_DIR = dir;
  process.env.GEMINI_API_KEY = "fake-gemini";
  process.env.OPENAI_API_KEY = "fake-openai";
  t.after(async () => {
    ["GEMINI_API_KEY", "OPENAI_API_KEY", "IMAGE_API_CONFIG_DIR"].forEach(
      (key, index) => {
        if (old[index] === undefined) delete process.env[key];
        else process.env[key] = old[index];
      },
    );
    await rm(dir, { recursive: true, force: true });
  });
  const bytes = await image();
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.includes("googleapis")) {
      const data = JSON.parse(String(init.body));
      assert.equal(data.input[0].data, bytes.toString("base64"));
      assert.equal(data.input[1].type, "text");
      return Response.json({
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "image",
                mime_type: "image/png",
                data: bytes.toString("base64"),
              },
            ],
          },
        ],
      });
    }
    assert.ok(url.endsWith("/images/edits"));
    assert.ok(init.body instanceof FormData);
    assert.equal(new Headers(init.headers).get("content-type"), null);
    assert.ok((init.body as FormData).get("image") instanceof Blob);
    return Response.json({ data: [{ b64_json: bytes.toString("base64") }] });
  });
  for (const provider of ["gemini", "openai"])
    await generateAPIImage(
      provider,
      "Use identity Lâm Hạo",
      "16:9",
      42,
      undefined,
      { references: [{ bytes, mime: "image/png", name: "lam-hao.png" }] },
    );
});
test("Stability Ultra accepts a single portrait through native image-to-image while Core stays text-only", async (t) => {
  const previous = process.env.STABILITY_API_KEY;
  process.env.STABILITY_API_KEY = "fixture-stability-key";
  const previousDir = process.env.IMAGE_API_CONFIG_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), "ultra-config-"));
  process.env.IMAGE_API_CONFIG_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.STABILITY_API_KEY;
    else process.env.STABILITY_API_KEY = previous;
    if (previousDir === undefined) delete process.env.IMAGE_API_CONFIG_DIR;
    else process.env.IMAGE_API_CONFIG_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });
  const bytes = await image();
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.ok(url.endsWith("/ultra"));
    const form = init.body as FormData;
    assert.equal(form.get("strength"), "0.55");
    assert.ok(form.get("image") instanceof Blob);
    const reference = await sharp(
      Buffer.from(await (form.get("image") as Blob).arrayBuffer()),
    ).metadata();
    assert.equal(reference.width, 1280);
    assert.equal(reference.height, 720);
    return new Response(bytes, { headers: { "content-type": "image/png" } });
  });
  assert.equal(
    imageCapabilities("stability", "ultra").supportsReferenceImages,
    true,
  );
  assert.equal(
    imageCapabilities("stability", "core").supportsReferenceImages,
    false,
  );
  await generateAPIImage("stability", "A chapter scene", "16:9", 42, "ultra", {
    options: { referenceStrength: 0.55 },
    references: [{ bytes, mime: "image/png", name: "Lam Hao.png" }],
  });
});

test("cached chapter master renders a real video with silent audio when narration is disabled", async (t) => {
  const project = fixture();
  project.chapters = [project.chapters[0]];
  project.settings.imageAPIOptions = { references: false };
  cleanup(t, project);
  const bytes = await image();
  await processChapterImages(project, project.chapters, project.settings, {
    save: () => {},
    history: () => {},
    generate: async () => ({
      bytes,
      engine: "gemini",
      model: "fixture",
      metadata: { attempts: 1 },
    }),
  });
  const result = await render(
    project.chapters[0].scenes,
    project.settings,
    () => {},
  );
  t.after(() =>
    unlink(path.join(root, "assets", result.output)).catch(() => {}),
  );
  await verifyVideo(path.join(root, "assets", result.output));
  assert.ok(
    (await readFile(path.join(root, "assets", result.output))).length > 1000,
  );
});
