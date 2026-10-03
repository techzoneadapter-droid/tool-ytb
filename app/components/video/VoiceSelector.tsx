import { useState, useRef } from "react";
import type { Settings } from "@/modules/project/types";
import { findEngineVoice } from "@/modules/tts/catalog";
import type { StudioData } from "../studio-api";
import { request } from "../studio-api";
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
          text: "Xin chào. Cùng StoryFlow kể câu chuyện của bạn.",
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
        <span className="badge">Local miễn phí</span>
      </div>
      {(!s.ttsProvider ||
        s.ttsProvider === "cloud" ||
        s.ttsProvider === "tts-studio-local") && (
        <p className="notice">
          Dự án cũ đang dùng giọng khác. Chọn VieNeu hoặc Korva để tạo video
          bằng giọng local.
        </p>
      )}
      <div className="fields">
        <label>
          Engine giọng đọc
          <select
            aria-label="Engine giọng đọc"
            value={s.ttsProvider || "cloud"}
            onChange={(e) => {
              change({
                ttsProvider: e.target.value as Settings["ttsProvider"],
                voice:
                  providers?.voices.find((v) => v.provider === e.target.value)
                    ?.id || "ngoc_huyen",
              });
              setAudio("");
            }}
          >
            <option value="vieneu-local">VieNeu-TTS v3 Turbo</option>
            <option value="korva-local">KorvaTTS</option>
            {!["vieneu-local", "korva-local"].includes(s.ttsProvider || "") && (
              <option value={s.ttsProvider || "cloud"} disabled>
                Giọng đã lưu của dự án cũ
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
            !["vieneu-local", "korva-local"].includes(s.ttsProvider || "")
          }
        >
          {busy ? "Đang tạo bản nghe thử…" : "▶ Nghe thử"}
        </button>
      </div>
      <p className="muted">
        {voices.length
          ? `● Sẵn sàng · ${voices.length} giọng`
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
