import { useState, useRef } from "react";
import type { Settings } from "@/modules/project/types";
import { findEngineVoice } from "@/modules/tts/catalog";
import type { StudioData } from "../studio-api";
import { request } from "../studio-api";

const providerNames: Record<string, string> = {
  "modal-vieneu": "VieNeu Cloud · GPU",
  "vieneu-local": "VieNeu-TTS v3 Turbo · Local",
  "korva-local": "KorvaTTS · Local",
};

export function VoiceSelector({
  settings: s,
  change,
  providers,
}: {
  settings: Settings;
  change: (patch: Partial<Settings>) => void;
  providers: StudioData["providers"];
}) {
  const voices =
    providers?.voices.filter((v) => v.provider === s.ttsProvider) || [];
  const selected = findEngineVoice(voices, s.voice);
  const cache = useRef(new Map<string, string>());
  const player = useRef<HTMLAudioElement>(null);
  const key = JSON.stringify([s.ttsProvider, s.voice, s.speed]);
  const current = useRef(key);
  current.current = key;
  const [busy, setBusy] = useState(false),
    [audio, setAudio] = useState(""),
    [error, setError] = useState("");

  const providerOptions = [
    ...(providers?.modal?.tts?.configured
      ? [{ id: "modal-vieneu", label: providerNames["modal-vieneu"] }]
      : []),
    { id: "vieneu-local", label: providerNames["vieneu-local"] },
    { id: "korva-local", label: providerNames["korva-local"] },
  ];

  async function preview() {
    const cached = cache.current.get(key);
    if (cached) {
      setAudio(cached);
      if (player.current?.getAttribute("src") === cached) {
        player.current.currentTime = 0;
        void player.current.play();
      }
      return;
    }
    setBusy(true);
    setAudio("");
    setError("");
    try {
      const d = await request<{ audioUrl: string }>(
        {
          provider: s.ttsProvider,
          voiceId: s.voice,
          text: "Xin chào, đây là giọng đọc được chọn cho câu chuyện.",
          format: "mp3",
          speed: s.speed,
          pitch: s.pitch,
          volume: s.volume,
          pause: s.pause,
        },
        "/api/tts/preview",
      );
      cache.current.set(key, d.audioUrl);
      if (current.current === key) setAudio(d.audioUrl);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card voice-card">
      <div className="row between">
        <h2>Giọng đọc</h2>
        <span className="badge">
          {s.ttsProvider === "modal-vieneu" ? "Cloud GPU" : "Local miễn phí"}
        </span>
      </div>
      <div className="fields">
        <label>
          Engine giọng đọc
          <select
            aria-label="Engine giọng đọc"
            value={s.ttsProvider || "vieneu-local"}
            onChange={(e) => {
              const provider = e.target.value as Settings["ttsProvider"];
              change({
                ttsProvider: provider,
                voice:
                  providers?.voices.find((v) => v.provider === provider)?.id ||
                  "ngoc_huyen",
              });
              setAudio("");
            }}
          >
            {providerOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
            {!providerOptions.some((option) => option.id === s.ttsProvider) && (
              <option value={s.ttsProvider || "cloud"} disabled>
                Engine đã lưu của dự án cũ
              </option>
            )}
          </select>
        </label>

        <label>
          Giọng
          <select
            aria-label="Giọng"
            value={selected?.id || s.voice}
            onChange={(e) => {
              change({ voice: e.target.value });
              setAudio("");
            }}
          >
            {!selected && (
              <option value={s.voice}>{s.voice} · giọng đã lưu</option>
            )}
            {voices.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="row between">
        <label className="speed">
          Tốc độ đọc
          <select
            value={s.speed}
            onChange={(e) => {
              change({ speed: Number(e.target.value) });
              setAudio("");
            }}
          >
            {[0.5, 0.75, 1, 1.1, 1.25, 1.5, 2].map((n) => (
              <option key={n} value={n}>
                {n}x
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={preview}
          disabled={
            busy ||
            !["modal-vieneu", "vieneu-local", "korva-local"].includes(
              s.ttsProvider || "",
            ) ||
            voices.length === 0
          }
        >
          {busy ? "Đang tạo bản nghe thử…" : "▶ Nghe thử"}
        </button>
      </div>

      <p className="muted">
        {voices.length
          ? `● Sẵn sàng · ${voices.length} giọng`
          : s.ttsProvider === "modal-vieneu"
            ? "VieNeu Cloud chưa kết nối hoặc chưa deploy."
            : "Chưa kết nối engine để lấy danh sách giọng"}
      </p>

      {audio && (
        <audio ref={player} controls autoPlay src={audio} preload="auto" />
      )}
      {error && (
        <div className="notice error" role="alert">
          Chưa tạo được bản nghe thử.
          <details>
            <summary>Chi tiết</summary>
            <pre>{error}</pre>
          </details>
        </div>
      )}
    </section>
  );
}
