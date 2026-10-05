import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isSameOrigin } from "@/modules/project/request";
import { get, list, put, remove } from "@/modules/project/store";
import type { Job, Project, VideoRecord } from "@/modules/project/types";
import {
  listVideos,
  migrateCompletedJobs,
  removeVideoRecord,
  removeVideoRecords,
} from "@/modules/videoLibrary";
import { startService } from "@/modules/providers/services";

export const runtime = "nodejs";

export async function GET() {
  await migrateCompletedJobs();
  return NextResponse.json({
    videos: listVideos(),
    history: list<Job>("job").slice(0, 250),
  });
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
      .enum(["delete", "deleteMany", "regenerate", "merge", "clearHistory"])
      .parse(body.action);

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
    await startService("worker");
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
