import { NextResponse } from "next/server";
import { z } from "zod";
import { get } from "@/modules/project/store";
import type { Job, Project } from "@/modules/project/types";
import { verifiedScene } from "@/modules/project/media";
import { usesMotion } from "@/modules/providers/local-workers";
export const runtime = "nodejs";
export async function GET(
  _req: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    const job = get<Job>(z.string().uuid().parse(jobId), "job");
    if (job.kind !== "motion") throw Error("Không phải tác vụ ảnh động.");
    const project = get<Project>(job.projectId, "project");
    const scenes = project.chapters
      .filter((c) => job.chapterIds.includes(c.id))
      .flatMap((c) => c.scenes)
      .filter((s) => !job.sceneIds || job.sceneIds.includes(s.id))
      .filter((s) => usesMotion(s, job.snapshot.settings))
      .map(verifiedScene);
    return NextResponse.json({
      ok: true,
      job,
      scenes: scenes.map((s) => ({
        id: s.id,
        status: s.motionStatus,
        error: s.motionError,
        videoUrl:
          s.motion && s.motionStatus === "done"
            ? "/generated/motion/" + s.motion
            : undefined,
      })),
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Không tìm thấy tác vụ ảnh động." },
      { status: 404 },
    );
  }
}
