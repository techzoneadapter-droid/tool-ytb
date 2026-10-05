import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { createServer } from "node:http";
import sharp from "sharp";
import { defaults, type Project, type Job } from "../modules/project/types";
import { processChapterImages } from "../modules/pipeline/chapter-images";
import { safeTTSErrorBody } from "../modules/tts/errors";

test("disabled images skip character bible, analysis, portraits and generation even if invoked directly", async () => {
  const p: Project = {
    id: randomUUID(),
    name: "shared",
    createdAt: "",
    chapters: [{ id: randomUUID(), title: "", text: "", scenes: [] }],
    settings: { ...defaults, imageEnabled: false },
  };
  let calls = 0;
  assert.deepEqual(
    await processChapterImages(p, p.chapters, p.settings, {
      save: () => {
        calls++;
      },
      generate: async () => {
        calls++;
        throw Error("image generation must be skipped");
      },
      legacy: async () => {
        calls++;
        throw Error("Flow must be skipped");
      },
    }),
    [],
  );
  assert.equal(calls, 0);
  assert.equal(p.characterBible, undefined);
  assert.equal(p.chapters[0].imageAnalysis, undefined);
  assert.ok(
    !safeTTSErrorBody("token=fixture-secret").includes("fixture-secret"),
  );
});

