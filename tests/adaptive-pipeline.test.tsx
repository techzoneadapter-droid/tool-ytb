import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  cleanNarrationText,
  parseChapters,
  chunks,
} from "../modules/project/parser";
import {
  ResourceLimiter,
  withResource,
  resourceGate,
  ffmpegConcurrency,
  pipelineConcurrency,
} from "../modules/pipeline/resources";
import { fetchTTSChunk } from "../modules/tts/request";
import { speakLocal } from "../modules/tts/local";
import { PipelineProgress } from "../app/components/video/PipelineProgress";
import {
  defaults,
  type Job,
  type Project,
  type TTSRequestProgress,
} from "../modules/project/types";

const cases = [
  [
    "**Lâm Phong** bước vào @động phủ #bí_mật!!!",
    "Lâm Phong bước vào động phủ bí mật!",
  ],
  ["***tiếng Việt***", "tiếng Việt"],
  ["`lời đọc`", "lời đọc"],
  ["~~cũ~~", "cũ"],
  ["<b>Xin chào</b>", "Xin chào"],
  ["[người](https://example.com)", "người"],
  ["Xin https://example.com chào", "Xin chào"],
  ["Xin a@example.com chào", "Xin chào"],
  ["- một\n* hai", "một\nhai"],
  ["> Lời nói", "Lời nói"],
  ["{a} [b] | c", "a b c"],
  ["😊 Xin ⭐ chào", "Xin chào"],
  ["a\u200Bb", "ab"],
  ["tiếng Việt", "tiếng Việt"],
  ["Số 123, đúng?", "Số 123, đúng?"],
  ["###Chương 10", "Chương 10"],
  ["a!!! b???", "a! b?"],
  ["(a) — b – c - d", "(a) — b – c - d"],
  ["<script>secret</script>Xin", "Xin"],
  ["a\r\nb", "a\nb"],
];
for (const [input, expected] of cases)
  test("narration sanitizes " + JSON.stringify(input), () =>
    assert.equal(cleanNarrationText(input), expected),
  );
