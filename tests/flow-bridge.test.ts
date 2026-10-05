import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateWithFlow, waitForFlowSession } from "../modules/providers/flow-browser";
import { startService, FLOW_PROTOCOL } from "../modules/providers/services";

test("bridge receives raw image bytes and preserves structured Flow errors", async () => {
  const saved = process.env.FLOW_BRIDGE_URL;
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  let fail = false;
  const server = createServer((request, response) => {
    request.resume();
    if (request.url === "/health") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          status: "ok",
          engine: "flow",
          protocol: FLOW_PROTOCOL,
          bridgeReady: true,
          backgroundRestore: true,
          generationReady: true,
          connectionMode: "python-headless-cookies",
        }),
      );
    } else if (fail) {
      response.writeHead(409, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          code: "FLOW_SUBMIT_FAILED",
          stage: "FLOW_GENERATION_START",
          error: "The prompt was not sent",
        }),
      );
    } else {
      response.writeHead(200, {
        "Content-Type": "image/png",
        "X-StoryFlow-Model": "project-current",
      });
      response.end(image);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  process.env.FLOW_BRIDGE_URL = `http://127.0.0.1:${address.port}`;
  try {
    const result = await generateWithFlow("fixture", "16:9");
    assert.ok(Buffer.isBuffer(result.bytes));
    assert.deepEqual(result.bytes, image);
    fail = true;
    await assert.rejects(generateWithFlow("fixture", "16:9"), (error) => {
      assert.equal((error as { code: string }).code, "FLOW_SUBMIT_FAILED");
      assert.equal((error as { stage: string }).stage, "FLOW_GENERATION_START");
      assert.match((error as Error).message, /The prompt was not sent/);
      return true;
    });
  } finally {
    if (saved === undefined) delete process.env.FLOW_BRIDGE_URL;
    else process.env.FLOW_BRIDGE_URL = saved;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("service readiness precedes session readiness and restore errors retain their code", async () => {
  const previousURL = process.env.FLOW_BRIDGE_URL;
  const previousTimeout = process.env.FLOW_RESTORE_TIMEOUT_MS;
  let state = "restoring";
  let generateCalls = 0;
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/health") response.end(JSON.stringify({ status: "ok", engine: "flow", protocol: FLOW_PROTOCOL,
      connectionMode: "python-headless-cookies", bridgeReady: true, backgroundRestore: true,
      generationReady: state === "ready", state, lastStage: "FLOW_SESSION_RESTORE",
      lastErrorCode: state === "login_required" ? "FLOW_COOKIE_EXPIRED" : undefined,
      lastError: state === "login_required" ? "Expired test cookie" : undefined,
    }));
    else { generateCalls++; response.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.FLOW_BRIDGE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.FLOW_RESTORE_TIMEOUT_MS = "1500";
  try {
    const start = Date.now();
    await Promise.all([startService("flow"), startService("flow")]);
    assert.ok(Date.now() - start < 500, "startService must not wait for Chrome/session");
    const stages: string[] = [];
    const timer = setTimeout(() => { state = "ready"; }, 300);
    try { assert.equal((await waitForFlowSession(stage => stages.push(stage))).generationReady, true); }
    finally { clearTimeout(timer); }
    assert.ok(stages.includes("FLOW_SESSION_RESTORE"));
    state = "login_required";
    await assert.rejects(generateWithFlow("must not submit", "16:9"), (error: any) => {
      assert.equal(error.code, "FLOW_COOKIE_EXPIRED");
      assert.equal(error.stage, "FLOW_SESSION_RESTORE");
      return true;
    });
    assert.equal(generateCalls, 0);
    state = "restoring";
    process.env.FLOW_RESTORE_TIMEOUT_MS = "100";
    await assert.rejects(waitForFlowSession(), (error: any) => error.code === "FLOW_SESSION_RESTORE_FAILED");
  } finally {
    if (previousURL === undefined) delete process.env.FLOW_BRIDGE_URL; else process.env.FLOW_BRIDGE_URL = previousURL;
    if (previousTimeout === undefined) delete process.env.FLOW_RESTORE_TIMEOUT_MS; else process.env.FLOW_RESTORE_TIMEOUT_MS = previousTimeout;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("missing Flow executable removes stale PID/lock and reports a service startup error", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "storyflow-flow-start-"));
  const previousCwd = process.cwd();
  const previousPython = process.env.FLOW_PYTHON;
  const previousURL = process.env.FLOW_BRIDGE_URL;
  try {
    process.chdir(directory);
    await mkdir("data");
    await writeFile("data/flow.service.pid", "2147483647");
    await writeFile("data/flow.start.lock", "2147483647");
    process.env.FLOW_PYTHON = path.join(directory, "missing-python.exe");
    process.env.FLOW_BRIDGE_URL = "http://127.0.0.1:1";
    await assert.rejects(startService("flow"), (error: any) => {
      assert.equal(error.code, "FLOW_SERVICE_START_FAILED");
      assert.equal(error.stage, "FLOW_SERVICE_START");
      return true;
    });
    await assert.rejects(readFile("data/flow.service.pid"));
    await assert.rejects(readFile("data/flow.start.lock"));
    await writeFile("data/flow.start.lock", "");
    const old = new Date(Date.now() - 60000);
    await utimes("data/flow.start.lock", old, old);
    await assert.rejects(startService("flow"), (error: any) => error.code === "FLOW_SERVICE_START_FAILED");
    await assert.rejects(readFile("data/flow.start.lock"));
  } finally {
    process.chdir(previousCwd);
    if (previousPython === undefined) delete process.env.FLOW_PYTHON; else process.env.FLOW_PYTHON = previousPython;
    if (previousURL === undefined) delete process.env.FLOW_BRIDGE_URL; else process.env.FLOW_BRIDGE_URL = previousURL;
    if (!directory.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(directory).startsWith("storyflow-flow-start-")) throw Error("Unexpected cleanup path");
    await rm(directory, { recursive: true, force: true });
  }
});

