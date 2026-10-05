"use client";
import { useEffect, useRef, useState } from "react";
import type {
  ImageAPIProvider,
  ImageAPIOptions,
} from "@/modules/providers/image-api-options";
import type { imageAPIStatus } from "@/modules/providers/image-api";
import { request } from "../studio-api";

type Status = ReturnType<typeof imageAPIStatus>[ImageAPIProvider];
export function ImageAPIConnection({
  provider,
  status,
  model,
  options,
  onOptions,
  onModel,
  refresh,
}: {
  provider: ImageAPIProvider;
  status?: Status;
  model?: string;
  options?: ImageAPIOptions;
  onOptions: (options: ImageAPIOptions) => void;
  onModel: (model: string) => void;
  refresh: () => Promise<void>;
}) {
  const [current, setCurrent] = useState(status);
  const [key, setKey] = useState("");
  const [baseURL, setBaseURL] = useState(status?.baseURL || "");
  const [customModel, setCustomModel] = useState(model || status?.model || "");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (status) {
      setCurrent(status);
      if (status.baseURL) setBaseURL(status.baseURL);
    }
  }, [status]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/image/providers", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw Error("Không tải được cấu hình kết nối.");
        return response.json();
      })
      .then((data) => {
        if (!controller.signal.aborted) setCurrent(data.providers[provider]);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [provider]);

  async function connect() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const data = await request<{
        providers: ReturnType<typeof imageAPIStatus>;
        model: string;
      }>(
        {
          action: "connect",
          provider,
          key: key.trim() || undefined,
          ...(provider === "api-compatible"
            ? {
                baseURL: baseURL.trim(),
                model: customModel.trim() || undefined,
              }
            : {}),
        },
        "/api/image/providers",
      );
      if (!mounted.current) return;
      setCurrent(data.providers[provider]);
      setKey("");
      setVisible(false);
      onModel(data.model);
      setMessage(
        `Đã kết nối và lưu key · ${data.providers[provider].models.length} model tạo ảnh.`,
      );
      await refresh();
    } catch (error) {
      if (mounted.current) {
        setError(
          error instanceof Error ? error.message : "Không kết nối được API.",
        );
        await refresh().catch(() => {});
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function select(model: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const data = await request<{
        providers: ReturnType<typeof imageAPIStatus>;
      }>({ action: "select", provider, model }, "/api/image/providers");
      if (!mounted.current) return;
      setCurrent(data.providers[provider]);
      onModel(model);
      setMessage("Đã chọn model. Lựa chọn này sẽ được dùng khi tạo ảnh/video.");
      await refresh();
    } catch (error) {
      if (mounted.current)
        setError(
          error instanceof Error ? error.message : "Không lưu được model.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const selected = model || current?.model || "";
  const models = current?.models || [];
  return (
    <div
      className="image-api-connection"
      style={{ display: "grid", gap: 12, marginBlock: 12 }}
    >
      <p className="notice">
        1 chương = 1 ảnh master · các cảnh dùng chung ảnh, audio và phụ đề.
      </p>
      {provider === "api-compatible" && (
        <>
          <label>
            Base URL (bao gồm /v1 nếu API yêu cầu)
            <input
              value={baseURL}
              disabled={busy}
              placeholder="https://your-image-api.example/v1"
              onChange={(event) => setBaseURL(event.target.value)}
            />
          </label>
          <label>
            Model ảnh riêng (tùy chọn)
            <input
              value={customModel}
              disabled={busy}
              placeholder="Mã model hỗ trợ /images/generations"
              onChange={(event) => setCustomModel(event.target.value)}
            />
          </label>
          <p className="notice">
            API cần hỗ trợ /models và /images/generations; reference cần
            /images/edits. Chỉ chọn model có khả năng tạo ảnh.
          </p>
        </>
      )}
      <label htmlFor={`image-api-key-${provider}`}>API key</label>
      <div className="row">
        <input
          id={`image-api-key-${provider}`}
          type={visible ? "text" : "password"}
          value={key}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          placeholder={
            current?.configured
              ? "Đã có key · để trống để dùng key hiện tại"
              : "Dán API key của bạn"
          }
          onChange={(event) => {
            setKey(event.target.value);
            setError("");
            setMessage("");
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => setVisible((value) => !value)}
          aria-label={visible ? "Ẩn API key" : "Hiện API key"}
        >
          {visible ? "Ẩn" : "Hiện"}
        </button>
      </div>
      <button
        type="button"
        className="primary"
        disabled={busy || (!key.trim() && !current?.configured)}
        onClick={() => void connect()}
      >
        {busy ? "Đang xử lý…" : "Kết nối & lấy danh sách model"}
      </button>
      <label htmlFor={`image-api-model-${provider}`}>Model tạo ảnh</label>
      <select
        id={`image-api-model-${provider}`}
        value={models.some((item) => item.id === selected) ? selected : ""}
        disabled={busy || !current?.connected || !models.length}
        onChange={(event) => void select(event.target.value)}
      >
        {!models.some((item) => item.id === selected) && (
          <option value="">
            {models.length
              ? "Chọn model từ danh sách"
              : "Kết nối API để tải model"}
          </option>
        )}
        {models.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label} · {item.id}
          </option>
        ))}
      </select>
      <p className="notice">
        {current?.connected
          ? "Đã kết nối API."
          : current?.configured
            ? "Đã có key, chưa kiểm tra kết nối."
            : "Chưa kết nối API."}{" "}
        Key lưu trên máy này, không đưa lên Git và không trả về trình duyệt.
        Kiểm tra kết nối không tạo ảnh; hạn mức tạo ảnh được kiểm tra khi chạy.
      </p>
      {current?.catalogSource === "stability-endpoints" && (
        <p className="notice">
          Core/Ultra là danh sách endpoint Stability được ứng dụng hỗ trợ; key
          đã được kiểm tra qua API tài khoản.
        </p>
      )}
      <p className="notice">
        {provider === "stability"
          ? selected === "ultra"
            ? "Ultra: reference ảnh đơn + seed + negative prompt."
            : "Core: Character Bible text + seed + negative prompt; không có reference input."
          : provider === "api-compatible"
            ? "Bật capability bên dưới theo tài liệu model của API riêng."
            : "GPT Image/Gemini image: portrait reference; seed không được gửi."}
      </p>
      <details>
        <summary>Cấu hình tạo ảnh & đồng nhất nhân vật</summary>
        <div style={{ display: "grid", gap: 12, paddingTop: 12 }}>
          <label>
            Kích thước API
            <select
              value={options?.size || "auto"}
              disabled={provider === "gemini" || provider === "stability"}
              onChange={(event) =>
                onOptions({
                  ...options,
                  size: event.target.value as ImageAPIOptions["size"],
                })
              }
            >
              {["auto", "1024x1024", "1024x1536", "1536x1024"].map((size) => (
                <option key={size} value={size}>
                  {size === "auto" ? "Theo tỷ lệ video" : size}
                </option>
              ))}
            </select>
            {(provider === "gemini" || provider === "stability") && (
              <small>
                API dùng độ phân giải native của model; tỷ lệ ảnh theo video.
              </small>
            )}
          </label>
          {provider === "stability" && selected === "ultra" && (
            <label>
              Mức thay đổi ảnh reference (0 giữ nguyên, 1 thay đổi toàn bộ)
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={options?.referenceStrength ?? 0.65}
                onChange={(event) =>
                  onOptions({
                    ...options,
                    referenceStrength: Math.min(
                      1,
                      Math.max(0, Number(event.target.value)),
                    ),
                  })
                }
              />
            </label>
          )}
          <label>
            Luồng API tối đa
            <input
              type="number"
              min={1}
              max={4}
              value={options?.concurrency ?? 2}
              onChange={(event) =>
                onOptions({
                  ...options,
                  concurrency: Math.max(
                    1,
                    Math.min(4, Number(event.target.value)),
                  ),
                })
              }
            />
          </label>
          <label>
            Timeout (giây)
            <input
              type="number"
              min={10}
              max={600}
              value={options?.timeoutSeconds ?? 240}
              onChange={(event) =>
                onOptions({
                  ...options,
                  timeoutSeconds: Math.max(
                    10,
                    Math.min(600, Number(event.target.value)),
                  ),
                })
              }
            />
          </label>
          <label>
            Số lần retry
            <input
              type="number"
              min={0}
              max={5}
              value={options?.retries ?? 2}
              onChange={(event) =>
                onOptions({
                  ...options,
                  retries: Math.max(0, Math.min(5, Number(event.target.value))),
                })
              }
            />
          </label>
          <label>
            Seed (khi model hỗ trợ)
            <select
              value={options?.seedMode || "project"}
              onChange={(event) =>
                onOptions({
                  ...options,
                  seedMode: event.target.value as ImageAPIOptions["seedMode"],
                })
              }
            >
              <option value="project">Cố định theo dự án</option>
              <option value="chapter">Cố định theo chương</option>
              <option value="off">Không gửi seed</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={options?.references !== false}
              onChange={(event) =>
                onOptions({ ...options, references: event.target.checked })
              }
            />
            Tạo và dùng lại portrait nhân vật (model hỗ trợ reference)
          </label>
          {provider === "api-compatible" &&
            (
              [
                ["supportsReferenceImages", "Reference image"],
                [
                  "supportsMultiImageInput",
                  "Nhiều reference trong một yêu cầu",
                ],
                ["supportsSeed", "Seed"],
                ["supportsNegativePrompt", "Negative prompt riêng"],
              ] as const
            ).map(([field, label]) => (
              <label className="check" key={field}>
                <input
                  type="checkbox"
                  checked={options?.[field] === true}
                  onChange={(event) =>
                    onOptions({ ...options, [field]: event.target.checked })
                  }
                />
                API/model hỗ trợ {label}
              </label>
            ))}
          <label className="check">
            <input
              type="checkbox"
              checked={options?.debug === true}
              onChange={(event) =>
                onOptions({ ...options, debug: event.target.checked })
              }
            />
            Debug: xem prompt, negative, character block và metadata trong hồ sơ
            chương
          </label>
          <p className="notice">
            Character Bible và portrait được lưu theo dự án. Retry 429/timeout
            có thể tạo thêm chi phí nếu yêu cầu trước đã được nhà cung cấp xử
            lý.
          </p>
        </div>
      </details>
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
    </div>
  );
}
