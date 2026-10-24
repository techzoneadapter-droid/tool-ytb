import { serviceURL } from "./services";
import { findEngineVoice } from "../tts/catalog";

/**
 * Inspect the running VieNeu service before spawning another Windows process.
 * A stale setup error must not hide a healthy engine and its real voice list.
 */
export async function probeVieneuReady(
  fetcher: typeof fetch = fetch,
): Promise<{ voiceId: string; voiceCount: number } | null> {
  try {
    const url = serviceURL("vieneu");
    const [healthResponse, voicesResponse] = await Promise.all([
      fetcher(new URL("/health", url), {
        signal: AbortSignal.timeout(4000),
        redirect: "error",
        cache: "no-store",
      }),
      fetcher(new URL("/v1/voices", url), {
        signal: AbortSignal.timeout(4000),
        redirect: "error",
        cache: "no-store",
      }),
    ]);
    if (!healthResponse.ok || !voicesResponse.ok) return null;
    const health = await healthResponse.json();
    const voices = await voicesResponse.json();
    if (
      health?.status !== "ok" ||
      !Array.isArray(voices?.data) ||
      voices.data.length === 0
    )
      return null;
    const ngocHuyen = findEngineVoice(voices.data, "ngoc_huyen");
    if (!ngocHuyen) return null;
    return { voiceId: ngocHuyen.id, voiceCount: voices.data.length };
  } catch {
    return null;
  }
}

export function vieneuReadyMessage(ready: {
  voiceId: string;
  voiceCount: number;
}): string {
  return `VieNeu đã hoạt động · ${ready.voiceCount} giọng, có Ngọc Huyền (${ready.voiceId}).`;
}
