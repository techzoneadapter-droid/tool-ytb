"use client";
import { useEffect, useState } from "react";
import { BookOpen, Clapperboard, Film, Radio, Layers } from "lucide-react";
import { useStudioData } from "./useStudioData";
import { StoryImportPage } from "./story/StoryImportPage";
import { VideoCreatePage } from "./video/VideoCreatePage";
import { VideoManagerPage } from "./videoLibrary/VideoManagerPage";
import { ChannelManagerPage } from "./channel/ChannelManagerPage";

const tabs = [
  { name: "Nhập truyện", icon: BookOpen },
  { name: "Tạo video", icon: Clapperboard },
  { name: "Quản lý video", icon: Film },
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

  function openCreate(id: string) {
    selectProject(id);
    setTab(1);
  }

  const ttsReady =
    !!data.providers?.modal?.tts?.ready ||
    !!data.providers?.local?.vieneu?.ready ||
    !!data.providers?.local?.korva?.ready;
  const ready =
    !!data.providers?.runtime?.worker &&
    !!data.providers?.runtime?.ffmpeg &&
    ttsReady;

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
          {tabs.map((item, index) => (
            <button
              key={item.name}
              aria-current={tab === index ? "page" : undefined}
              className={tab === index ? "nav-item active" : "nav-item"}
              onClick={() => setTab(index)}
            >
              <item.icon size={20} />
              <span>{item.name}</span>
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
          <span className="local-badge">AI cloud + dựng video trên máy</span>
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
              onOpen={openCreate}
            />
          </div>
          {tab === 1 && (
            <VideoCreatePage
              data={data}
              projectId={projectId}
              onProject={selectProject}
              refresh={refresh}
              onImport={() => setTab(0)}
              onLibrary={() => setTab(2)}
            />
          )}
          {tab === 2 && (
            <VideoManagerPage
              projects={data.projects}
              projectId={projectId}
              onProject={selectProject}
              onCreate={openCreate}
            />
          )}
          {tab === 3 && <ChannelManagerPage />}
        </div>
      </main>
    </div>
  );
}