test("markdown chapter headings survive import and are excluded from narration chunks", () => {
  const chapters = parseChapters(
    "###Chương 10: **Tên**\nLời một.\n## Chương 11\nLời hai.",
  );
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, "Chương 10: Tên");
  assert.deepEqual(
    chapters.map((c) => chunks(c.text).join(" ")),
    ["Lời một.", "Lời hai."],
  );
});
test("51 chapters mount no detail rows by default and shared mode hides all image generation stages", () => {
  const project: Project = {
    id: "p",
    name: "test",
    createdAt: "",
    settings: { ...defaults, imageEnabled: false },
    chapters: Array.from({ length: 51 }, (_, i) => ({
      id: String(i),
      title: `Chương ${i}`,
      text: "",
      scenes: [],
    })),
  };
  const jobs: Job[] = project.chapters.map((c, i) => ({
    id: c.id,
    projectId: "p",
    chapterIds: [c.id],
    createdAt: "2026-01-01",
    status: i === 0 ? "audio" : "queued",
    progress: 0,
    message: "",
    batchId: "batch",
    batchIndex: i,
    batchTotal: 51,
    snapshot: { settings: project.settings },
    sharedImageValid: true,
  }));
  const render = (open = false) =>
    renderToStaticMarkup(
      <PipelineProgress
        project={project}
        jobs={jobs}
        busy={false}
        act={() => {}}
        initialDetailsOpen={open}
      />,
    );
  const html = render();
  assert.equal((html.match(/chapter-progress-row/g) || []).length, 0);
  assert.ok(html.includes("Ảnh: ✓ Dùng ảnh chung"));
  for (const word of ["Ảnh master", "Character Bible", "portrait", "gọi API"])
    assert.ok(!html.includes(word));
  assert.equal((render(true).match(/chapter-progress-row/g) || []).length, 51);
});
test("global gates cap simultaneous calls across jobs and release after errors", async () => {
  const key = "test:global";
  let peak = 0;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      withResource(key, 2, async () => {
        peak = Math.max(peak, resourceGate(key).active);
        await new Promise((r) => setTimeout(r, 3));
      }),
    ),
  );
  assert.equal(peak, 2);
  assert.equal(resourceGate(key).active, 0);
  await assert.rejects(
    withResource(key, 2, async () => {
      throw Error("failed");
    }),
  );
  assert.equal(resourceGate(key).active, 0);
});
test("cloud batches reserve their full size alongside individual API requests", async () => {
  const gate = new ResourceLimiter();
  const batch = await gate.acquire(4, undefined, 3);
  const individual = await gate.acquire(4);
  let acquired = false;
  const waiting = gate.acquire(4, undefined, 2).then((release) => {
    acquired = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(acquired, false);
  assert.equal(gate.active, 4);
  batch();
  const release = await waiting;
  assert.equal(gate.active, 3);
  individual();
  release();
  assert.equal(gate.active, 0);
  assert.equal(gate.peak, 4);
});
test("pipeline accepts more than four jobs while FFmpeg remains bounded by CPU and memory", () => {
  const prior = process.env.MAX_PARALLEL_VIDEOS;
  process.env.MAX_PARALLEL_VIDEOS = "12";
  assert.equal(pipelineConcurrency(8 * 1024 ** 3), 12);
  assert.equal(pipelineConcurrency(512 * 1024 ** 2), 2);
  if (prior === undefined) delete process.env.MAX_PARALLEL_VIDEOS;
  else process.env.MAX_PARALLEL_VIDEOS = prior;
  assert.equal(ffmpegConcurrency(1, 8 * 1024 ** 3), 1);
  assert.equal(ffmpegConcurrency(16, 8 * 1024 ** 3), 4);
  assert.equal(ffmpegConcurrency(16, 512 * 1024 ** 2), 1);
});
async function fixture(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const wav = Buffer.from("RIFF0000WAVE0000");
for (const body of [false, true])
  test(
    "watchdog aborts stalled " +
      (body ? "body" : "headers") +
      " and retries only twice",
    async (t) => {
      process.env.TTS_REQUEST_TIMEOUT_MS = "40";
      process.env.TTS_RETRY_BACKOFF_MS = "1,1";
      t.after(() => {
        delete process.env.TTS_REQUEST_TIMEOUT_MS;
        delete process.env.TTS_RETRY_BACKOFF_MS;
      });
      let count = 0;
      const events: TTSRequestProgress[] = [];
      const url = await fixture(t, (_, res) => {
        count++;
        if (body) {
          res.writeHead(200);
          res.write("RIFF");
        }
      });
      await assert.rejects(
        fetchTTSChunk(url, {}, "voice", "xin", 1, 2, {
          sceneId: "s",
          chapterId: "c",
          onRequestProgress: (e) => events.push(e),
        }),
        /TTS_ERROR.*chunk=1\/2.*chapter=c scene=s.*TIMEOUT/,
      );
      assert.equal(count, 3);
      assert.deepEqual(
        events.filter((e) => e.state === "retry").map((e) => e.attempt),
        [1, 2],
      );
      assert.equal(events.at(-1)?.state, "error");
    },
  );
test("watchdog retries HTTP failures then retains actual engine limit and safe context", async (t) => {
  process.env.TTS_RETRY_BACKOFF_MS = "1,1";
  t.after(() => delete process.env.TTS_RETRY_BACKOFF_MS);
  let count = 0;
  const events: TTSRequestProgress[] = [];
  const gate = new ResourceLimiter();
  const url = await fixture(t, (_, res) => {
    count++;
    res.statusCode = count < 3 ? 503 : 200;
    res.end(count < 3 ? '{"detail":"busy"}' : wav);
  });
  const bytes = await fetchTTSChunk(url, {}, "voice", "xin", 2, 3, {
    onRequestProgress: (e) => events.push(e),
    acquire: async (wait) => {
      wait(2);
      return gate.acquire(2);
    },
  });
  assert.deepEqual(bytes, wav);
  assert.equal(count, 3);
  assert.equal(gate.active, 0);
  assert.equal(events.at(-1)?.engineLimit, 2);
});
test("received bytes refresh the inactivity watchdog without inventing completed chunks", async (t) => {
  process.env.TTS_REQUEST_TIMEOUT_MS = "100";
  t.after(() => delete process.env.TTS_REQUEST_TIMEOUT_MS);
  const events: TTSRequestProgress[] = [];
  const url = await fixture(t, (_, res) => {
    res.writeHead(200);
    res.write(wav.subarray(0, 4));
    const a = setTimeout(() => res.write(wav.subarray(4, 8)), 60);
    const b = setTimeout(() => res.end(wav.subarray(8)), 120);
    res.on("close", () => {
      clearTimeout(a);
      clearTimeout(b);
    });
  });
  const bytes = await fetchTTSChunk(url, {}, "voice", "xin", 1, 1, {
    onRequestProgress: (e) => events.push(e),
  });
  assert.deepEqual(bytes, wav);
  assert.ok(events.filter((e) => e.state === "running").length >= 3);
  assert.equal(events.filter((e) => e.state === "done").length, 1);
  assert.equal(events.filter((e) => e.state === "retry").length, 0);
});
test(
  "separate chapter calls share VieNeu health.maxStreams and cached chunks survive reuse",
  { timeout: 60000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "storyflow-gate-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const audio = Buffer.alloc(44 + 2400);
    audio.write("RIFF");
    audio.writeUInt32LE(audio.length - 8, 4);
    audio.write("WAVEfmt ", 8);
    audio.writeUInt32LE(16, 16);
    audio.writeUInt16LE(1, 20);
    audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(24000, 24);
    audio.writeUInt32LE(48000, 28);
    audio.writeUInt16LE(2, 32);
    audio.writeUInt16LE(16, 34);
    audio.write("data", 36);
    audio.writeUInt32LE(2400, 40);
    let active = 0,
      peak = 0,
      calls = 0;
    const url = await fixture(t, (req, res) => {
      if (req.url === "/health") {
        res.end(
          JSON.stringify({
            status: "ok",
            backend: "onnx",
            max_streams: 2,
            active,
            waiting: 0,
          }),
        );
        return;
      }
      if (req.url === "/v1/voices") {
        res.end(JSON.stringify({ data: [{ id: "fixture", name: "fixture" }] }));
        return;
      }
      active++;
      calls++;
      peak = Math.max(peak, active);
      let ended = false;
      const finish = () => {
        if (!ended) {
          active--;
          ended = true;
        }
      };
      res.on("close", finish);
      setTimeout(() => {
        finish();
        res.end(audio);
      }, 70);
    });
    const old = process.env.VIENEU_LOCAL_URL;
    process.env.VIENEU_LOCAL_URL = url;
    t.after(() => {
      if (old === undefined) delete process.env.VIENEU_LOCAL_URL;
      else process.env.VIENEU_LOCAL_URL = old;
    });
    const settings = {
      ...defaults,
      ttsProvider: "vieneu-local" as const,
      voice: "fixture",
    };
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        speakLocal(`Xin chào ${i}.`, path.join(dir, `${i}.wav`), settings),
      ),
    );
    assert.equal(peak, 2);
    assert.equal(calls, 6);
    assert.equal(resourceGate("VieNeu").active, 0);
    await speakLocal("Xin chào 0.", path.join(dir, "reused.wav"), settings);
    assert.equal(calls, 6);
  },
);
