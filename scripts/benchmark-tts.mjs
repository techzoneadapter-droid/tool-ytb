import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { state, post, probe, report, base } from "./verification.mjs";
const result = {};
const d = await state();
for (const provider of ["korva-local", "vieneu-local"]) {
  const voices = d.providers.voices.filter((v) => v.provider === provider);
  assert.ok(voices.length > 1);
  const times = [];
  const hashes = new Set();
  for (const v of voices.slice(0, 3)) {
    let start = performance.now();
    const first = await post(
      { provider, voiceId: v.id, speed: 1 },
      "/api/tts/preview",
    );
    const firstSeconds = (performance.now() - start) / 1000;
    probe(first.file);
    hashes.add(
      createHash("sha256")
        .update(
          Buffer.from(await (await fetch(base + first.audioUrl)).arrayBuffer()),
        )
        .digest("hex"),
    );
    start = performance.now();
    const cached = await post(
      { provider, voiceId: v.id, speed: 1 },
      "/api/tts/preview",
    );
    assert.equal(cached.cached, true);
    assert.equal(first.file, cached.file);
    times.push({
      voice: v.id,
      firstSeconds,
      cachedSeconds: (performance.now() - start) / 1000,
      duration: first.duration,
      alreadyCached: first.cached,
    });
  }
  assert.equal(hashes.size, 3);
  const start = performance.now();
  for (let i = 0; i < 10; i++) {
    const audio = await post(
      {
        provider,
        voiceId: voices[0].id,
        text: `Buổi sáng thứ ${i + 1}, Lan đi qua khu rừng xanh.`,
      },
      "/api/tts/generate",
    );
    probe(audio.file);
  }
  result[provider] = {
    voices: voices.length,
    previews: times,
    tenSegmentsSeconds: (performance.now() - start) / 1000,
  };
  console.log(JSON.stringify(result[provider]));
}
await report("tts-benchmark", result);
