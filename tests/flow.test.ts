import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { generationScript } from "../modules/providers/flow-generation";
import { configureFlowImages } from "../modules/providers/flow-controls";
import { navigateFlow } from "../modules/providers/flow-navigation";

test("Synthetic Vietnamese composer smoke test (not live Flow selector evidence)", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    // Synthetic menu only checks plumbing; selectors must be validated on live Flow.
    await page.setContent(`<div contenteditable="true" translate="no" class="ProseMirror"><p><br></p></div>
      <button class="agent-mode-chip" aria-pressed="true">Tác nhân</button>
      <button class="settings-trigger-button" aria-label="Điều kiện kích hoạt cài đặt">🍌 Nano Banana Pro <span aria-hidden="true">crop_16_9</span> x1</button>
      <section hidden id="menu"><button>Ảnh</button><button>🍌 Nano Banana Pro</button><button>16:9</button><button>x1</button></section>
      <button type="submit" aria-label="Bắt đầu tạo" disabled>arrow_forward</button>`);
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>(".agent-mode-chip")!.onclick = (
        event,
      ) =>
        (event.currentTarget as HTMLElement).setAttribute(
          "aria-pressed",
          "false",
        );
      document.querySelector<HTMLButtonElement>(
        ".settings-trigger-button",
      )!.onclick = () => {
        document.querySelector<HTMLElement>("#menu")!.hidden = false;
      };
      document.querySelector(".ProseMirror")!.addEventListener("input", () => {
        document.querySelector<HTMLButtonElement>(
          'button[type="submit"]',
        )!.disabled = false;
      });
      document.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      )!.onclick = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 768;
        canvas.height = 432;
        const image = new Image();
        image.src = canvas.toDataURL();
        document.body.append(image);
      };
    });
    await configureFlowImages(page, "Nano Banana Pro", "16:9");
    assert.equal(
      await page.locator(".agent-mode-chip").getAttribute("aria-pressed"),
      "false",
    );
    await page.locator(".ProseMirror").fill("A forest");
    const result = (await page.evaluate(
      `(${generationScript("A forest", "16:9")})()`,
    )) as { dataUrl: string };
    assert.match(result.dataUrl, /^data:image\/png;base64,/);
  } finally {
    await browser.close();
  }
});

test("Flow navigation does not wait for a stalled DOMContentLoaded event", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://flow.google.com/**", async (route) => {
      if (route.request().url().endsWith("slow.js")) return;
      await route.fulfill({
        contentType: "text/html",
        body: '<textarea></textarea><script src="/slow.js"></script>',
      });
    });
    assert.equal(
      await navigateFlow(page, "https://flow.google.com/project/demo", 2000),
      true,
    );
    assert.equal(await page.locator("textarea").isVisible(), true);
    assert.equal(await page.evaluate(() => document.readyState), "loading");
  } finally {
    await browser.close();
  }
});

test("Flow navigation timeout keeps the page open for recovery", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://flow.google.com/**", () => {});
    assert.equal(
      await navigateFlow(page, "https://flow.google.com/project/demo", 100),
      false,
    );
    assert.equal(page.isClosed(), false);
  } finally {
    await browser.close();
  }
});

test("Flow navigation reports HTTP errors instead of claiming readiness", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://flow.google.com/**", (route) =>
      route.fulfill({ status: 403, body: "Forbidden" }),
    );
    await assert.rejects(
      navigateFlow(page, "https://flow.google.com/project/demo"),
      /HTTP 403/,
    );
  } finally {
    await browser.close();
  }
});

test("Flow switches from video to Image and chooses the requested model and ratio", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<input type="checkbox" role="switch" aria-label="Agent" checked><button id="picker">Veo 3.1</button><section id="menu" hidden>
      <button id="mode">Image</button><button id="model">Nano Banana Pro</button>
      <button id="ratio">9:16</button><button id="count">x1</button></section>`);
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>("#picker")!.onclick = () => {
        document.querySelector<HTMLElement>("#menu")!.hidden = false;
      };
      for (const id of ["mode", "model", "ratio", "count"]) {
        document.querySelector<HTMLButtonElement>("#" + id)!.onclick = (
          event,
        ) => {
          (event.target as HTMLElement).dataset.selected = "true";
        };
      }
    });
    await configureFlowImages(page, "Nano Banana Pro", "9:16");
    assert.equal(
      await page.getByRole("switch", { name: "Agent" }).isChecked(),
      false,
    );
    for (const id of ["mode", "model", "ratio", "count"])
      assert.equal(
        await page.locator("#" + id).getAttribute("data-selected"),
        "true",
      );
  } finally {
    await browser.close();
  }
});

test("Flow refuses generation if the Image mode cannot be confirmed", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<button>Veo 3.1</button><textarea></textarea>`);
    await assert.rejects(
      configureFlowImages(page, "Nano Banana Pro", "16:9"),
      /Không tìm thấy chế độ Image/,
    );
  } finally {
    await browser.close();
  }
});

