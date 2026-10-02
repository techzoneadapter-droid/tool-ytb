import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:3000";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(base);
  await page.getByRole("button", { name: "Giọng đọc", exact: true }).click();
  const local = page
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "Local miễn phí", exact: true }),
    })
    .last();
  await expect(local.locator("article.voice")).toHaveCount(11);
  const vieneu = local
    .locator("article.voice")
    .filter({ hasText: "VieNeu-TTS local" });
  await vieneu.getByRole("button", { name: "Nghe thử", exact: true }).click();
  const status = await (await fetch(base + "/api/studio")).json();
  if (!status.providers.local.vieneu.ready) {
    await expect(vieneu.getByRole("alert")).toContainText(
      "Chưa chạy VieNeu-TTS local",
      { timeout: 15000 },
    );
    assert.equal(await vieneu.locator("audio").count(), 0);
  }
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/local-tts.png", fullPage: true });
  const results = {
    voices: 11,
    pageErrors: errors,
    vieneuReady: status.providers.local.vieneu.ready,
    korvaInstalled: status.providers.local.korva.ready,
  };
  if (process.argv.includes("--audio")) {
    const korva = local
      .locator("article.voice")
      .filter({ hasText: "KorvaTTS local" })
      .filter({ has: page.getByText("Ngọc Huyền", { exact: true }) });
    await korva.getByRole("button", { name: "Nghe thử", exact: true }).click();
    await expect(korva.locator("audio")).toHaveCount(1, { timeout: 600000 });
    await expect
      .poll(
        () =>
          korva
            .locator("audio")
            .evaluate((el) => Number.isFinite(el.duration) && el.duration > 0),
        { timeout: 15000 },
      )
      .toBe(true);
    results.duration = await korva
      .locator("audio")
      .evaluate((el) => el.duration);
    await korva.locator("audio").evaluate((el) => el.play());
    await expect
      .poll(() => korva.locator("audio").evaluate((el) => el.currentTime), {
        timeout: 10000,
      })
      .toBeGreaterThan(0);
    results.playbackStarted = true;
    results.audioURL = await korva.locator("audio").getAttribute("src");
    const audio = await fetch(base + results.audioURL);
    assert.equal(audio.status, 200);
    results.bytes = (await audio.arrayBuffer()).byteLength;
    assert.ok(results.bytes > 1000);
    await page.reload();
    assert.equal((await fetch(base + results.audioURL)).status, 200);
    results.persistsAfterRefresh = true;
  }
  assert.deepEqual(errors, []);
  await writeFile(
    "test-results/local-tts.json",
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
