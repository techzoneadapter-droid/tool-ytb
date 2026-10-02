import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChapters, chunks } from "../modules/project/parser";
import { defaults } from "../modules/project/types";
import { settingsSchema } from "../modules/project/validation";
import { isSameOrigin } from "../modules/project/request";
import { vietnameseVoices, filterVoices } from "../modules/tts/voices";
import { subtitles } from "../modules/subtitle";
import {
  requireTTS,
  requireImage,
  providerStatus,
} from "../modules/providers/config";
import { imageStyles, styledPrompt } from "../modules/imagePrompt/styles";
import { usesMotion, workerURL } from "../modules/providers/local-workers";
import { localVoiceId } from "../modules/tts/local-voices";
test("motion remains optional and only selected scenes are eligible", () => {
  const scene = {
    id: "test",
    text: "test",
    prompt: "test",
    duration: 1,
    approved: false,
    motionSelected: true,
  };
  assert.equal(usesMotion(scene, defaults), false);
  assert.equal(usesMotion(scene, { ...defaults, motionMode: "off" }), false);
  assert.equal(
    usesMotion(scene, { ...defaults, motionMode: "selected" }),
    true,
  );
  assert.equal(
    usesMotion(
      { ...scene, motionSelected: false },
      { ...defaults, motionMode: "selected" },
    ),
    false,
  );
  assert.equal(
    usesMotion(
      { ...scene, motionSelected: false },
      { ...defaults, motionMode: "all" },
    ),
    true,
  );
  assert.equal(localVoiceId("Ngọc Huyền"), "ngoc_huyen");
});
test("image and motion local URLs cannot target a cloud service", () => {
  for (const [key, engine] of [
    ["FLUX2_WORKER_URL", "flux"],
    ["WAN22_WORKER_URL", "wan"],
  ] as const) {
    const saved = process.env[key];
    try {
      process.env[key] = "https://api.example.com";
      assert.throws(() => workerURL(engine), /cục bộ/);
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  }
});
import { assertTTS, resolveTTS } from "../modules/tts";
import { localVoices } from "../modules/tts/local-voices";
import { vieneuURL, hasVieneuVoice, vieneuVoices } from "../modules/tts/local";
test("missing VieNeu service reports setup instructions without cloud fallback", async () => {
  const saved = process.env.VIENEU_LOCAL_URL;
  try {
    process.env.VIENEU_LOCAL_URL = "http://127.0.0.1:1";
    await assert.rejects(
      vieneuVoices(),
      /Chưa chạy VieNeu-TTS local.*uv run python/,
    );
  } finally {
    if (saved === undefined) delete process.env.VIENEU_LOCAL_URL;
    else process.env.VIENEU_LOCAL_URL = saved;
  }
});
test("local selections never require cloud credentials or accept another engine's voice", () => {
  assert.equal(localVoices.length, 10);
  for (const v of localVoices)
    assert.doesNotThrow(() =>
      assertTTS({ ...defaults, ttsProvider: "korva-local", voice: v.id }),
    );
  assert.doesNotThrow(() =>
    assertTTS({
      ...defaults,
      ttsProvider: "vieneu-local",
      voice: "ngoc_huyen",
    }),
  );
  assert.throws(
    () =>
      assertTTS({ ...defaults, ttsProvider: "vieneu-local", voice: "bao_kim" }),
    /không thuộc/,
  );
  assert.throws(
    () => assertTTS({ ...defaults, ttsProvider: "tts-studio-local" }),
    /đang phát triển/,
  );
  assert.equal(resolveTTS(defaults).ttsProvider, "cloud");
});
test("local HTTP URL cannot redirect selection to a cloud endpoint", () => {
  const saved = process.env.VIENEU_LOCAL_URL;
  try {
    process.env.VIENEU_LOCAL_URL = "https://api.openai.com";
    assert.throws(() => vieneuURL(), /cục bộ/);
    process.env.VIENEU_LOCAL_URL = "http://127.0.0.1:8000";
    assert.equal(vieneuURL(), "http://127.0.0.1:8000");
    assert.equal(hasVieneuVoice([{ id: "Khác" }], "Ngọc Huyền"), false);
    assert.equal(hasVieneuVoice([{ id: "Ngọc Huyền" }], "Ngọc Huyền"), true);
  } finally {
    if (saved === undefined) delete process.env.VIENEU_LOCAL_URL;
    else process.env.VIENEU_LOCAL_URL = saved;
  }
});
test("recognizes chapter headings without splitting inline mentions", () => {
  assert.equal(
    parseChapters(
      "Chapter 1: A\nFirst.\nTập 2: B\nSecond.\nPhần III: C\nThird.",
    ).length,
    3,
  );
  assert.equal(parseChapters("Nội dung nói về Chương 1 trong câu.").length, 1);
});
test("same-origin protection accepts browser loopback host even when Next normalizes its URL", () => {
  assert.ok(
    isSameOrigin(
      new Request("http://localhost:3000/api/studio", {
        headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
      }),
    ),
  );
  assert.ok(
    !isSameOrigin(
      new Request("http://localhost:3000/api/studio", {
        headers: {
          host: "127.0.0.1:3000",
          origin: "https://other.example",
          "x-forwarded-host": "other.example",
        },
      }),
    ),
  );
  assert.ok(
    !isSameOrigin(
      new Request("http://localhost:3000/api/studio", {
        headers: { host: "127.0.0.1:3000", origin: "null" },
      }),
    ),
  );
});
test("chunk limits also handle giant unbroken input", () => {
  const text = "a".repeat(1100);
  assert.ok(chunks(text, 550).every((c) => c.length <= 550));
  assert.equal(chunks(text, 550).join(""), text);
});
test("subtitle timing advances through scenes and formats VTT", () => {
  const scenes = parseChapters("Dòng văn bản ngắn dùng để kiểm tra phụ đề.")[0]
    .scenes;
  const srt = subtitles(scenes);
  assert.match(srt, /1\n00:00:00,000 -->/);
  assert.ok(subtitles(scenes, true).startsWith("WEBVTT\n\n"));
});
test("plain stories preserve all paragraphs and always produce one chapter", () => {
  const text =
    "Một đoạn văn không có tiêu đề.\n\nĐoạn tiếp theo vẫn thuộc cùng nội dung.";
  const chapters = parseChapters(text);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].text, text);
  assert.ok(chapters[0].scenes.length > 0);
  assert.equal(parseChapters("Chương 1").length, 1);
  assert.equal(parseChapters("…").length, 1);
  assert.throws(() => parseChapters(" \n "), /trống/);
});
test("recognizes zero-padded, Roman, Vietnamese words and formatted headings", () => {
  const text = [
    "Chương 01: Đầu",
    "Nội dung A.",
    "CHƯƠNG II",
    "Nội dung B.",
    "Phần một",
    "Nội dung C.",
    "**Phần hai**",
    "Nội dung D.",
    "Tập 1",
    "Nội dung E.",
    "Chapter 1",
    "Nội dung F.",
  ].join("\n");
  const chapters = parseChapters(text);
  assert.equal(chapters.length, 6);
  assert.deepEqual(
    chapters.map((c) => c.text),
    [
      "Nội dung A.",
      "Nội dung B.",
      "Nội dung C.",
      "Nội dung D.",
      "Nội dung E.",
      "Nội dung F.",
    ],
  );
});
test("end-of-part markers close content without phantom chapters", () => {
  const chapters = parseChapters(
    "Nội dung thứ nhất.\n**Hết phần một.**\nNội dung thứ hai.\nHết phần hai.",
  );
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, "Phần một");
  assert.equal(chapters[1].text, "Nội dung thứ hai.");
  assert.equal(
    parseChapters(
      "Phần một\nNội dung.\n**Hết phần một.**\nPhần hai\nTiếp theo.",
    ).length,
    2,
  );
  assert.equal(
    parseChapters("Nhân vật nói: Hết phần một. Rồi tiếp tục.").length,
    1,
  );
});
test("Vietnamese presets validate, filter correctly and never impersonate provider voices", () => {
  assert.equal(vietnameseVoices.length, 13);
  assert.equal(
    settingsSchema.parse({ ...defaults, voice: "ngoc-huyen" }).voice,
    "ngoc-huyen",
  );
  assert.ok(filterVoices("Nữ").every((v) => v.gender === "Nữ"));
  assert.ok(filterVoices("Review phim").some((v) => v.id === "minh-quan"));
});
test("missing credentials fail closed and never activate named presets", async () => {
  const keys = [
    "OPENAI_API_KEY",
    "TTS_API_KEY",
    "AZURE_SPEECH_KEY",
    "IMAGE_API_KEY",
    "TTS_VOICE_MAP",
    "TTS_PROVIDER",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    assert.throws(() => requireTTS("ngoc-huyen"), /Chưa cấu hình API TTS/);
    assert.throws(() => requireImage(), /Chưa cấu hình API tạo ảnh/);
    assert.equal(
      (await providerStatus()).voices.find((v) => v.id === "ngoc-huyen")
        ?.configured,
      false,
    );
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
test("all ten image presets have distinct system prompts including xianxia", () => {
  assert.ok(imageStyles.length >= 10);
  assert.equal(
    new Set(imageStyles.map((s) => s.prompt)).size,
    imageStyles.length,
  );
  const prompt = styledPrompt(
    "Một người đứng trên núi.",
    "Tu tiên / Tiên hiệp",
    "Áo trắng",
  );
  assert.match(prompt, /Chinese xianxia cultivation fantasy/);
  assert.match(prompt, /Một người đứng trên núi/);
  assert.match(prompt, /Áo trắng/);
});
