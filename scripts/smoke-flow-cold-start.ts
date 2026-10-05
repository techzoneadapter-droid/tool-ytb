import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, unlink, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { alive, startService, stopFlowService, FLOW_PROTOCOL, serviceURL, flowTimeout } from "../modules/providers/services";
import { flowHealth, waitForFlowSession } from "../modules/providers/flow-browser";
import { smokeFlowScene } from "./smoke-flow-scene";

let evidence: Record<string, unknown> = {};

async function main() {
  assert.ok(existsSync(path.resolve(process.env.FLOW_COOKIES_FILE || "cookies.json")), "cookies.json is required");
  const saved = JSON.parse(await readFile(path.resolve(process.env.FLOW_SESSION_FILE || "data/flow-session.json"), "utf8"));
  const project = new URL(saved.projectUrl);
  assert.ok(project.protocol === "https:" && ["labs.google", "flow.google.com"].includes(project.hostname) && /\/project\/[^/]+/.test(project.pathname), "Saved Flow project is required");
  await stopFlowService();
  for (const file of ["data/flow.service.pid", "data/flow.start.lock"]) {
    if (await alive(path.resolve(file))) throw Error(`Live owner still holds ${file}`);
    await unlink(path.resolve(file)).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  const deadline = Date.now() + 10000;
  while ((await flowHealth()).bridgeReady && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  try {
    await fetch(new URL("/health", serviceURL("flow")), { signal: AbortSignal.timeout(500) });
    throw Error("Cold-start requires a stopped worker and an inactive port");
  } catch (error) {
    if (!(error instanceof TypeError) && (error as Error).name !== "TimeoutError") throw error;
  }
  const started = performance.now();
  // Concurrent callers must share the same startup and PID.
  await Promise.all([startService("flow"), startService("flow")]);
  const bridgeMs = Math.round(performance.now() - started);
  const health = await flowHealth();
  assert.equal(health.bridgeReady, true);
  assert.equal(health.protocol, FLOW_PROTOCOL);
  assert.equal(health.connectionMode, "python-headless-cookies");
  assert.equal(health.backgroundRestore, true);
  assert.equal(health.generationReady, false, "Health must be available before restore completes");
  assert.ok(["restoring", "starting"].includes(health.state || ""));
  assert.ok(bridgeMs < flowTimeout("FLOW_START_TIMEOUT_MS", 15000));
  evidence = { workerStoppedBeforeTest: true, bridgeMs, protocol: health.protocol, healthBeforeRestore: true, state: health.state };
  process.stdout.write(JSON.stringify({ workerStoppedBeforeTest: true, bridgeMs, state: health.state, generationReady: health.generationReady }) + "\n");
  await waitForFlowSession(stage => process.stdout.write(JSON.stringify({ stage }) + "\n"));
  const readyMs = Math.round(performance.now() - started);
  const result = await smokeFlowScene();
  await mkdir(path.resolve("data/flow-debug"), { recursive: true });
  const report = { ...result, workerStoppedBeforeTest: true, bridgeMs, readyMs, protocol: health.protocol, healthBeforeRestore: true };
  await writeFile(path.resolve("data/flow-debug/cold-start-verification.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + "\n");
}
main().catch(async error => {
  const report = { ...evidence, ok: false, code: error.code || "FLOW_COLD_START_FAILED", stage: error.stage, message: error.message };
  await mkdir(path.resolve("data/flow-debug"), { recursive: true });
  await writeFile(path.resolve("data/flow-debug/cold-start-verification.json"), JSON.stringify(report, null, 2));
  process.stderr.write(JSON.stringify(report) + "\n");
  process.exitCode = 1;
});
