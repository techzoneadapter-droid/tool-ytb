"use client";
import { useEffect, useState } from "react";
import { Download } from "lucide-react";
export function UpdateButton() {
  const [state, setState] = useState<DesktopUpdateState>();
  const [error, setError] = useState("");
  useEffect(() => {
    const desktop = window.storyflowDesktop;
    if (!desktop) return;
    let mounted = true;
    void desktop
      .getState()
      .then((value) => {
        if (mounted) setState(value);
      })
      .catch(() => {});
    const remove = desktop.onState((value) => setState(value));
    return () => {
      mounted = false;
      remove();
    };
  }, []);
  if (!state) return null;
  const busy = ["checking", "downloading", "waiting", "installing"].includes(
    state.phase,
  );
  async function update() {
    setError("");
    try {
      await window.storyflowDesktop?.update();
    } catch {
      setError("Chưa cập nhật được. Bấm thử lại.");
    }
  }
  return (
    <div className="desktop-update">
      <button
        data-storyflow-update
        className="nav-item"
        disabled={busy || state.phase === "development"}
        onClick={() => void update()}
      >
        <Download size={18} />
        <span>
          {state.phase === "downloading"
            ? `Đang tải ${state.percent}%`
            : state.phase === "checking"
              ? "Đang kiểm tra…"
              : state.phase === "installing"
                ? "Đang cài…"
                : state.phase === "waiting"
                  ? "Chờ cài bản mới"
                  : "Cập nhật"}
        </span>
      </button>
      <small>
        StoryFlow {state.version}
        {state.nextVersion ? ` → ${state.nextVersion}` : ""}
      </small>
      <p role="status" aria-live="polite">
        {error || state.message}
      </p>
      <button
        className="text-button"
        disabled={busy}
        onClick={() =>
          void window.storyflowDesktop
            ?.chooseWorkspace()
            .catch(() => setError("Chưa đổi được thư mục dữ liệu."))
        }
      >
        Chọn thư mục dữ liệu
      </button>
      <small title={state.workspace} className="desktop-workspace">
        {state.workspace}
      </small>
    </div>
  );
}