test("Flow returns the newly generated landscape image and ignores credit labels", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<p>Tín dụng Google Flow</p><textarea></textarea><button>Generate</button>`,
    );
    await page.evaluate(() => {
      const old = document.createElement("canvas");
      old.width = 1024;
      old.height = 1024;
      const oldImage = new Image();
      oldImage.src = old.toDataURL();
      document.body.append(oldImage);
      document.querySelector("button")!.onclick = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 768;
        canvas.height = 432;
        const image = new Image();
        image.src = canvas.toDataURL();
        document.body.append(image);
      };
    });
    const prompt = 'A forest "scene" with a backtick ` and newline\n sunrise';
    const result = (await page.evaluate(
      `(${generationScript(prompt, "16:9")})()`,
    )) as { dataUrl: string };
    assert.match(result.dataUrl, /^data:image\/png;base64,/);
    assert.equal(await page.locator("textarea").inputValue(), prompt);
    assert.equal(
      await page.evaluate(async (src: string) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        return image.naturalWidth;
      }, result.dataUrl),
      768,
    );
  } finally {
    await browser.close();
  }
});

test("Flow reports a real credit alert without waiting for the full timeout", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<textarea></textarea><button>Generate</button><div role="alert">Insufficient credits</div>`,
    );
    await assert.rejects(
      page.evaluate(`(${generationScript("forest", "9:16")})()`),
      /giới hạn\/tín dụng/,
    );
  } finally {
    await browser.close();
  }
});

test("Flow retains the fresh asset URL when browser download is blocked by CORS", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<textarea></textarea><button>Generate</button>`);
    await page.evaluate(() => {
      window.fetch = async () => {
        throw new TypeError("Failed to fetch");
      };
      document.querySelector("button")!.onclick = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 1024;
        canvas.height = 1024;
        const image = new Image();
        image.src = canvas.toDataURL();
        document.body.append(image);
      };
    });
    const result = (await page.evaluate(
      `(${generationScript("forest", "16:9")})()`,
    )) as { src: string; dataUrl?: string };
    assert.match(result.src, /^data:image\/png/);
    assert.equal(result.dataUrl, undefined);
  } finally {
    await browser.close();
  }
});

test("Flow never submits through an unrelated button or synthetic Enter", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<textarea></textarea><button>Generate video settings</button><button disabled>Generate</button>`,
    );
    await page.evaluate(() => {
      (window as unknown as { submitted: boolean }).submitted = false;
      document.querySelector("textarea")!.addEventListener("keydown", () => {
        (window as unknown as { submitted: boolean }).submitted = true;
      });
      document.querySelector("button")!.onclick = () => {
        (window as unknown as { submitted: boolean }).submitted = true;
      };
    });
    await assert.rejects(
      page.evaluate(`(${generationScript("forest", "16:9")})()`),
      /Không tìm thấy nút tạo ảnh/,
    );
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { submitted: boolean }).submitted,
      ),
      false,
    );
  } finally {
    await browser.close();
  }
});

import { flowFailure } from "../modules/providers/flow-browser";

test("Flow errors preserve stage, original detail and diagnostic paths", () => {
  const error = flowFailure(
    {
      code: "FLOW_CONFIG_RATIO",
      stage: "FLOW_CONFIG_RATIO",
      error: "TimeoutError: exact locator failure",
      diagnostics: { html: "data/flow-diagnostics/failure.html" },
    },
    "fallback",
  );
  assert.equal(error.message.split("FLOW_CONFIG_RATIO").length, 2);
  assert.match(error.message, /TimeoutError: exact locator failure/);
  assert.match(error.message, /failure\.html/);
});
