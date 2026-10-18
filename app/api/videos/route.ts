import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { isSameOrigin } from "@/modules/project/request";
import { get, list, listRecent, put, remove, updateJob, root } from "@/modules/project/store";
import { defaultRecoveryRoots, restoreMissingVideoFiles } from "@/modules/videoLibrary/recovery";
import type { Job, Project, VideoRecord } from "@/modules/project/types";
import {
  listVideos,
  migrateCompletedJobs,
  removeVideoRecord,
  removeVideoRecords,
} from "@/modules/videoLibrary";
import { startService } from "@/modules/providers/services";

import {
  uploadedImageSettings,
  uploadedImageRequired,
} from "@/modules/project/uploaded-image";
import { validImage } from "@/modules/project/media";

export const runtime = "nodejs";

// Import legacy MP4 records once in the background; never re-probe old MP4s
// on every browser refresh. New renders are indexed by the worker directly.
let migrationTask: Promise<void> | undefined;
let migrationDone = false;
function ensureLegacyIndex() {
  if (migrationDone || migrationTask) return;
  migrationTask = (async () => {
    const videos = list<VideoRecord>("video");
    if (videos.length) await restoreMissingVideoFiles(videos, path.join(root, "assets"), defaultRecoveryRoots(root));
    await migrateCompletedJobs();
  })()
    .then(() => { migrationDone = true; })
    .catch((error) => console.error("Không thể đồng bộ video cũ:", error))
    .finally(() => { migrationTask = undefined; });
}

export async function GET(req: NextRequest) {
  ensureLegacyIndex();
  const includeHistory = req.nextUrl.searchParams.get("history") === "1";
  return NextResponse.json({
    videos: listVideos(),
    history: includeHistory
      ? listRecent<Job>("job", 250).map(({ snapshot, outputs, completedItems, ttsRequests, ...job }) => job)
      : [],
    indexing: !migrationDone,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  try {
    if (!isSameOrigin(req))
      return NextResponse.json(
        { error: "Nguồn yêu cầu không hợp lệ." },
        { status: 403 },
      );

    const body = await req.json();
    const action = z
      .enum(["delete", "deleteMany", "regenerate", "merge", "clearHistory", "recover"])
      .parse(body.action);

    if (action === "recover") {
      const directory = z.string().trim().max(1024).optional().parse(body.directory);
      if (directory && !path.isAbsolute(directory)) throw Error("Chọn đường dẫn thư mục tuyệt đối trên máy.");
      const videos = list<VideoRecord>("video");
      const report = await restoreMissingVideoFiles(
        videos,
        path.join(root, "assets"),
        [...(directory ? [directory] : []), ...defaultRecoveryRoots(root)],
      );
      if (report.videosRestored) await migrateCompletedJobs();
      return NextResponse.json({ ok: true, recovery: report });
    }

    if (action === "deleteMany") {
      const ids = z
        .array(z.string().uuid())
        .min(1)
        .max(500)
        .parse(body.videoIds);
      const deleted = await removeVideoRecords([...new Set(ids)]);
      return NextResponse.json({ ok: true, deleted });
    }

    if (action === "delete") {
      const id = z.string().uuid().parse(body.videoId);
      await removeVideoRecord(id);
      return NextResponse.json({ ok: true });
    }

    if (action === "clearHistory") {
      const mode = z
        .enum(["done", "error", "done-and-error"])
        .default("done-and-error")
        .parse(body.mode);
      for (const job of list<Job>("job")) {
        if (
          (mode === "done" && job.status === "done") ||
          (mode === "error" && job.status === "error") ||
          (mode === "done-and-error" &&
            ["done", "error", "ready"].includes(job.status))
        )
          remove("job", job.id);
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "regenerate") {
      const video = get<VideoRecord>(
        z.string().uuid().parse(body.videoId),
        "video",
      );
      const project = get<Project>(video.projectId, "project");
      if (
        list<Job>("job").some(
          (job) =>
            job.projectId === project.id &&
            job.kind !== "merge-video" &&
            ["queued", "audio", "images", "rendering", "paused"].includes(
              job.status,
            ) &&
            job.chapterIds.some((id) => video.chapterIds.includes(id)),
        )
      )
        throw Error(
          "Chương này đang có tác vụ. Chờ tác vụ hiện tại kết thúc để tránh tạo trùng cảnh.",
        );
      project.settings = uploadedImageSettings(project.settings);
      if (!(await validImage(project.settings.fallbackImage)))
        throw Error(uploadedImageRequired);
      const regenerateResources = body.regenerateResources === true;
      const job: Job = {
        id: randomUUID(),
        projectId: project.id,
        chapterIds: [...video.chapterIds],
        sceneIds: video.sceneId ? [video.sceneId] : undefined,
        status: "queued",
        kind: regenerateResources ? "pipeline" : "render",
        regenerate: regenerateResources,
        progress: 0,
        message: regenerateResources
          ? "Chờ tạo lại tài nguyên và video"
          : "Chờ dựng lại bằng tài nguyên hiện có",
        createdAt: new Date().toISOString(),
        snapshot: { settings: structuredClone(project.settings) },
        outputTitle: video.title,
      };
      put("job", job);
      await startService("worker");
      return NextResponse.json({ ok: true, job });
    }

    const ids = z.array(z.string().uuid()).min(2).max(100).parse(body.videoIds);
    const videos = ids.map((id) => get<VideoRecord>(id, "video"));
    const projectId = videos[0].projectId;
    if (videos.some((video) => video.projectId !== projectId))
      throw Error("Chỉ có thể ghép video trong cùng một dự án.");
    const project = get<Project>(projectId, "project");
    const chapterIds = [
      ...new Set(
        project.chapters
          .filter((chapter) =>
            videos.some((video) => video.chapterIds.includes(chapter.id)),
          )
          .map((chapter) => chapter.id),
      ),
    ];
    const job: Job = {
      id: randomUUID(),
      projectId,
      chapterIds,
      sourceVideoIds: ids,
      mergeWithBumpers: body.mergeWithBumpers === true,
      outputTitle:
        z.string().trim().min(1).max(160).optional().parse(body.title) ||
        "Video đã ghép",
      status: "queued",
      kind: "merge-video",
      progress: 0,
      message: "Chờ ghép video",
      createdAt: new Date().toISOString(),
      snapshot: { settings: structuredClone(project.settings) },
    };
    put("job", job);
    // Return immediately: an Electron button should never wait for worker startup.
    // Any startup failure is preserved on this job, visible in the History tab.
    void startService("worker").catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      try {
        if (get<Job>(job.id, "job").status === "queued")
          updateJob(job.id, {
            status: "error",
            finishedAt: new Date().toISOString(),
            message: "Không khởi động được tiến trình ghép video",
            error: message,
          });
      } catch (storeError) {
        console.error("Không thể cập nhật lỗi tác vụ ghép:", storeError);
      }
    });
    return NextResponse.json({ ok: true, job });
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? "Dữ liệu yêu cầu chưa hợp lệ."
        : error instanceof Error
          ? error.message
          : "Không xử lý được yêu cầu.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
