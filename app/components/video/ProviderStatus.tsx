import { useState, useEffect } from "react";
import type { StudioData } from "../studio-api";
import { request } from "../studio-api";
export function ProviderStatus({
  providers: p,
  refresh,
}: {
  providers: StudioData["providers"];
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(""),
    [detail, setDetail] = useState(""),
    [setup, setSetup] = useState(false);
  const [install, setInstall] = useState<{
    state: string;
    log?: string;
    hardware?: { gpu: string; vram_gb: number; bf16: boolean };
  }>();
  const [consent, setConsent] = useState(false);
  useEffect(() => {
    if (!setup) return;
    let active = true;
    const poll = () =>
      fetch("/api/ai/setup")
        .then((r) => r.json())
        .then((d) => {
          if (active) setInstall(d);
        })
        .catch(() => {});
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [setup]);
  async function setupAI(action: string) {
    setBusy("setup");
    try {
      await request({ action, confirmed: consent }, "/api/ai/setup");
      setInstall({ state: "running" });
    } catch (e) {
      setDetail((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  const entries = [
    ["VieNeu", p?.local.vieneu.ready, "vieneu"],
    ["Korva", p?.local.korva.ready, "korva"],
    ["FLUX.2", p?.runtime.flux, "flux"],
    ["Local Fast", p?.runtime.fast, "fast"],
    ["Wan2.2", p?.runtime.wan, "wan"],
    ["FFmpeg", p?.runtime.ffmpeg, ""],
    ["Worker", p?.runtime.worker, "worker"],
  ] as const;
  async function start(service: string) {
    setBusy(service);
    setDetail("");
    try {
      await request({ action: "startService", service });
      await refresh();
    } catch (e) {
      setDetail((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="card system-card">
      <div className="row between">
        <h2>Hệ thống AI</h2>
        <span className="badge">Local</span>
      </div>
      <div className="service-list">
        {entries.map(([name, ready, service]) => (
          <div className="service-row" key={name}>
            <strong>{name}</strong>
            <span>
              <i className={"dot " + (ready ? "green" : "amber")} />
              {!p ? "Đang kiểm tra" : ready ? "Sẵn sàng" : "Chưa sẵn sàng"}
            </span>
            {!ready && (
              <button
                className="text-button"
                disabled={!!busy || !p}
                onClick={() =>
                  service && ["worker", "vieneu", "korva"].includes(service)
                    ? void start(service)
                    : setSetup(true)
                }
              >
                {busy === service
                  ? "Đang mở…"
                  : service && ["worker", "vieneu", "korva"].includes(service)
                    ? "Khởi động"
                    : "Thiết lập"}
              </button>
            )}
          </div>
        ))}
      </div>
      {detail && (
        <div className="notice error" role="alert">
          Dịch vụ chưa khởi động được.
          <details>
            <summary>Chi tiết</summary>
            <pre>{detail}</pre>
          </details>
        </div>
      )}
      {setup && (
        <div className="modal-backdrop" onClick={() => setSetup(false)}>
          <section
            className="card setup-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Thiết lập AI"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Thiết lập AI trên máy</h2>
            <p>
              {install?.hardware
                ? `${install.hardware.gpu || "CPU"} · ${install.hardware.vram_gb} GB VRAM`
                : "Cài môi trường riêng và kiểm tra GPU."}
            </p>
            {install?.hardware &&
              (!install.hardware.bf16 || install.hardware.vram_gb < 8) && (
                <p className="notice">
                  FLUX.2 cần nhiều bộ nhớ GPU hơn cấu hình hiện tại. Local Fast
                  là lựa chọn cần benchmark riêng.
                </p>
              )}
            <button
              disabled={!!busy || install?.state === "running"}
              onClick={() => void setupAI("install")}
            >
              Cài / kiểm tra môi trường AI
            </button>
            <label className="check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              Tôi đồng ý tải SD-Turbo (~2,6 GB). Tải model lần đầu có thể mất
              nhiều thời gian.
            </label>
            <button
              disabled={!consent || !!busy || install?.state === "running"}
              onClick={() => void setupAI("download")}
            >
              Tải model Local Fast
            </button>
            <p role="status">
              {install?.state === "running"
                ? "Đang thiết lập…"
                : install?.state === "done"
                  ? "Đã kiểm tra môi trường; model cần kiểm tra riêng."
                  : install?.state === "error"
                    ? "Thiết lập lỗi. Xem nhật ký."
                    : ""}
            </p>
            <details>
              <summary>Nhật ký thiết lập</summary>
              <pre>{install?.log || "Chưa có nhật ký."}</pre>
            </details>
            <p>
              Cài môi trường và tải model phù hợp với GPU trước khi dùng FLUX.2
              hoặc Wan2.2. Ứng dụng không tự tải model.
            </p>
            <p>
              Hướng dẫn nằm trong <code>docs/LOCAL_AI_WORKERS.md</code>. Giọng
              đọc: <code>docs/LOCAL_TTS.md</code>. FFmpeg và ffprobe cần được
              cài trên máy.
            </p>
            <button className="primary" onClick={() => setSetup(false)}>
              Đã hiểu
            </button>
          </section>
        </div>
      )}
    </section>
  );
}
