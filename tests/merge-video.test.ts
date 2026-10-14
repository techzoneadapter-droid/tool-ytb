import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("merge ten real MP4 files by chapter, register output and preserve originals", () => {
  const repo = process.cwd();
  const workspace = mkdtempSync(path.join(tmpdir(), "storyflow-merge-"));
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(path.join(repo, "node_modules/tsx/dist/loader.mjs")).href,
        path.join(repo, "tests/fixtures/merge-video.ts"),
      ],
      {
        cwd: workspace, windowsHide: true, encoding: "utf8", timeout: 120000,
        env: { ...process.env, TSX_TSCONFIG_PATH: path.join(repo, "tsconfig.json") },
      },
    );
    const result = JSON.parse(output.trim());
    assert.equal(result.count, 10);
    assert.ok(result.actualDuration > 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("merge button never depends on an unsupported Electron prompt", () => {
  const source = readFileSync(
    path.join(process.cwd(), "app/components/videoLibrary/VideoManagerPage.tsx"),
    "utf8",
  );
  const mergeHandler = source.slice(
    source.indexOf("async function mergeSelected()"),
    source.indexOf("function formatBytes("),
  );
  assert.ok(mergeHandler.includes('action: "merge"'));
  assert.doesNotMatch(mergeHandler, /\b(?:window\.)?prompt\s*\(/);
});
