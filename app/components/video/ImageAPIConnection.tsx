"use client";
import { useEffect, useRef, useState } from "react";
import type { ImageAPIProvider } from "@/modules/providers/image-api-options";
import type { imageAPIStatus } from "@/modules/providers/image-api";
import { request } from "../studio-api";

type Status = ReturnType<typeof imageAPIStatus>[ImageAPIProvider];
export function ImageAPIConnection({ provider, status, model, onModel, refresh }: {
  provider: ImageAPIProvider;
  status?: Status;
  model?: string;
  onModel: (model: string) => void;
  refresh: () => Promise<void>;
}) {
  const [current, setCurrent] = useState(status);
  const [key, setKey] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (status) setCurrent(status); }, [status]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/image/providers", { cache: "no-store", signal: controller.signal })
      .then(response => { if (!response.ok) throw Error("Không tải được cấu hình kết nối."); return response.json(); })
      .then(data => { if (!controller.signal.aborted) setCurrent(data.providers[provider]); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [provider]);

  async function connect() {
    setBusy(true); setError(""); setMessage("");
    try {
      const data = await request<{ providers: ReturnType<typeof imageAPIStatus>; model: string }>({ action: "connect", provider, key: key.trim() || undefined }, "/api/image/providers");
      if (!mounted.current) return;
      setCurrent(data.providers[provider]);
      setKey(""); setVisible(false);
      onModel(data.model);
      setMessage(`Đã kết nối và lưu key · ${data.providers[provider].models.length} model tạo ảnh.`);
      await refresh();
    } catch (error) { if (mounted.current) { setError(error instanceof Error ? error.message : "Không kết nối được API."); await refresh().catch(() => {}); } }
    finally { if (mounted.current) setBusy(false); }
  }
  async function select(model: string) {
    setBusy(true); setError(""); setMessage("");
    try {
      const data = await request<{ providers: ReturnType<typeof imageAPIStatus> }>({ action: "select", provider, model }, "/api/image/providers");
      if (!mounted.current) return;
      setCurrent(data.providers[provider]); onModel(model);
      setMessage("Đã chọn model. Lựa chọn này sẽ được dùng khi tạo ảnh/video.");
      await refresh();
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "Không lưu được model."); }
    finally { if (mounted.current) setBusy(false); }
  }
  const selected = model || current?.model || "";
  const models = current?.models || [];
  return (
    <div className="image-api-connection" style={{ display: "grid", gap: 12, marginBlock: 12 }}>
      <label htmlFor={`image-api-key-${provider}`}>API key</label>
      <div className="row">
        <input id={`image-api-key-${provider}`} type={visible ? "text" : "password"}
          value={key} autoComplete="off" spellCheck={false} disabled={busy}
          placeholder={current?.configured ? "Đã có key · để trống để dùng key hiện tại" : "Dán API key của bạn"}
          onChange={event => { setKey(event.target.value); setError(""); setMessage(""); }} style={{ flex: 1, minWidth: 0 }} />
        <button type="button" className="text-button" disabled={busy} onClick={() => setVisible(value => !value)} aria-label={visible ? "Ẩn API key" : "Hiện API key"}>{visible ? "Ẩn" : "Hiện"}</button>
      </div>
      <button type="button" className="primary" disabled={busy || (!key.trim() && !current?.configured)} onClick={() => void connect()}>
        {busy ? "Đang xử lý…" : "Kết nối & lấy danh sách model"}
      </button>
      <label htmlFor={`image-api-model-${provider}`}>Model tạo ảnh</label>
      <select id={`image-api-model-${provider}`} value={models.some(item => item.id === selected) ? selected : ""}
        disabled={busy || !current?.connected || !models.length} onChange={event => void select(event.target.value)}>
        {!models.some(item => item.id === selected) && <option value="">{models.length ? "Chọn model từ danh sách" : "Kết nối API để tải model"}</option>}
        {models.map(item => <option key={item.id} value={item.id}>{item.label} · {item.id}</option>)}
      </select>
      <p className="notice">{current?.connected ? "Đã kết nối API." : current?.configured ? "Đã có key, chưa kiểm tra kết nối." : "Chưa kết nối API."} Key lưu trên máy này, không đưa lên Git và không trả về trình duyệt. Kiểm tra kết nối không tạo ảnh; hạn mức tạo ảnh được kiểm tra khi chạy.</p>
      {current?.catalogSource === "stability-endpoints" && <p className="notice">Core/Ultra là danh sách endpoint Stability được ứng dụng hỗ trợ; key đã được kiểm tra qua API tài khoản.</p>}
      {message && <p role="status" className="notice">{message}</p>}
      {error && <p role="alert" className="notice error">{error}</p>}
    </div>
  );
}
