import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import sharp from "sharp";
import { defaults, type Job, type Project } from "../modules/project/types";

// Isolated real worker/SQLite, real resident VieNeu engine and real FFmpeg.
// The user's queued/running jobs and media are never modified by this smoke test.
async function main() {
  const repo = process.cwd();
  const workspace = await mkdtemp(
    path.join(tmpdir(), "storyflow-live-vieneu-"),
  );
  await mkdir(path.join(workspace, "data/assets"), { recursive: true });
  const loader = pathToFileURL(
    path.join(repo, "node_modules/tsx/dist/loader.mjs"),
  ).href;
  const storeURL = pathToFileURL(
    path.join(repo, "modules/project/store.ts"),
  ).href;
  const runStore = (code: string) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          loader,
          "--input-type=module",
          "-e",
          `import {list,put} from ${JSON.stringify(storeURL)};${code}`,
        ],
        {
          cwd: workspace,
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ),
    );
  const fallback = randomUUID() + ".png";
  await writeFile(
    path.join(workspace, "data/assets", fallback),
    await sharp({
      create: { width: 1280, height: 720, channels: 3, background: "#6655aa" },
    })
      .png()
      .toBuffer(),
  );
  const voices = await fetch("http://127.0.0.1:8000/v1/voices").then((r) =>
    r.json(),
  );
  const voice =
    voices.data.find((v: { id: string }) => v.id === "ngoc_huyen")?.id ||
    voices.data[0]?.id;
  assert.ok(voice);
  const project: Project = {
    id: randomUUID(),
    name: "LIVE 5 chapter shared VieNeu",
    createdAt: new Date().toISOString(),
    settings: {
      ...defaults,
      imageEnabled: false,
      fallbackImage: fallback,
      audioEnabled: true,
      ttsProvider: "vieneu-local",
      voice,
      splitScenes: false,
      burnSubtitles: false,
      motionMode: "off",
      humanCheck: false,
      imageProvider: "flow-browser",
    },
    chapters: ["Lan", "Nam", "Mai", "An", "Bình"].map((name, i) => ({
      id: randomUUID(),
      title: `Chương ${i + 1}`,
      text: `Xin chào ${name}.`,
      scenes: [
        {
          id: randomUUID(),
          text: `Xin chào ${name}.`,
          prompt: "",
          duration: 3,
          approved: false,
        },
      ],
    })),
  };
  const jobs: Job[] = project.chapters.map((c, i) => ({
    id: randomUUID(),
    projectId: project.id,
    chapterIds: [c.id],
    kind: "pipeline",
    status: "queued",
    progress: 0,
    message: "",
    createdAt: project.createdAt,
    batchId: project.id,
    batchIndex: i,
    batchTotal: 5,
    snapshot: { settings: project.settings },
  }));
  runStore(
    `put("project",${JSON.stringify(project)});for(const j of ${JSON.stringify(jobs)})put("job",j);console.log("null");`,
  );
  const log = path.join(workspace, "live.log");
  const { openSync, closeSync } = await import("node:fs");
  const fd = openSync(log, "a");
  const worker = spawn(
    process.execPath,
    ["--import", loader, path.join(repo, "scripts/worker.ts")],
    {
      cwd: workspace,
      env: {
        ...process.env,
        VIENEU_LOCAL_URL: "http://127.0.0.1:8000",
        MAX_PARALLEL_VIDEOS: "5",
      },
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    },
  );
  closeSync(fd);
  let peak = 0,
    peakStreams = 0;
  const completed = new Set<string>();
  const deadline = Date.now() + 15 * 60 * 1000;
  console.log(
    JSON.stringify({
      workspace,
      projectId: project.id,
      engine: "real VieNeu",
      chapters: 5,
    }),
  );
  try {
    while (Date.now() < deadline) {
      const data = runStore(
        'console.log(JSON.stringify({jobs:list("job"),videos:list("video"),projects:list("project")}));',
      );
      peak = Math.max(
        peak,
        data.jobs.filter((j: Job) =>
          ["audio", "images", "rendering"].includes(j.status),
        ).length,
      );
      peakStreams = Math.max(
        peakStreams,
        data.jobs
          .flatMap((j: Job) => Object.values(j.ttsRequests || {}))
          .filter((r: { state: string }) => r.state === "running").length,
      );
      for (const j of data.jobs as Job[]) {
        if (j.status === "error") throw Error(j.error);
        if (j.status === "done" && !completed.has(j.id)) {
          assert.equal(j.imageMode, "shared");
          assert.equal(j.sharedImageValid, true);
          assert.ok(
            data.videos.some(
              (v: { sourceJobId: string }) => v.sourceJobId === j.id,
            ),
            "MP4 must be in Library immediately",
          );
          const probe = JSON.parse(
            execFileSync(
              "ffprobe",
              [
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                path.join(workspace, "data/assets", j.output!),
              ],
              { encoding: "utf8", windowsHide: true },
            ),
          );
          assert.ok(
            probe.streams.some(
              (s: { codec_type: string }) => s.codec_type === "audio",
            ),
          );
          assert.ok(Number(probe.format.duration) > 0);
          completed.add(j.id);
          console.log(
            JSON.stringify({
              completed: completed.size,
              jobId: j.id,
              output: j.output,
              activePeak: peak,
            }),
          );
        }
      }
      if (completed.size === 5) {
        assert.ok(peak >= 2);
        const p = data.projects[0];
        assert.equal(p.characterBible, undefined);
        assert.ok(
          p.chapters.every(
            (c: {
              apiImage?: unknown;
              masterImage?: unknown;
              visualProfile?: unknown;
            }) => !c.apiImage && !c.masterImage && !c.visualProfile,
          ),
        );
        const logs = await readFile(log, "utf8");
        assert.equal((logs.match(/IMAGE_MODE=SHARED/g) || []).length, 5);
        const result = {
          passed: true,
          workspace,
          chapters: 5,
          completed: 5,
          activeJobsPeak: peak,
          ttsStreamsPeak: peakStreams,
          imageGenerationSkipped: true,
          libraryImmediate: true,
        };
        await mkdir(path.join(repo, "test-results"), { recursive: true });
        await writeFile(
          path.join(repo, "test-results/adaptive-vieneu-live.json"),
          JSON.stringify(result, null, 2),
        );
        console.log(JSON.stringify(result));
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    assert.equal(completed.size, 5, "Live VieNeu test exceeded deadline");
  } finally {
    worker.kill();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
