import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { imageConfig, imageAPIStatus, requireImage, generateAPIImage } from "../modules/providers/image-api";
import { imageAPIOptions } from "../modules/providers/image-api-options";
import { settingsSchema } from "../modules/project/validation";
import { defaults } from "../modules/project/types";
import { makeImage } from "../modules/imagePrompt";

const envKeys = ["IMAGE_PROVIDER", "IMAGE_API_KEY", "IMAGE_MODEL", "OPENAI_API_KEY", "OPENAI_IMAGE_MODEL", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GEMINI_IMAGE_MODEL", "STABILITY_API_KEY", "STABILITY_IMAGE_MODEL"];
function isolateEnv(t: test.TestContext) {
  const previous = envKeys.map(key => process.env[key]);
  envKeys.forEach(key => delete process.env[key]);
  t.after(() => envKeys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  }));
}
async function png() {
  return sharp({ create: { width: 64, height: 64, channels: 3, background: "#357abd" } }).png().toBuffer();
}

test("provider settings and credentials stay independent, with OpenAI legacy compatibility", t => {
  isolateEnv(t);
  process.env.IMAGE_PROVIDER = "gemini";
  process.env.IMAGE_API_KEY = "legacy-openai-secret";
  process.env.IMAGE_MODEL = "gpt-image-1-mini";
  assert.throws(() => requireImage(), /GEMINI_API_KEY/);
  assert.equal(requireImage("openai").model, "gpt-image-1-mini");
  assert.throws(() => requireImage("stability"), /STABILITY_API_KEY/);
  process.env.GEMINI_API_KEY = "google-secret";
  process.env.STABILITY_API_KEY = "stability-secret";
  process.env.OPENAI_IMAGE_MODEL = "gpt-image-1.5";
  assert.equal(imageConfig("openai").model, "gpt-image-1.5");
  for (const option of imageAPIOptions) {
    assert.equal(settingsSchema.parse({ ...defaults, imageProvider: option.id }).imageProvider, option.id);
    assert.equal(imageAPIStatus()[option.id].configured, true);
  }
  const publicJSON = JSON.stringify(imageAPIStatus());
  assert.ok(!publicJSON.includes("secret"));
  assert.throws(() => requireImage("deepseek"), /Chưa cấu hình/);
  process.env.STABILITY_IMAGE_MODEL = "../other";
  assert.throws(() => requireImage("stability"), /model hợp lệ/);
  assert.equal(imageAPIStatus().stability.configured, false);
});

test("missing keys prevent network requests and Google alias is accepted", async t => {
  isolateEnv(t);
  const mocked = t.mock.method(globalThis, "fetch", async () => { throw Error("must not call"); });
  for (const option of imageAPIOptions) await assert.rejects(generateAPIImage(option.id, "scene", "16:9"), new RegExp(option.keyEnv));
  assert.equal(mocked.mock.callCount(), 0);
  process.env.GOOGLE_API_KEY = "google-alias";
  assert.equal(requireImage("gemini").key, "google-alias");
});

test("GPT Image requests one image with portrait size and decodes the returned bytes", async t => {
  isolateEnv(t);
  process.env.OPENAI_API_KEY = "openai-test";
  const bytes = await png();
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.openai.com/v1/images/generations");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer openai-test");
    const body = JSON.parse(String(init.body));
    assert.equal(body.n, 1);
    assert.equal(body.size, "1024x1536");
    assert.match(body.prompt, /9:16/);
    return Response.json({ data: [{ b64_json: bytes.toString("base64") }] });
  });
  assert.deepEqual((await generateAPIImage("openai", "A forest", "9:16")).bytes, bytes);
});

