import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("long stories survive preview, import, append and upload without truncation", () => {
  const repo = process.cwd();
  const workspace = mkdtempSync(path.join(tmpdir(), "storyflow-long-story-"));
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(path.join(repo, "node_modules/tsx/dist/loader.mjs")).href,
        path.join(repo, "tests/fixtures/long-story.ts"),
      ],
      {
        cwd: workspace,
        windowsHide: true,
        timeout: 120000,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: path.join(repo, "tsconfig.json"),
        },
      },
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
