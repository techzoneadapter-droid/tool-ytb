import { useEffect, useMemo, useState } from "react";
import type { Settings } from "@/modules/project/types";
import type { StudioData } from "../studio-api";
import { request } from "../studio-api";

export function ProviderStatus({
  providers: p,
  settings,
  refresh,
}: {
  providers: StudioData["providers"];
  settings: Settings;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const [detail, setDetail] = useState("");
  const [setup, setSetup] = useState(false);
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
        .then((response) => response.json())
        .then((data) => {
          if (active) setInstall(data);
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
    setDetail("");
    try {
      await request({ action, confirmed: consent }, "/api/ai/setup");
      setInstall({ state: "running" });
    } catch (error) {
      setDetail((error as Error).message);
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
    } catch (error) {
      setDetail((error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function openFlow() {
    setBusy("flow");
    setDetail("");
    try {
      await request({ action: "openFlow" });
      await refresh();
    } catch (error) {
      setDetail((error as Error).message);
    } finally {
      setBusy("");
    }
  }

  const current = useMemo(() => {
    const ttsProvider = settings.ttsProvider || "vieneu-local";
    const tts =
      ttsProvider === "modal-vieneu"
        ? {
            label: "VieNeu Cloud",
            ready: !!p?.modal?.tts?.ready,
            configured: !!p?.modal?.tts?.configured,
            service: "",
          }
        : ttsProvider === "edge-online"
          ? {
              label: "Edge TTS Online",
              ready: true,
              configured: true,
              service: "",
            }
        : ttsProvider === "pollinations"
          ? {
              label: "Pollinations TTS",
              ready: !!p?.freeCloud?.pollinations?.ready,
              configured: !!p?.freeCloud?.pollinations?.configured,
              service: "",
            }
        : ttsProvider === "korva-local"
          ? {
              label: "Korva Local",
              ready: !!p?.local.korva.ready,
              configured: true,
              service: "korva",
            }
          : {
              label: "VieNeu Local",
              ready: !!p?.local.vieneu.ready,
              configured: true,
              service: "vieneu",
            };

    const provider = settings.imageProvider || "flux2-local";
    const imageRaw =
      provider === "flow-browser"
        ? {
            label: "Google Flow · Nano Banana Pro · tài khoản của bạn",
            ready: !!p?.flow?.connected,
            configured: true,
            service: "flow",
          }
        : provider === "aihorde"
        ? {
            label: "AI Horde · miễn phí cộng đồng",
            ready: !!p?.freeCloud?.aiHorde?.ready,
            configured: true,
            service: "",
          }
        : provider === "pollinations"
          ? {
              label: "Pollinations Image · anonymous",
              ready: !!p?.freeCloud?.pollinations?.imageReady,
              configured: true,
              service: "",
            }
        : provider === "modal-story" || provider === "modal-reference"
        ? {
            label:
              provider === "modal-reference"
                ? "Reference AI Cloud"
                : "Story AI Cloud",
            ready: !!p?.modal?.image?.ready,
            configured: !!p?.modal?.image?.configured,
            service: "",
          }
        : provider === "local-fast" || provider === "auto-local"
          ? {
              label: "Local Fast",
              ready: !!p?.runtime.fast,
              configured: true,
              service: "fast",
            }
          : {
              label: "FLUX.2 Local",
              ready: !!p?.runtime.flux,
              configured: true,
              service: "flux",
            };

    const fallback =
      settings.imageEnabled !== false &&
      !!settings.fallbackImage &&
      settings.fallbackOnImageError === true;

    const image =
      settings.imageEnabled === false
        ? {
            label: settings.fallbackImage ? "Ảnh dùng chung" : "Ảnh có sẵn",
            ready: !!settings.fallbackImage,
            configured: true,
            service: "",
            fallback: true,
          }
        : !imageRaw.ready && fallback
          ? {
              label: "Ảnh dùng chung dự phòng",
              ready: true,
              configured: true,
              service: "",
              fallback: true,
            }
          : { ...imageRaw, fallback: false };

    const motionReady =
      settings.motionMode === "off" || !settings.motionMode || !!p?.runtime.wan;
    const ready =
      !!p &&
      tts.ready &&
      image.ready &&
      !!p.runtime.ffmpeg &&
      !!p.runtime.worker &&
      motionReady;

    return { tts, image, ready, motionReady };
  }, [p, settings]);

  const rows = [
    {
      name: "Lời đọc",
      value: current.tts.label,
      ready: current.tts.ready,
      configured: current.tts.configured,
      service: current.tts.service,
    },
    {
      name: "Hình ảnh",
      value: current.image.label,
      ready: current.image.ready,
      configured: current.image.configured,
      service: current.image.service,
    },
    {
      name: "FFmpeg",
      value: "Dựng video",
      ready: !!p?.runtime.ffmpeg,
      configured: true,
      service: "",
    },
    {
      name: "Worker",
      value: "Hàng đợi xử lý",
      ready: !!p?.runtime.worker,
      configured: true,
      service: "worker",
    },
  ];

  return (
    <section className="card system-card">
      <div className="row between">
        <h2>Hệ thống</h2>
        <span className={"badge " + (current.ready ? "ready" : "")}>
          {current.ready ? "Sẵn sàng tạo video" : "Cần hoàn tất thiết lập"}
        </span>
      </div>

      <div className="service-list current-route">
        {rows.map((row) => (
          <div className="service-row" key={row.name}>
            <span className="service-name">
              <strong>{row.name}</strong>
              <small>{row.value}</small>
            </span>
            <span>
              <i className={"dot " + (row.ready ? "green" : "amber")} />
              {!p
                ? "Đang kiểm tra"
                : row.ready
                  ? "Sẵn sàng"
                  : row.configured
                    ? "Chưa chạy"
                    : "Chưa cấu hình"}
            </span>
            {!row.ready && row.service && (
              <button
                className="text-button"
                disabled={!!busy || !p}
                onClick={() =>
                  row.service === "flow"
                    ? void openFlow()
                    : ["flux", "fast"].includes(row.service)
                      ? setSetup(true)
                      : void start(row.service)
                }
              >
                {busy === row.service
                  ? "Đang mở…"
                  : row.service === "flow"
                    ? "Kết nối Flow"
                    : "Khởi động"}
              </button>
            )}
          </div>
        ))}
      </div>

      {!current.motionReady && (
        <p className="notice">
          Ảnh động đang bật nhưng Wan2.2 chưa sẵn sàng. Tắt ảnh động hoặc thiết
          lập Wan2.2 trước khi chạy.
        </p>
      )}

      {!current.tts.configured && (
        <p className="notice">
          Engine giọng cloud đang được chọn nhưng chưa cấu hình. Có thể chọn
          VieNeu Local ngay, hoặc thêm endpoint/key tương ứng trong .env.local.
        </p>
      )}
      {!current.image.configured && !current.image.fallback && (
        <p className="notice">
          AI ảnh cloud đang được chọn nhưng chưa có endpoint. Có thể chọn engine
          local hoặc bật ảnh dùng chung dự phòng để vẫn dựng được video.
        </p>
      )}
      {settings.imageProvider === "flow-browser" && !p?.flow?.connected && (
        <p className="notice">
          StoryFlow sẽ gắn trực tiếp vào Chrome đang mở bằng Chrome DevTools
          Auto Connect. Lần đầu, Chrome sẽ yêu cầu bật Remote Debugging và xác
          nhận quyền; sau đó StoryFlow dùng chính phiên Flow Plus hiện tại.
        </p>
      )}
      {settings.imageProvider === "flow-browser" && (
        <button
          className="text-button"
          disabled={!!busy}
          onClick={() => void openFlow()}
        >
          {busy === "flow"
            ? "Đang kết nối…"
            : p?.flow?.connected
              ? "Kết nối lại Flow"
              : "Kết nối Chrome đang mở"}
        </button>
      )}

      <details className="local-services">
        <summary>Engine khác / dự phòng</summary>
        <div className="service-list">
          {[
            ["VieNeu Cloud", !!p?.modal?.tts?.ready],
            ["Edge TTS Online", true],
            ["Story AI Cloud", !!p?.modal?.image?.ready],
            ["Google Flow", !!p?.flow?.connected],
            ["AI Horde", !!p?.freeCloud?.aiHorde?.ready],
            ["Pollinations Image", !!p?.freeCloud?.pollinations?.imageReady],
            ["VieNeu Local", !!p?.local.vieneu.ready],
            ["Korva Local", !!p?.local.korva.ready],
            ["FLUX.2 Local", !!p?.runtime.flux],
            ["Local Fast", !!p?.runtime.fast],
            ["Wan2.2", !!p?.runtime.wan],
          ].map(([name, ready]) => (
            <div className="service-row compact" key={String(name)}>
              <strong>{name}</strong>
              <span>
                <i className={"dot " + (ready ? "green" : "amber")} />
                {ready ? "Sẵn sàng" : "Chưa dùng"}
              </span>
            </div>
          ))}
        </div>
      </details>

      {detail && (
        <div className="notice error" role="alert">
          Chưa khởi động được engine.
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
            onClick={(event) => event.stopPropagation()}
          >
            <h2>Thiết lập AI ảnh local</h2>
            <p>
              {install?.hardware
                ? `${install.hardware.gpu || "CPU"} · ${install.hardware.vram_gb} GB VRAM`
                : "Kiểm tra môi trường AI trên máy."}
            </p>
            {install?.hardware &&
              (!install.hardware.bf16 || install.hardware.vram_gb < 8) && (
                <p className="notice">
                  GPU này không phù hợp để chạy FLUX.2 nặng. Hãy dùng ảnh chung
                  dự phòng hoặc Story AI Cloud để quá trình ổn định hơn.
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
                onChange={(event) => setConsent(event.target.checked)}
              />
              Tôi đồng ý tải model Local Fast
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
