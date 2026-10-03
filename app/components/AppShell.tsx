"use client";
import { useEffect, useState } from "react";
import { BookOpen, Clapperboard, Radio, Layers } from "lucide-react";
import { useStudioData } from "./useStudioData";
import { StoryImportPage } from "./story/StoryImportPage";
import { VideoCreatePage } from "./video/VideoCreatePage";
import { ChannelManagerPage } from "./channel/ChannelManagerPage";
const tabs = [
  { name: "Nhập truyện", icon: BookOpen },
  { name: "Tạo video", icon: Clapperboard },
  { name: "Quản lý kênh", icon: Radio },
];
export default function AppShell() {
  const [tab, setTab] = useState(0),
    [projectId, setProjectId] = useState("");
  const { data, error, refresh } = useStudioData();
  useEffect(() => {
    try {
      setProjectId(localStorage.getItem("storyflow-project") || "");
    } catch {}
  }, []);
  function selectProject(id: string) {
    setProjectId(id);
    try {
      localStorage.setItem("storyflow-project", id);
    } catch {}
  }
  function open(id: string) {
    selectProject(id);
    setTab(1);
  }
  const ready =
    data.providers?.runtime.worker &&
    data.providers.runtime.ffmpeg &&
    data.providers.local.vieneu.ready &&
    data.providers.runtime.flux;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="StoryFlow">
          <span className="brand-icon">
            <Layers size={24} />
          </span>
          StoryFlow<span className="brand-dot">.</span>
        </a>
        <span className="sidebar-caption">KHÔNG GIAN SÁNG TẠO</span>
        <nav aria-label="Điều hướng chính">
          {tabs.map((t, i) => (
            <button
              key={t.name}
              aria-current={tab === i ? "page" : undefined}
              className={tab === i ? "nav-item active" : "nav-item"}
              onClick={() => setTab(i)}
            >
              <t.icon size={20} />
              <span>{t.name}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={"dot " + (ready ? "green" : "amber")} />
          {!data.providers
            ? "Đang kiểm tra hệ thống"
            : ready
              ? "Hệ thống sẵn sàng"
              : "Cần thiết lập AI"}
          <small>Không gian cho những câu chuyện.</small>
        </div>
      </aside>
      <main>
        <div className="topbar">
          <span>STORYFLOW STUDIO</span>
          <span className="local-badge">Sáng tạo trên máy của bạn</span>
        </div>
        <div className="workspace">
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <div hidden={tab !== 0}>
            <StoryImportPage
              projects={data.projects}
              refresh={refresh}
              onOpen={open}
            />
          </div>
          {tab === 1 && (
            <VideoCreatePage
              data={data}
              projectId={projectId}
              onProject={selectProject}
              refresh={refresh}
              onImport={() => setTab(0)}
            />
          )}{" "}
          {tab === 2 && <ChannelManagerPage />}
        </div>
      </main>
    </div>
  );
}
