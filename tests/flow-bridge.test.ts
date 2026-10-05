import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateWithFlow } from "../modules/providers/flow-browser";
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
