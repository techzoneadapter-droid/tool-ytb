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
          Giữ mô tả nhân vật ổn định trong từng chương. Có thể sửa hồ sơ trước
          khi tạo ảnh. Seed và prompt hỗ trợ tính nhất quán, không bảo đảm cùng
          khuôn mặt.
        </p>
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
            {chapter.scenes
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
