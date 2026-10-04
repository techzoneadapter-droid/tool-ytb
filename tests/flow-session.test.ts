import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { attachFlowChrome, connectFlowEndpoint, findProfileFlowPage, flowTabs, isFlowPage, selectFlowTab } from "../modules/providers/flow-session";
import { listChromeProfiles } from "../modules/providers/flow-profiles";

test("Chrome HTTP discovery 404 falls back to the opt-in WebSocket endpoint", async () => {
  const attempts: string[] = [];
  const attached = {} as Browser;
  const result = await connectFlowEndpoint("http://127.0.0.1:9222", async endpoint => {
    attempts.push(endpoint);
    if (endpoint.startsWith("http:")) throw Error("Unexpected status 404 when connecting to http://127.0.0.1:9222/json/version/.");
    return attached;
  });
  assert.equal(result, attached);
  assert.deepEqual(attempts, ["http://127.0.0.1:9222", "ws://127.0.0.1:9222/devtools/browser"]);
});

test("Chrome connection timeout is preserved without another approval request", async () => {
  let attempts = 0;
  await assert.rejects(connectFlowEndpoint("http://127.0.0.1:9222", async () => {
    attempts++;
    throw Error("Timeout 90000ms exceeded");
  }), /Timeout 90000ms/);
  assert.equal(attempts, 1);
});

test("Chrome fallback retains the actual WebSocket failure", async () => {
  await assert.rejects(connectFlowEndpoint("http://127.0.0.1:9222", async endpoint => {
    if (endpoint.startsWith("http:")) throw Error("Unexpected status 404 when connecting to http://127.0.0.1:9222/json/version/.");
    throw Error("WebSocket connection refused");
  }), /ws:\/\/127\.0\.0\.1:9222\/devtools\/browser[\s\S]*WebSocket connection refused/);
});

test("Flow attaches to existing tabs and disconnects without closing Chrome", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flow-cdp-test-"));
  const previous = process.env.FLOW_CDP_URL;
  const existing = await chromium.launchPersistentContext(root, { channel: "chrome", headless: true, args: ["--remote-debugging-port=0"] });
  try {
    await existing.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<title>Existing Flow</title><textarea></textarea>' }));
    const first = existing.pages()[0];
    await first.goto("https://flow.google.com/project/first");
    const second = await existing.newPage();
    await second.goto("https://flow.google.com/project/second");
    await second.goto("https://flow.google.com/project/second?storyflow_connect=profile-test");
    const unrelated = await existing.newPage();
    await unrelated.goto("https://example.com");
    const [port] = (await readFile(path.join(root, "DevToolsActivePort"), "utf8")).split("\n");
    process.env.FLOW_CDP_URL = `http://127.0.0.1:${port}`;
    const attached = await attachFlowChrome();
    try {
      const tabs = await flowTabs(attached);
      assert.equal(tabs.length, 2);
      const chosen = tabs.find(tab => tab.url.includes("/second"))!;
      const page = await selectFlowTab(attached, chosen.id);
      assert.equal(await findProfileFlowPage(attached, "profile-test"), page);
      await page.locator("textarea").fill("selected existing tab");
      assert.equal(await second.locator("textarea").inputValue(), "selected existing tab");
      assert.equal(await first.locator("textarea").inputValue(), "");
      await assert.rejects(selectFlowTab(attached, "missing"), /không còn mở/);
      assert.equal(existing.pages().length, 3);
    } finally { await attached.close(); }
    assert.equal(second.isClosed(), false);
    assert.equal(unrelated.isClosed(), false);
    assert.equal(await second.locator("textarea").inputValue(), "selected existing tab");
  } finally {
    await existing.close();
    if (previous === undefined) delete process.env.FLOW_CDP_URL;
    else process.env.FLOW_CDP_URL = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Chrome profile list contains only existing personal profiles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flow-profiles-test-"));
  const previous = process.env.FLOW_CHROME_USER_DATA_DIR;
  process.env.FLOW_CHROME_USER_DATA_DIR = root;
  const { mkdir, writeFile } = await import("node:fs/promises");
  try {
    await mkdir(path.join(root, "Profile 2"));
    await writeFile(path.join(root, "Local State"), JSON.stringify({ profile: { info_cache: {
      "Profile 2": { name: "School", user_name: "school@example.com" },
      "Profile 3": { name: "Missing" },
      "../bad": { name: "Invalid" },
    } } }));
    assert.deepEqual((await listChromeProfiles()).profiles, [{ id: "Profile 2", name: "School", email: "school@example.com" }]);
  } finally {
    if (previous === undefined) delete process.env.FLOW_CHROME_USER_DATA_DIR;
    else process.env.FLOW_CHROME_USER_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Flow tab discovery only accepts Flow pages", () => {
  assert.equal(isFlowPage("https://flow.google.com/project/demo"), true);
  assert.equal(isFlowPage("https://labs.google/fx/vi/tools/flow/project/demo"), true);
  assert.equal(isFlowPage("https://accounts.google.com"), false);
  assert.equal(isFlowPage("https://labs.google/unrelated"), false);
  assert.equal(isFlowPage("https://flow.google.com.evil.example/project/demo"), false);
});
