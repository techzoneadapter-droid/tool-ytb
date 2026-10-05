import { useState } from "react";
import type { Project } from "@/modules/project/types";
import { request, fileURL } from "../studio-api";
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
            : "1 chương = 1 ảnh master. Character Bible giữ danh tính xuyên suốt dự án; model hỗ trợ reference sẽ dùng lại portrait nhân vật. Các cảnh dùng cùng ảnh master đã lưu trong app."}
        </p>
        {project.characterBible && (
          <details>
            <summary>CharacterBible · cấp dự án</summary>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                setBusy(true);
                setError("");
                try {
                  await request({
                    action: "characterBible",
                    projectId: project.id,
                    characters: JSON.parse(
                      String(
                        new FormData(event.currentTarget).get("characters"),
                      ),
                    ),
                  });
                  await refresh();
                } catch (error) {
                  setError(
                    error instanceof Error
                      ? error.message
                      : "Không lưu được Character Bible.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              <p>
                Chỉnh danh tính/primary trước khi tạo ảnh. Mô tả chuẩn tự cập nhật
                khi sửa đặc điểm; có thể nhập normalizedPrompt riêng. Portrait đã lưu được
                dùng lại khi mô tả không đổi.
              </p>
              <textarea
                name="characters"
                key={JSON.stringify(project.characterBible.characters)}
                defaultValue={JSON.stringify(
                  project.characterBible.characters,
                  null,
                  2,
                )}
                rows={14}
              />
              <button disabled={busy}>Lưu Character Bible</button>
            </form>
            {project.characterBible.characters
              .filter((character) => character.portrait)
              .map((character) => (
                <figure key={character.characterId}>
                  <img
                      src={fileURL(character.portrait!.file)}
                    alt={`Portrait ${character.name}`}
                    style={{
                      maxWidth: 160,
                      maxHeight: 160,
                      objectFit: "contain",
                    }}
                  />
                  <figcaption>{character.name} · portrait đã lưu</figcaption>
                </figure>
              ))}
          </details>
        )}
        {project.chapters.map((chapter) => (
          <details key={chapter.id}>
            <summary>{chapter.title}</summary>
            {chapter.apiImage && (
              <details>
                <summary>
                  Ảnh master chương · {chapter.apiImage.status} ·{" "}
                  {chapter.apiImage.engine} · {chapter.apiImage.model}
                </summary>
                {chapter.apiImage.file && (
                  <img
                    src={fileURL(chapter.apiImage.file)}
                    alt={`Ảnh master ${chapter.title}`}
                    style={{
                      maxWidth: "100%",
                      maxHeight: 350,
                      objectFit: "contain",
                    }}
                  />
                )}
                <p>
                  {chapter.apiImage.characterIds.length} nhân vật ·{" "}
                  {chapter.apiImage.referenceFiles.length} reference · Seed{" "}
                  {chapter.apiImage.seed}
                </p>
                {chapter.apiImage.errorCode && (
                  <p role="alert">
                    {chapter.apiImage.errorCode}:{" "}
                    {chapter.apiImage.errorMessage}
                  </p>
                )}
                {chapter.apiImage.metadata?.usage && (
                  <p>
                    Usage API: {JSON.stringify(chapter.apiImage.metadata.usage)}
                  </p>
                )}
                {chapter.imageAnalysis && (
                  <pre>{JSON.stringify(chapter.imageAnalysis, null, 2)}</pre>
                )}
                {project.settings.imageAPIOptions?.debug && (
                  <>
                    <pre>{chapter.apiImage.prompt}</pre>
                    <pre>Negative: {chapter.apiImage.negativePrompt}</pre>
                    <pre>{chapter.apiImage.characterBlock}</pre>
                    <pre>
                      {JSON.stringify(chapter.apiImage.metadata, null, 2)}
                    </pre>
                  </>
                )}
              </details>
            )}
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
            {project.settings.imageProvider === "flow-browser" &&
            chapter.masterImage ? (
              <details>
                <summary>
                  Ảnh master chương ·{" "}
                  {chapter.masterImage.status === "ready"
                    ? "✓ Sẵn sàng"
                    : chapter.masterImage.status === "error"
                      ? "Lỗi"
                      : "Đang xử lý"}
                </summary>
                <pre>{chapter.masterImage.prompt}</pre>
              </details>
            ) : (
              !chapter.apiImage &&
              chapter.scenes
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
                ))
            )}
          </details>
        ))}
        {error && <p role="alert">{error}</p>}
      </div>
    </details>
  );
}