test("service upgrade preserves a legacy authenticated RAM session if cookies are not saved", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "storyflow-flow-upgrade-"),
  );
  const previousCwd = process.cwd();
  const previousURL = process.env.FLOW_BRIDGE_URL;
  const previousCookieFile = process.env.FLOW_COOKIES_FILE;
  // This deliberately nonexistent PID can never refer to a user's process.
  const fakePid = 2147483647;
  assert.throws(() => process.kill(fakePid, 0));
  const originalKill = process.kill.bind(process);
  const kill = mock.method(process, "kill", ((
    pid: number,
    signal?: string | number,
  ) =>
    pid === fakePid && signal === 0
      ? true
      : originalKill(pid, signal)) as typeof process.kill);
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        status: "ok",
        engine: "flow",
        protocol: 16,
        connected: true,
        connectionMode: "python-headless-cookies",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    process.chdir(directory);
    await mkdir("data");
    await writeFile("data/flow.service.pid", String(fakePid));
    process.env.FLOW_COOKIES_FILE = path.join(directory, "absent-cookies.json");
    process.env.FLOW_BRIDGE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await assert.rejects(startService("flow"), (error) => {
      assert.equal((error as { code: string }).code, "FLOW_LOGIN_REQUIRED");
      assert.equal((error as { stage: string }).stage, "FLOW_SESSION_RESTORE");
      return true;
    });
    assert.equal(
      await readFile("data/flow.service.pid", "utf8"),
      String(fakePid),
    );
    assert.ok(kill.mock.calls.every((call) => call.arguments[1] === 0));
  } finally {
    kill.mock.restore();
    process.chdir(previousCwd);
    if (previousURL === undefined) delete process.env.FLOW_BRIDGE_URL;
    else process.env.FLOW_BRIDGE_URL = previousURL;
    if (previousCookieFile === undefined) delete process.env.FLOW_COOKIES_FILE;
    else process.env.FLOW_COOKIES_FILE = previousCookieFile;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const target = path.resolve(directory);
    if (
      !target.startsWith(path.resolve(tmpdir()) + path.sep) ||
      !path.basename(target).startsWith("storyflow-flow-upgrade-")
    )
      throw Error("Unexpected cleanup path");
    await rm(target, { recursive: true, force: true });
  }
});
