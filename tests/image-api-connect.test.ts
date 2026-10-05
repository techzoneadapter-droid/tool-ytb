import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fetchImageModels, connectImageAPI, selectImageModel } from "../modules/providers/image-api-connect";
import { imageConfig, imageAPIStatus, generateAPIImage } from "../modules/providers/image-api";
import { readImageAPI } from "../modules/providers/image-api-settings";
import { POST, GET } from "../app/api/image/providers/route";
import { NextRequest } from "next/server";
import { settingsSchema } from "../modules/project/validation";
import { defaults } from "../modules/project/types";

function isolate(t: test.TestContext) {
  const keys = ["IMAGE_API_CONFIG_DIR", "IMAGE_API_KEY", "OPENAI_API_KEY", "OPENAI_IMAGE_MODEL", "IMAGE_MODEL", "GEMINI_API_KEY", "GEMINI_IMAGE_MODEL", "STABILITY_API_KEY", "STABILITY_IMAGE_MODEL"];
  const old = keys.map(key => process.env[key]);
  keys.forEach(key => delete process.env[key]);
  const dir = mkdtempSync(path.join(os.tmpdir(), "storyflow-connect-"));
  process.env.IMAGE_API_CONFIG_DIR = dir;
  t.after(() => {
    keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
    rmSync(dir, { recursive: true, force: true });
  });
}
function req(body: object, origin = "http://localhost:3000") {
  return new NextRequest("http://localhost:3000/api/image/providers", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
}

test("OpenAI connection filters text models, persists key locally and exposes only metadata", async t => {
  isolate(t);
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.openai.com/v1/models");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer private-test-key");
    return Response.json({ data: [{ id: "gpt-4o" }, { id: "gpt-image-1" }, { id: "gpt-image-2" }, { id: "dall-e-3" }] });
  });
  const result = await POST(req({ action: "connect", provider: "openai", key: "private-test-key" }));
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.deepEqual(data.models.map((item: { id: string }) => item.id), ["gpt-image-1", "gpt-image-2"]);
  assert.ok(!JSON.stringify(data).includes("private-test-key"));
  assert.equal(readImageAPI("openai")?.key, "private-test-key");
  const publicData = await (await GET()).json();
  assert.ok(!JSON.stringify(publicData).includes("private-test-key"));
  assert.equal(publicData.providers.openai.connected, true);
  assert.equal(result.headers.get("cache-control"), "no-store");
  const selected = await POST(req({ action: "select", provider: "openai", model: "gpt-image-2" }));
  assert.equal(selected.status, 200);
  assert.equal(imageConfig("openai").model, "gpt-image-2");
  const workerResult = execFileSync(process.execPath, ["--import", "tsx", "-e", "const {imageConfig}=require('./modules/providers/image-api');const c=imageConfig('openai');console.log(JSON.stringify({model:c.model,hasKey:!!c.key}))"], { env: process.env, windowsHide: true, encoding: "utf8" });
  assert.deepEqual(JSON.parse(workerResult), { model: "gpt-image-2", hasKey: true });
});

test("Gemini fetches every catalog page and excludes text and retired Imagen models", async t => {
  isolate(t);
  const called: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    called.push(url);
    assert.equal(new Headers(init.headers).get("x-goog-api-key"), "gemini-private");
    assert.ok(!url.includes("gemini-private"));
    return Response.json(called.length === 1
      ? { models: [{ name: "models/gemini-3.6-flash" }, { name: "models/imagen-4.0-generate-001" }], nextPageToken: "page-two" }
      : { models: [{ name: "models/gemini-3.1-flash-image", displayName: "Nano Banana 2" }] });
  });
  const result = await connectImageAPI("gemini", "gemini-private");
  assert.equal(called.length, 2);
  assert.match(called[1], /pageToken=page-two/);
  assert.deepEqual(result.models, [{ id: "gemini-3.1-flash-image", label: "Nano Banana 2" }]);
  assert.equal(result.catalogSource, "api");
});

test("Stability validates account key and labels its supported endpoint catalog", async t => {
  isolate(t);
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, "https://api.stability.ai/v1/user/account");
    return Response.json({ email: "private@example.com" });
  });
  const result = await connectImageAPI("stability", "stability-private");
  assert.equal(result.catalogSource, "stability-endpoints");
  assert.equal(result.models.length, 2);
  assert.ok(!JSON.stringify(result).includes("private@example.com"));
  selectImageModel("stability", "ultra");
  assert.equal(imageConfig("stability").model, "ultra");
});

test("bad new key does not overwrite saved connection; rechecking a revoked saved key clears connected status", async t => {
  isolate(t);
  let valid = true;
  t.mock.method(globalThis, "fetch", async () => valid ? Response.json({ data: [{ id: "gpt-image-1" }] }) : new Response("secret-key-echo", { status: 401 }));
  await connectImageAPI("openai", "good-key");
  valid = false;
  await assert.rejects(connectImageAPI("openai", "bad-key"), /HTTP 401/);
  assert.equal(readImageAPI("openai")?.key, "good-key");
  assert.equal(imageAPIStatus().openai.connected, true);
  await assert.rejects(connectImageAPI("openai"), error => !String(error).includes("secret-key-echo"));
  assert.equal(imageAPIStatus().openai.connected, false);
});

test("connection and model endpoints reject cross-origin, unknown providers and unlisted models", async t => {
  isolate(t);
  const mocked = t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: "gpt-image-1" }] }));
  assert.equal((await POST(req({ action: "connect", provider: "openai", key: "test" }, "https://evil.example"))).status, 403);
  assert.equal(mocked.mock.callCount(), 0);
  assert.equal((await POST(req({ action: "connect", provider: "unknown", key: "test" }))).status, 400);
  await connectImageAPI("openai", "test-key");
  assert.throws(() => selectImageModel("openai", "gpt-4o"), /không thuộc danh sách/);
  assert.equal(imageConfig("openai").model, "gpt-image-1");
});

test("chosen project model reaches generation even when the provider default changes", async t => {
  isolate(t);
  process.env.OPENAI_API_KEY = "env-key";
  process.env.OPENAI_IMAGE_MODEL = "gpt-image-1";
  const settings = settingsSchema.parse({ ...defaults, imageProvider: "openai", imageModel: "gpt-image-2" });
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.equal(JSON.parse(String(init.body)).model, "gpt-image-2");
    return Response.json({ data: [{ b64_json: "YWJj" }] });
  });
  assert.equal((await generateAPIImage(settings.imageProvider, "scene", "16:9", 0, settings.imageModel)).model, "gpt-image-2");
});

test("empty or malformed catalogs never silently substitute a hardcoded image model", async t => {
  isolate(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: "gpt-4o" }] }));
  await assert.rejects(fetchImageModels("openai", "test"), /không trả về model tạo ảnh/);
  assert.equal(readImageAPI("openai"), undefined);
});
