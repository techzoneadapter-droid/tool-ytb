import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("batch deletion API/store/filesystem: isolated real SQLite and real assets", () => {
  const repo = process.cwd();
  const workspace = mkdtempSync(path.join(tmpdir(), "storyflow-delete-"));
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(path.join(repo, "node_modules/tsx/dist/loader.mjs")).href,
        path.join(repo, "tests/fixtures/bulk-delete.ts"),
      ],
      {
        cwd: workspace,
        windowsHide: true,
        encoding: "utf8",
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: path.join(repo, "tsconfig.json"),
        },
      },
    );
    const cases = JSON.parse(output.trim());
    assert.equal(cases.length, 12);
    assert.ok(cases.every((item: { passed: boolean }) => item.passed));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