test("Gemini uses Interactions and ignores thought images, text and non-image blocks", async t => {
  isolateEnv(t);
  process.env.GEMINI_API_KEY = "gemini-test";
  const bytes = await png();
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
    assert.equal(new Headers(init.headers).get("x-goog-api-key"), "gemini-test");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "gemini-3.1-flash-image");
    assert.equal(body.store, false);
    assert.equal(body.response_format.aspect_ratio, "16:9");
    assert.equal(body.response_format.delivery, "inline");
    return Response.json({ status: "completed", steps: [
      { type: "thought", summary: [{ type: "image", mime_type: "image/png", data: "dGhvdWdodA==" }] },
      { type: "model_output", content: [{ type: "text", text: "Done" }, { type: "image", mime_type: "image/png", data: bytes.toString("base64") }] },
    ] });
  });
  const result = await generateAPIImage("gemini", "A forest", "16:9");
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.engine, "gemini");
});

test("Stability submits multipart Core/Ultra requests with aspect and seed", async t => {
  isolateEnv(t);
  process.env.STABILITY_API_KEY = "stability-test";
  process.env.STABILITY_IMAGE_MODEL = "ultra";
  const bytes = await png();
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.stability.ai/v2beta/stable-image/generate/ultra");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer stability-test");
    assert.equal(new Headers(init.headers).get("content-type"), null);
    const form = init.body as FormData;
    assert.equal(form.get("aspect_ratio"), "9:16");
    assert.equal(form.get("seed"), "123");
    return new Response(bytes, { headers: { "Content-Type": "image/png" } });
  });
  assert.deepEqual((await generateAPIImage("stability", "A forest", "9:16", 123)).bytes, bytes);
});

test("paid provider errors never expose response bodies or retry another provider", async t => {
  isolateEnv(t);
  process.env.OPENAI_API_KEY = "secret-to-hide";
  const mocked = t.mock.method(globalThis, "fetch", async () => new Response("secret-to-hide", { status: 429 }));
  await assert.rejects(generateAPIImage("openai", "scene", "16:9"), error => {
    assert.match(String(error), /HTTP 429/);
    assert.ok(!String(error).includes("secret-to-hide"));
    return true;
  });
  assert.equal(mocked.mock.callCount(), 1);
});

test("Gemini text-only and malformed base64 results fail instead of producing fake media", async t => {
  isolateEnv(t);
  process.env.GEMINI_API_KEY = "gemini-test";
  let data: unknown = { steps: [{ type: "model_output", content: [{ type: "text", text: "Cannot generate" }] }] };
  t.mock.method(globalThis, "fetch", async () => Response.json(data));
  await assert.rejects(generateAPIImage("gemini", "scene", "16:9"), /base64 hợp lệ/);
  data = { steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/png", data: "%%%invalid" }] }] };
  await assert.rejects(generateAPIImage("gemini", "scene", "16:9"), /base64 hợp lệ/);
});

test("all API providers enter the real image pipeline and publish a correctly sized PNG", async t => {
  isolateEnv(t);
  process.env.OPENAI_API_KEY = "openai-test";
  process.env.GEMINI_API_KEY = "gemini-test";
  process.env.STABILITY_API_KEY = "stability-test";
  const bytes = await png();
  const dir = await mkdtemp(path.join(os.tmpdir(), "storyflow-image-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url: string) => url.includes("stability.ai")
    ? new Response(bytes, { headers: { "Content-Type": "image/png" } })
    : Response.json(url.includes("googleapis.com")
      ? { steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/png", data: bytes.toString("base64") }] }] }
      : { data: [{ b64_json: bytes.toString("base64") }] }));
  for (const option of imageAPIOptions) {
    const filename = `${randomUUID()}.png`;
    const file = path.join(dir, filename);
    t.after(() => unlink(path.resolve("public/generated/images", filename)).catch(() => {}));
    const result = await makeImage("A forest", file, { ...defaults, imageProvider: option.id, aspect: "9:16" });
    assert.equal(result.engine, option.id);
    const metadata = await sharp(await readFile(file)).metadata();
    assert.equal(metadata.width, 720);
    assert.equal(metadata.height, 1280);
    assert.equal(metadata.format, "png");
    assert.deepEqual(await readFile(path.resolve("public/generated/images", filename)), await readFile(file));
  }
});
