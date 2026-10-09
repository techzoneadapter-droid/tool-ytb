import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { NextRequest } from "next/server";
import { POST } from "../app/api/tts/setup/route";

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
