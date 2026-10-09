import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { findEngineVoice } from "../modules/tts/catalog";
import { serviceURL } from "../modules/providers/services";

async function main() {
  const setup = JSON.parse(await readFile("data/vieneu-setup.json", "utf8"));
  assert.equal(setup.state, "done", JSON.stringify(setup));
  const voices = await (
    await fetch(new URL("/v1/voices", serviceURL("vieneu")))
  ).json();
  const selected = findEngineVoice(voices.data, "ngoc_huyen");
  assert.ok(selected, "Engine must supply the requested Ngọc Huyền preset.");
  const response = await fetch(
    new URL("/v1/audio/speech", serviceURL("vieneu")),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "vieneu-v3-turbo",
        voice: selected.id,
        input: "Xin chào, đây là giọng đọc của StoryFlow.",
        response_format: "wav",
        sample_rate: 24000,
      }),
      signal: AbortSignal.timeout(180000),
    },
  );
  assert.equal(
    response.status,
    200,
    await response
      .clone()
      .text()
      .then((text) => text.slice(0, 400)),
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert.ok(bytes.length > 4800);
  let peak = 0;
  for (let i = 44; i + 1 < bytes.length; i += 2)
    peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));
  assert.ok(peak > 0, "Generated speech must not be silent.");
  await writeFile("data/vieneu-install-smoke.wav", bytes);
  console.log(
    `VIENEU_FRESH_WINDOWS_INSTALL_SPEECH_PASS voices=${voices.data.length} bytes=${bytes.length}`,
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
