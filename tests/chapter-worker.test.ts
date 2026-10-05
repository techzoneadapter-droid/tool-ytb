import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import {
  defaults,
  type Project,
  type Job,
  type VideoRecord,
} from "../modules/project/types";

test(
  "real worker isolates chapter errors, merges concurrent portraits, publishes each MP4 immediately and retries only failed images",
  { timeout: 60000 },
  async (t) => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "storyflow-chapter-worker-"),
    );
    const repo = process.cwd();
    const storeModule = path.join(repo, "modules/project/store.ts");
    const tsxLoader = pathToFileURL(
      path.join(repo, "node_modules/tsx/dist/loader.mjs"),
    ).href;
    const bytes = await sharp({
      create: { width: 640, height: 360, channels: 3, background: "#779944" },
    })
      .png()
      .toBuffer();
    let fail = true;
    let portraits = 0;
    const masters = new Map<string, number>();
    const referencePayloads: Buffer[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const json = req.headers["content-type"]?.includes("application/json")
        ? JSON.parse(raw.toString())
        : undefined;
      const prompt = json?.prompt || raw.toString();
      if (prompt.includes("Canonical character reference portrait"))
        portraits++;
      else {
        const title = /Chapter [123]/.exec(prompt)?.[0] || "unknown";
        masters.set(title, (masters.get(title) || 0) + 1);
        referencePayloads.push(raw);
        if (fail && title === "Chapter 1") {
          res.writeHead(400);
          res.end("private-upstream-echo");
          return;
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const address = server.address() as { port: number };
    const env = {
      ...process.env,
      API_IMAGE_KEY: "fixture-private-key",
      API_IMAGE_MODEL: "fixture-image",
      API_IMAGE_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      IMAGE_API_CONFIG_DIR: path.join(workspace, "image-api"),
      MAX_PARALLEL_VIDEOS: "2",
    };
    const cli = (code: string, extra: Record<string, string> = {}) =>
      execFileSync(
        process.execPath,
        [
          "--import",
          tsxLoader,
          "-e",
          `const s=require(${JSON.stringify(storeModule)});${code}`,
        ],
        {
          cwd: workspace,
          env: { ...env, ...extra },
          windowsHide: true,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    const project: Project = {
      id: randomUUID(),
      name: "worker fixture",
      createdAt: new Date().toISOString(),
      settings: {
        ...defaults,
        audioEnabled: false,
        imageEnabled: true,
        burnSubtitles: true,
        imageProvider: "api-compatible",
        imageModel: "fixture-image",
        imageAPIOptions: {
          references: true,
          supportsReferenceImages: true,
          supportsMultiImageInput: true,
          retries: 0,
          concurrency: 1,
        },
      },
      chapters: [1, 2, 3].map((index) => ({
        id: randomUUID(),
        title: `Chapter ${index}`,
        text: "Lâm Hạo 24 tuổi, tóc đen ngắn, mặc áo đen. Lâm Hạo cầm kiếm đứng trong rừng ban đêm.",
        scenes: [0, 1, 2].map(() => ({
          id: randomUUID(),
          text: "Lâm Hạo đi trong rừng.",
          prompt: "fixture",
          duration: 0.3,
          approved: false,
        })),
      })),
    };
    const jobs = project.chapters.map((chapter) => ({
      id: randomUUID(),
      projectId: project.id,
      chapterIds: [chapter.id],
      status: "queued",
      kind: "pipeline",
      outputMode: "separate",
      progress: 0,
      createdAt: new Date().toISOString(),
      message: "fixture",
      snapshot: { settings: project.settings },
    }));
    cli(
      "const f=JSON.parse(process.env.FIXTURE_DATA);s.put('project',f.project);for(const j of f.jobs)s.put('job',j);",
      { FIXTURE_DATA: JSON.stringify({ project, jobs }) },
    );
    const worker = spawn(
      process.execPath,
      ["--import", tsxLoader, path.join(repo, "scripts/worker.ts")],
      {
        cwd: workspace,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let logs = "";
    worker.stdout.on("data", (chunk) => {
      logs = (logs + chunk).slice(-20000);
    });
    worker.stderr.on("data", (chunk) => {
      logs = (logs + chunk).slice(-20000);
    });
    const state = () =>
      JSON.parse(
        cli(
          "console.log(JSON.stringify({jobs:s.list('job'),videos:s.list('video'),project:s.list('project')[0]}));",
        ),
      ) as { jobs: Job[]; videos: VideoRecord[]; project: Project };
    async function waitFinished() {
      const started = Date.now();
      for (;;) {
        const snapshot = state();
        if (
          snapshot.jobs.every((job) => ["done", "error"].includes(job.status))
        )
          return snapshot;
        if (Date.now() - started > 30000 || worker.exitCode !== null)
          throw Error(
            `Worker did not finish: ${JSON.stringify(snapshot.jobs.map((job) => ({ status: job.status, message: job.message, error: job.error })))} ${logs}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    try {
      const first = await waitFinished();
      assert.equal(first.jobs.filter((job) => job.status === "done").length, 2);
      assert.equal(first.videos.length, 2);
      assert.equal(portraits, 1);
      assert.match(
        first.jobs.find((job) => job.status === "error")!.sceneErrors![0].code,
        /IMAGE_API_FAILED/,
      );
      assert.ok(!JSON.stringify(first.jobs).includes("private-upstream-echo"));
      for (const chapter of first.project.chapters.slice(1)) {
        assert.equal(
          new Set(chapter.scenes.map((scene) => scene.image)).size,
          1,
        );
        assert.equal(
          chapter.apiImage!.referenceFiles[0],
          first.project.characterBible!.characters[0].portrait!.file,
        );
      }
      const failedId = first.jobs.find((job) => job.status === "error")!.id;
      fail = false;
      cli(
        `s.updateJob(${JSON.stringify(failedId)},{status:'queued',error:undefined,completedItems:[]});`,
      );
      const second = await waitFinished();
      assert.equal(second.videos.length, 3);
      assert.equal(portraits, 1);
      assert.deepEqual([...masters.entries()].sort(), [
        ["Chapter 1", 2],
        ["Chapter 2", 1],
        ["Chapter 3", 1],
      ]);
      for (const payload of referencePayloads)
        assert.ok(
          payload.includes(bytes),
          "Each chapter edit receives the same canonical portrait bytes",
        );
      for (const video of second.videos)
        assert.ok(
          (await readFile(path.join(workspace, "data/assets", video.output)))
            .length > 1000,
        );
    } finally {
      worker.kill();
      if (worker.exitCode === null) await once(worker, "exit");
    }
  },
);
