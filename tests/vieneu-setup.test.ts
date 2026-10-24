import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { NextRequest } from "next/server";
import { POST } from "../app/api/tts/setup/route";
import { findEngineVoice } from "../modules/tts/catalog";
import { probeVieneuReady, vieneuReadyMessage } from "../modules/providers/vieneu-health";

test("VieNeu setup rejects cross-origin and unsupported actions before spawning installers", async () => {
  const cross = await POST(
    new NextRequest("http://localhost/api/tts/setup", {
      method: "POST",
      headers: { origin: "https://other.example" },
      body: JSON.stringify({ action: "install" }),
    }),
  );
  assert.equal(cross.status, 403);
  const invalid = await POST(
    new NextRequest("http://localhost/api/tts/setup", {
      method: "POST",
      body: JSON.stringify({ action: "remove" }),
    }),
  );
  assert.equal(invalid.status, 400);
});

test("managed VieNeu environment survives code updates and retains legacy/custom environment selection", () => {
  const repo = process.cwd();
  const directory = mkdtempSync(path.join(tmpdir(), "storyflow-vieneu-paths-"));
  const workspace = path.join(directory, "workspace");
  mkdirSync(workspace);
  try {
    const code = `
      const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
      const {vieneuPaths}=require(${JSON.stringify(path.join(repo, "modules/providers/vieneu-paths.ts"))});
      delete process.env.VIENEU_REPO_DIR;
      const managed=vieneuPaths();assert.equal(managed.managed,true);
      const legacy=path.resolve('..','VieNeu-TTS','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
      fs.mkdirSync(path.dirname(legacy),{recursive:true});fs.writeFileSync(legacy,'fixture');
      assert.equal(vieneuPaths().managed,false);
      fs.mkdirSync(path.dirname(managed.python),{recursive:true});fs.writeFileSync(managed.python,'fixture');
      process.env.STORYFLOW_CODE_ROOT='different-installation';
      assert.equal(vieneuPaths().python,managed.python);
      process.env.VIENEU_REPO_DIR=path.join(process.cwd(),'custom');
      assert.equal(vieneuPaths().directory,process.env.VIENEU_REPO_DIR);
    `;
    execFileSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(path.join(repo, "node_modules/tsx/dist/loader.mjs")).href,
        "-e",
        code,
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: path.join(repo, "tsconfig.json"),
        },
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Ngọc Huyền saved slug resolves to the actual VieNeu v3 Turbo voice ID", () => {
  const voices = [
    { id: "Hải Đăng", name: "Hải Đăng" },
    { id: "Ngọc Huyền", name: "Ngọc Huyền", aliases: ["ngoc-huyen"] },
  ];
  assert.equal(findEngineVoice(voices, "ngoc_huyen")?.id, "Ngọc Huyền");
  assert.equal(findEngineVoice(voices, "Ngọc Huyền")?.id, "Ngọc Huyền");
  assert.equal(findEngineVoice(voices, "NGOC-HUYEN")?.id, "Ngọc Huyền");
  assert.equal(findEngineVoice(voices, "nonexistent"), undefined);
});

test("already-running VieNeu with real Ngọc Huyền voice is reusable without reinstall", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (target: URL | string | Request) => {
    const path = new URL(String(target)).pathname;
    calls.push(path);
    const body =
      path === "/health"
        ? { status: "ok", backend: "onnx" }
        : {
            data: [
              { id: "Hải Đăng", name: "Hải Đăng" },
              { id: "Ngọc Huyền", aliases: ["ngoc-huyen"] },
            ],
          };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const live = await probeVieneuReady(fakeFetch);
  assert.deepEqual(live, { voiceId: "Ngọc Huyền", voiceCount: 2 });
  assert.ok(vieneuReadyMessage(live!).includes("Ngọc Huyền"));
  assert.deepEqual(calls.sort(), ["/health", "/v1/voices"]);
});

test("unhealthy VieNeu or a catalogue missing Ngọc Huyền must not be reported ready", async () => {
  const unhealthy = (async (target: URL | string | Request) =>
    new Response(
      JSON.stringify(
        new URL(String(target)).pathname === "/health"
          ? { status: "error" }
          : { data: [{ id: "Ngọc Huyền" }] },
      ),
      { status: 200 },
    )) as typeof fetch;
  assert.equal(await probeVieneuReady(unhealthy), null);

  const missingVoice = (async (target: URL | string | Request) =>
    new Response(
      JSON.stringify(
        new URL(String(target)).pathname === "/health"
          ? { status: "ok" }
          : { data: [{ id: "Hải Đăng" }] },
      ),
      { status: 200 },
    )) as typeof fetch;
  assert.equal(await probeVieneuReady(missingVoice), null);
});
