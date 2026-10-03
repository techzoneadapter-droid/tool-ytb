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

  const primary = [
    ["VieNeu Cloud", p?.modal?.tts?.ready, p?.modal?.tts?.configured, ""],
    ["Story AI Cloud", p?.modal?.image?.ready, p?.modal?.image?.configured, ""],
    ["FFmpeg", p?.runtime.ffmpeg, true, ""],
    ["Worker", p?.runtime.worker, true, "worker"],
  ] as const;

  const local = [
    ["VieNeu Local", p?.local.vieneu.ready, "vieneu"],
    ["Korva Local", p?.local.korva.ready, "korva"],
    ["FLUX.2 Local", p?.runtime.flux, "flux"],
    ["Local Fast", p?.runtime.fast, "fast"],
    ["Wan2.2", p?.runtime.wan, "wan"],
  ] as const;

  return (
    <section className="card system-card">
      <div className="row between">
        <h2>Hệ thống</h2>
        <span className="badge">Cloud ưu tiên</span>
      </div>

      <div className="service-list">
        {primary.map(([name, ready, configured, service]) => (
          <div className="service-row" key={name}>
            <strong>{name}</strong>
            <span>
              <i className={"dot " + (ready ? "green" : "amber")} />
              {!p
                ? "Đang kiểm tra"
                : ready
                  ? "Sẵn sàng"
                  : configured
                    ? "Chưa kết nối"
                    : "Chưa cấu hình"}
            </span>
            {!ready && service === "worker" && (
              <button
                className="text-button"
                disabled={!!busy || !p}
                onClick={() => void start(service)}
              >
                {busy === service ? "Đang mở…" : "Khởi động"}
              </button>
            )}
          </div>
        ))}
      </div>

      <details className="local-services">
        <summary>Engine local dự phòng</summary>
        <div className="service-list">
          {local.map(([name, ready, service]) => (
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
                    ["vieneu", "korva"].includes(service)
                      ? void start(service)
                      : setSetup(true)
                  }
                >
                  {busy === service
                    ? "Đang mở…"
                    : ["vieneu", "korva"].includes(service)
                      ? "Khởi động"
                      : "Thiết lập"}
                </button>
              )}
            </div>
          ))}
        </div>
      </details>

      {(!p?.modal?.tts?.configured || !p?.modal?.image?.configured) && (
        <p className="muted cloud-hint">
          Cloud chưa cấu hình đầy đủ. Deploy trong <code>cloud/modal</code> rồi
          đặt <code>MODAL_TTS_URL</code> và <code>MODAL_IMAGE_URL</code> trong
          <code>.env.local</code>.
        </p>
      )}

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
            aria-label="Thiết lập AI local"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Thiết lập AI local dự phòng</h2>
            <p>
              {install?.hardware
                ? `${install.hardware.gpu || "CPU"} · ${install.hardware.vram_gb} GB VRAM`
                : "Kiểm tra môi trường AI trên máy."}
            </p>
            {install?.hardware &&
              (!install.hardware.bf16 || install.hardware.vram_gb < 8) && (
                <p className="notice">
                  GPU hiện tại không phù hợp để coi FLUX.2 local là engine chính.
                  Nên dùng Story AI Cloud và chỉ giữ local làm dự phòng.
                </p>
              )}
            <button
              disabled={!!busy || install?.state === "running"}
              onClick={() => void setupAI("install")}
            >
              Cài / kiểm tra môi trường local
            </button>
            <label className="check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              Tôi đồng ý tải model Local Fast khi cần.
            </label>
            <button
              disabled={!consent || !!busy || install?.state === "running"}
              onClick={() => void setupAI("download")}
            >
              Tải model Local Fast
            </button>
            <details>
              <summary>Nhật ký thiết lập</summary>
              <pre>{install?.log || "Chưa có nhật ký."}</pre>
            </details>
            <button className="primary" onClick={() => setSetup(false)}>
              Đóng
            </button>
          </section>
        </div>
      )}
    </section>
  );
}
