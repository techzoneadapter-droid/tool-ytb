import { useState } from "react";
import type { Project } from "@/modules/project/types";
import { request } from "../studio-api";
export function VisualProfiles({
  project,
  refresh,
}: {
  project: Project;
  refresh: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <details className="card advanced">
      <summary>Nhân vật, bối cảnh và prompt ảnh</summary>
      <div className="advanced-body">
        <p>
          {project.settings.imageProvider === "flow-browser"
            ? "CharacterBible của dự án được dùng lại giữa các chương. Mỗi chương tạo một ảnh master cho tất cả cảnh. Hồ sơ chương bổ sung bối cảnh; danh tính nhân vật dùng CharacterBible đã lưu."
            : "Giữ mô tả nhân vật ổn định trong từng chương. Có thể sửa hồ sơ trước khi tạo ảnh. Seed và prompt hỗ trợ tính nhất quán."}
        </p>
        {project.characterBible && (
          <details>
            <summary>CharacterBible · cấp dự án</summary>
            <pre>{JSON.stringify(project.characterBible.characters, null, 2)}</pre>
          </details>
        )}
        {project.chapters.map((chapter) => (
          <details key={chapter.id}>
            <summary>{chapter.title}</summary>
            {chapter.visualProfile && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const value = new FormData(e.currentTarget).get("profile");
                  setBusy(true);
                  setError("");
                  try {
                    await request({
                      action: "visualProfile",
                      projectId: project.id,
                      chapterId: chapter.id,
                      profile: JSON.parse(String(value)),
                    });
                    await refresh();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <label>
                  Hồ sơ hình ảnh (JSON)
                  <textarea
                    name="profile"
                    key={JSON.stringify(chapter.visualProfile)}
                    defaultValue={JSON.stringify(
                      chapter.visualProfile,
                      null,
                      2,
                    )}
                    rows={10}
                  />
                </label>
                <button disabled={busy}>Lưu hồ sơ chương</button>
              </form>
            )}
            {project.settings.imageProvider === "flow-browser" && chapter.masterImage ? (
              <details>
                <summary>Ảnh master chương · {chapter.masterImage.status === "ready" ? "✓ Sẵn sàng" : chapter.masterImage.status === "error" ? "Lỗi" : "Đang xử lý"}</summary>
                <pre>{chapter.masterImage.prompt}</pre>
              </details>
            ) : chapter.scenes
              .filter((s) => s.finalImagePrompt)
              .map((scene, i) => (
                <details key={scene.id}>
                  <summary>Xem prompt ảnh · cảnh {i + 1}</summary>
                  <p>
                    {scene.imageEngine} · {scene.imageModel} · Seed{" "}
                    {scene.imageSeed}
                  </p>
                  <pre>{scene.finalImagePrompt}</pre>
                </details>
              ))}
          </details>
        ))}
        {error && <p role="alert">{error}</p>}
      </div>
    </details>
  );
}
