import type { Settings } from "@/modules/project/types";
import { upload, fileURL } from "../studio-api";
export function AdvancedOptions({
  settings: s,
  change,
  onError,
}: {
  settings: Settings;
  change: (patch: Partial<Settings>) => void;
  onError: (message: string) => void;
}) {
  async function asset(key: "intro" | "outro" | "logo" | "music", file?: File) {
    if (!file) return;
    try {
      const d = await upload(file);
      if (!d.asset) throw Error("Tệp không phù hợp.");
      change({ [key]: d.asset });
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <details className="card advanced">
      <summary>Thiết lập nâng cao</summary>
      <div className="advanced-body">
        <h3>Giọng đọc</h3>
        <div className="fields three">
          {(
            [
              { key: "pitch", title: "Cao độ", min: -6, max: 6, step: 1 },
              { key: "volume", title: "Âm lượng", min: 0, max: 2, step: 0.1 },
              {
                key: "pause",
                title: "Nghỉ cuối câu (giây)",
                min: 0,
                max: 3,
                step: 0.1,
              },
            ] as const
          ).map((f) => (
            <label key={f.key}>
              {f.title}
              <input
                type="number"
                min={f.min}
                max={f.max}
                step={f.step}
                value={s[f.key]}
                onChange={(e) => change({ [f.key]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>
        <label>
          Prompt ảnh bổ sung
          <textarea
            rows={3}
            maxLength={2000}
            value={s.customPrompt}
            onChange={(e) => change({ customPrompt: e.target.value })}
            placeholder="Mô tả nhân vật, trang phục hoặc bối cảnh xuyên suốt…"
          />
        </label>
        <h3>Phụ đề</h3>
        <div className="fields">
          <label>
            Font
            <select
              value={s.font}
              onChange={(e) => change({ font: e.target.value })}
            >
              {["Arial", "Tahoma", "Verdana", "Times New Roman"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Màu chữ
            <input
              type="color"
              value={s.color}
              onChange={(e) => change({ color: e.target.value })}
            />
          </label>
          <label>
            Viền chữ
            <input
              type="number"
              min={0}
              max={5}
              value={s.outline}
              onChange={(e) => change({ outline: Number(e.target.value) })}
            />
          </label>
          <label>
            Vị trí
            <select
              value={s.position}
              onChange={(e) =>
                change({ position: e.target.value as Settings["position"] })
              }
            >
              <option value="bottom">Phía dưới</option>
              <option value="top">Phía trên</option>
            </select>
          </label>
        </div>
        <h3>Nhận diện & âm nhạc</h3>
        <div className="fields">
          {(
            [
              { key: "intro", name: "Intro", accept: ".mp4" },
              { key: "outro", name: "Outro", accept: ".mp4" },
              { key: "logo", name: "Logo", accept: ".png,.jpg,.webp" },
              { key: "music", name: "Nhạc nền", accept: ".mp3,.wav" },
            ] as const
          ).map((f) => (
            <div key={f.key}>
              <label>
                {f.name}
                <input
                  type="file"
                  accept={f.accept}
                  onChange={(e) => void asset(f.key, e.target.files?.[0])}
                />
              </label>
              {s[f.key] && (
                <div className="row">
                  <a href={fileURL(s[f.key])} target="_blank" rel="noreferrer">
                    Xem tệp đã chọn
                  </a>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => change({ [f.key]: undefined })}
                  >
                    Bỏ chọn
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <label>
          Âm lượng nhạc nền
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={s.musicVolume}
            onChange={(e) => change({ musicVolume: Number(e.target.value) })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={s.humanCheck}
            onChange={(e) => change({ humanCheck: e.target.checked })}
          />
          Yêu cầu duyệt cảnh thủ công
        </label>
        <p className="muted">
          Video sẽ dừng để bạn xem và nghe tài nguyên trước khi xuất.
        </p>
      </div>
    </details>
  );
}