test(
  "shared-image real worker: TTS diagnostics, failed-scene retry, zero image/Flow calls and real FFmpeg",
  { timeout: 60000 },
  async (t) => {
    const repo = process.cwd(),
      workspace = await mkdtemp(path.join(tmpdir(), "storyflow-shared-"));
    const loader = pathToFileURL(
      path.join(repo, "node_modules/tsx/dist/loader.mjs"),
    ).href;
    const store = path.join(repo, "modules/project/store.ts");
    await mkdir(path.join(workspace, "data/assets"), { recursive: true });
    const fallback = randomUUID() + ".png",
      oldImage = randomUUID() + ".png";
    const png = await sharp({
      create: { width: 320, height: 180, channels: 3, background: "purple" },
    })
      .png()
      .toBuffer();
    for (const name of [fallback, oldImage])
      await writeFile(path.join(workspace, "data/assets", name), png);
    const wavFile = path.join(workspace, "speech.wav");
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-t",
        "0.2",
        wavFile,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    const wav = await readFile(wavFile);
    let broken = true,
      imageCalls = 0,
      flowCalls = 0;
    const calls = new Map<string, number>();
    const server = createServer(async (req, res) => {
      if (req.url === "/health") {
        res.end(
          JSON.stringify({ status: "ok", backend: "onnx", max_streams: 2 }),
        );
        return;
      }
      if (req.url === "/v1/voices") {
        res.end(
          JSON.stringify({
            data: [{ id: "fixture-voice", name: "fixture-voice" }],
          }),
        );
        return;
      }
      const buffers: Buffer[] = [];
      for await (const chunk of req) buffers.push(Buffer.from(chunk));
      if (req.url === "/v1/audio/speech") {
        const body = JSON.parse(Buffer.concat(buffers).toString());
        assert.equal(body.max_chars, 512);
        assert.ok(body.input.length <= 512);
        calls.set(body.input, (calls.get(body.input) || 0) + 1);
        if (broken && body.input.includes("Failed")) {
          res.writeHead(503);
          res.end(
            JSON.stringify({
              error: {
                message: "fixture engine overloaded token=fixture-secret",
              },
            }),
          );
          return;
        }
        res.setHeader("Content-Type", "audio/wav");
        res.end(wav);
        return;
      }
      if (req.url?.includes("image")) imageCalls++;
      else flowCalls++;
      res.writeHead(500);
      res.end("unexpected generation call");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const env = {
      ...process.env,
      VIENEU_LOCAL_URL: url,
      API_IMAGE_BASE_URL: url,
      API_IMAGE_KEY: "fixture",
      API_IMAGE_MODEL: "fixture-image",
      IMAGE_API_CONFIG_DIR: path.join(workspace, "keys"),
      TSX_TSCONFIG_PATH: path.join(repo, "tsconfig.json"),
    };
    const cli = (code: string) =>
      execFileSync(
        process.execPath,
        [
          "--import",
          loader,
          "-e",
          `const s=require(${JSON.stringify(store)});${code}`,
        ],
        {
          cwd: workspace,
          env,
          windowsHide: true,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    const p: Project = {
      id: randomUUID(),
      name: "shared",
      createdAt: new Date().toISOString(),
      settings: {
        ...defaults,
        imageEnabled: false,
        imageProvider: "flow-browser",
        fallbackImage: fallback,
        ttsProvider: "vieneu-local",
        voice: "fixture-voice",
        burnSubtitles: false,
        pause: 0,
      },
      chapters: [
        {
          id: randomUUID(),
          title: "Chapter",
          text: "Successful speech. Failed speech.",
          scenes: ["Successful speech.", "Failed speech."].map((text) => ({
            id: randomUUID(),
            text,
            prompt: "old image prompt",
            duration: 1,
            approved: false,
            image: oldImage,
            imageSource: "upload",
          })),
        },
      ],
    };
    const j: Job = {
      id: randomUUID(),
      projectId: p.id,
      chapterIds: [p.chapters[0].id],
      kind: "pipeline",
      outputMode: "separate",
      status: "queued",
      progress: 0,
      message: "",
      createdAt: p.createdAt,
      snapshot: { settings: p.settings },
    };
    cli(
      `s.put('project',${JSON.stringify(p)});s.put('job',${JSON.stringify(j)});`,
    );
    const worker = spawn(
      process.execPath,
      ["--import", loader, path.join(repo, "scripts/worker.ts")],
      {
        cwd: workspace,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let logs = "";
    worker.stdout.on("data", (chunk) => (logs += chunk));
    worker.stderr.on("data", (chunk) => (logs += chunk));
    async function finished() {
      const start = Date.now();
      while (true) {
        const snapshot = JSON.parse(
          cli(
            `console.log(JSON.stringify({job:s.get('${j.id}','job'),project:s.get('${p.id}','project')}));`,
          ),
        ) as { job: Job; project: Project };
        if (["error", "done"].includes(snapshot.job.status)) return snapshot;
        if (Date.now() - start > 30000 || worker.exitCode !== null)
          throw Error("worker timeout " + logs);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    try {
      const failed = await finished();
      assert.equal(failed.job.status, "error");
      assert.match(
        failed.job.error!,
        /TTS_ERROR.*VieNeu Local.*voice=fixture-voice.*textLength=.*chunk=1\/1.*HTTP 503/,
      );
      assert.match(failed.job.error!, /engine overloaded/);
      assert.ok(!failed.job.error!.includes("fixture-secret"));
      assert.equal(failed.job.sceneErrors?.length || 0, 0);
      assert.equal(failed.job.sharedImageValid, true);
      assert.equal(failed.project.characterBible, undefined);
      assert.equal(failed.project.chapters[0].visualProfile, undefined);
      assert.match(
        logs,
        /IMAGE_MODE=SHARED.*fallbackImage=.*imageGenerationSkipped=true/,
      );
      broken = false;
      // Exercise the actual retry route, including refreshing the project snapshot.
      cli(
        `const p=s.get('${p.id}','project');p.settings.speed=1.1;s.put('project',p); const {NextRequest}=require(${JSON.stringify(path.join(repo, "node_modules/next/server.js"))});require(${JSON.stringify(path.join(repo, "app/api/studio/route.ts"))}).POST(new NextRequest('http://localhost/api/studio',{method:'POST',body:JSON.stringify({action:'retry',id:'${j.id}'})})).then(async r=>{if(!r.ok)throw Error(await r.text());});`,
      );
      const done = await finished();
      assert.equal(done.job.status, "done", done.job.error);
      assert.equal(done.job.snapshot.settings.speed, 1.1);
      assert.equal(calls.get("Successful speech."), 1);
      assert.equal(calls.get("Failed speech."), 4);
      assert.equal(imageCalls, 0);
      assert.equal(flowCalls, 0);
      assert.equal(done.project.characterBible, undefined);
      const resolved = JSON.parse(
        cli(
          `const m=require(${JSON.stringify(path.join(repo, "modules/project/media.ts"))});Promise.all(s.get('${p.id}','project').chapters[0].scenes.map(scene=>m.resolveSceneImage(scene,s.get('${p.id}','project').settings))).then(ids=>console.log(JSON.stringify(ids)));`,
        ),
      );
      assert.deepEqual(resolved, [fallback, fallback]);
      assert.ok(
        (await readFile(path.join(workspace, "data/assets", done.job.output!)))
          .length > 1000,
      );
    } finally {
      worker.kill();
      if (worker.exitCode === null) await once(worker, "exit");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
