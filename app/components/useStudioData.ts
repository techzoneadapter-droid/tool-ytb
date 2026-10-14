"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StudioData } from "./studio-api";
export function useStudioData() {
  const [data, setData] = useState<StudioData>({ projects: [], jobs: [] });
  const [error, setError] = useState("");
  const version = useRef(0);
  const hasActiveJobs = useRef(false);
  const refresh = useCallback(async () => {
    const id = ++version.current;
    const r = await fetch("/api/studio", { cache: "no-store" });
    if (!r.ok) throw Error("Không đọc được dữ liệu.");
    const snapshot = await r.json();
    if (id === version.current) {
      hasActiveJobs.current = snapshot.jobs.some((job: { status: string }) =>
        ["queued", "audio", "images", "rendering", "paused"].includes(job.status),
      );
      setData(snapshot);
      setError("");
    }
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        await refresh();
      } catch {
        if (!stopped) setError("Mất kết nối. Đang thử kết nối lại…");
      }
      if (!stopped) timer = setTimeout(poll, hasActiveJobs.current ? 3000 : 10000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ++version.current;
    };
  }, [refresh]);
  return { data, error, refresh };
}
