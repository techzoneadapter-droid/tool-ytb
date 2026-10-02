import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { get, list, put, updateJob } from "@/modules/project/store";
import { defaults, type Project, type Job } from "@/modules/project/types";
import { parseChapters, plan, chunks } from "@/modules/project/parser";
import { sceneSchema, settingsSchema } from "@/modules/project/validation";
import { rewrite } from "@/modules/project/ai";
import { providerStatus, requireImage } from "@/modules/providers/config";
import { assertTTS, defaultTTSProvider } from "@/modules/tts";
import { localVoiceId } from "@/modules/tts/local-voices";
import { usesMotion } from "@/modules/providers/local-workers";
import { styledPrompt } from "@/modules/imagePrompt/styles";
import {
  requireSceneMedia,
  verifiedJob,
  assetExists,
  verifiedScene,
} from "@/modules/project/media";
import { isSameOrigin } from "@/modules/project/request";
const projectNameSchema = z
  .string({ error: "Vui lòng nhập tên dự án." })
  .trim()
  .min(1, "Vui lòng nhập tên dự án.")
  .max(120, "Tên dự án không được dài quá 120 ký tự.");
const storySchema = z
  .string({ error: "Vui lòng nhập nội dung truyện." })
  .trim()
  .min(1, "Vui lòng nhập nội dung truyện.")
  .max(2000000, "Nội dung không được vượt quá 2 triệu ký tự.");
export const runtime = "nodejs";
export async function GET() {
  return NextResponse.json({
    projects: list<Project>("project").map((p) => ({
      ...p,
      chapters: p.chapters.map((c) => ({
        ...c,
        scenes: c.scenes.map(verifiedScene),
      })),
    })),
    jobs: list<Job>("job").map(verifiedJob),
    providers: await providerStatus(),
    presets: list("preset"),
    hasKey: !!process.env.OPENAI_API_KEY,
  });
}
export async function POST(req: NextRequest) {
  try {
    if (!isSameOrigin(req))
      return NextResponse.json(
        {
          error:
            "Yêu cầu không xuất phát từ cửa sổ ứng dụng hiện tại. Vui lòng tải lại trang.",
        },
        { status: 403 },
      );
    const b = await req.json();
    if (b.action === "create") {
      const text = storySchema.parse(b.text);
      const project: Project = {
        id: randomUUID(),
        name: projectNameSchema.parse(b.name),
        createdAt: new Date().toISOString(),
        chapters: parseChapters(text),
        settings: {
          ...defaults,
          ttsProvider: defaultTTSProvider(),
          voice: localVoiceId(
            process.env.DEFAULT_VIETNAMESE_VOICE || "Ngọc Huyền",
          ),
          imageEnabled: true,
          imageProvider: "flux2-local",
          motionMode: "off",
        },
      };
      put("project", project);
      return NextResponse.json(project);
    }
    if (b.action === "preset") {
      const p = {
        id: randomUUID(),
        name: z.string().min(1).max(80).parse(b.name),
        prompt: z.string().min(1).max(2000).parse(b.prompt),
      };
      put("preset", p);
      return NextResponse.json(p);
    }
    if (b.action === "pause" || b.action === "resume" || b.action === "retry") {
      const j = get<Job>(z.string().uuid().parse(b.id), "job");
      if (
        b.action === "pause" &&
        !["done", "ready", "error"].includes(j.status)
      )
        updateJob(j.id, {
          status: "paused",
          message: "Tạm dừng sau công đoạn hiện tại",
        });
      else if (b.action !== "pause" && ["paused", "error"].includes(j.status))
        updateJob(j.id, {
          status: "queued",
          error: undefined,
          message: "Đã xếp lại hàng đợi",
          progress: 0,
        });
      return NextResponse.json({ ok: true });
    }
    const p = get<Project>(z.string().uuid().parse(b.projectId), "project");
    if (
      list<Job>("job").some(
        (j) =>
          j.projectId === p.id &&
          ["queued", "audio", "images", "rendering", "paused"].includes(
            j.status,
          ),
      )
    )
      throw Error(
        "Dự án đang có tác vụ trong hàng đợi. Hãy hoàn tất tác vụ trước khi chỉnh sửa hoặc thêm chương.",
      );
    if (b.action === "addChapter") {
      const title = z
        .string({ error: "Vui lòng nhập tên chương." })
        .trim()
        .min(1, "Vui lòng nhập tên chương.")
        .max(200, "Tên chương không được dài quá 200 ký tự.")
        .parse(b.title);
      const text = storySchema.parse(b.text);
      if (
        p.chapters.reduce((n, c) => n + c.text.length, 0) + text.length >
        2000000
      )
        throw Error("Tổng nội dung dự án không được vượt quá 2 triệu ký tự.");
      const scenes = plan(text, p.settings.style);
      for (const scene of scenes)
        if (p.settings.customPrompt)
          scene.prompt += ` Phong cách bổ sung: ${p.settings.customPrompt}`;
      p.chapters.push({ id: randomUUID(), title, text, scenes });
      put("project", p);
      return NextResponse.json(p);
    }
    if (b.action === "settings") {
      const settings = settingsSchema.parse(b.settings);
      if (
        (
          ["ttsProvider", "voice", "speed", "pitch", "volume", "pause"] as const
        ).some((key) => settings[key] !== p.settings[key])
      )
        for (const c of p.chapters)
          for (const scene of c.scenes) {
            scene.audio = undefined;
            scene.audioSource = undefined;
            scene.audioStatus = undefined;
            scene.audioError = undefined;
            scene.approved = false;
          }
      p.settings = settings;
      put("project", p);
      return NextResponse.json(p);
    }
    if (b.action === "scene") {
      const c = p.chapters.find((c) => c.id === b.chapterId);
      if (!c) throw Error("Không tìm thấy chương");
      const scene = sceneSchema.parse(b.scene);
      const i = c.scenes.findIndex((s) => s.id === scene.id);
      if (i < 0) throw Error("Không tìm thấy cảnh");
      const previous = c.scenes[i];
      if (scene.text !== c.scenes[i].text) {
        scene.audio = undefined;
        scene.approved = false;
      }
      if (scene.prompt !== c.scenes[i].prompt) {
        scene.image = undefined;
        scene.approved = false;
      }
      if (scene.image && scene.image !== previous.image) {
        const uploads = list<{ id: string }>("upload");
        if (
          !uploads.some((u) => u.id === scene.image) ||
          !assetExists(scene.image)
        )
          throw Error("Ảnh tải lên chưa hợp lệ.");
      }
      if (scene.audio && scene.audio !== previous.audio)
        throw Error("Không thể thay lời đọc bằng tệp chưa xác minh.");
      c.scenes[i] = {
        ...scene,
        motion:
          scene.image === previous.image && scene.prompt === previous.prompt
            ? previous.motion
            : undefined,
        motionStatus:
          scene.image === previous.image && scene.prompt === previous.prompt
            ? previous.motionStatus
            : undefined,
        motionError:
          scene.image === previous.image && scene.prompt === previous.prompt
            ? previous.motionError
            : undefined,
        audioSource: scene.audio ? previous.audioSource : undefined,
        imageSource: scene.image
          ? scene.image === previous.image
            ? previous.imageSource
            : "upload"
          : undefined,
        audioStatus: scene.audio ? previous.audioStatus : undefined,
        imageStatus: scene.image ? "done" : undefined,
      };
      put("project", p);
      return NextResponse.json(p);
    }
    if (b.action === "plan") {
      const ids = z.array(z.string().uuid()).min(1).parse(b.chapterIds);
      for (const c of p.chapters.filter((c) => ids.includes(c.id))) {
        let text = "";
        for (const part of chunks(c.text, 6000))
          text += (await rewrite(part, p.settings)) + "\n";
        c.scenes = plan(text, p.settings.style);
        for (const scene of c.scenes)
          scene.prompt = styledPrompt(
            scene.text,
            p.settings.style,
            p.settings.customPrompt,
          );
      }
      put("project", p);
      return NextResponse.json(p);
    }
    if (b.action === "enqueue") {
      const ids = z.array(z.string().uuid()).min(1).parse(b.chapterIds);
      if (ids.some((id) => !p.chapters.some((c) => c.id === id)))
        throw Error("Chương không hợp lệ");
      const prepare = !!b.prepare;
      const kind = z
        .enum(["audio", "image", "motion", "prepare", "render"])
        .parse(b.kind || (prepare ? "prepare" : "render"));
      const selected = p.chapters.filter((c) => ids.includes(c.id));
      const sceneIds = b.sceneIds
        ? z.array(z.string().uuid()).min(1).parse(b.sceneIds)
        : undefined;
      const scenes = selected
        .flatMap((c) => c.scenes)
        .filter((s) => !sceneIds || sceneIds.includes(s.id));
      if (
        !scenes.length ||
        sceneIds?.some((id) => !scenes.some((s) => s.id === id))
      )
        throw Error("Không tìm thấy cảnh cần xử lý.");
      if (kind === "audio" || kind === "prepare") assertTTS(p.settings);
      if (kind === "image" && p.settings.imageEnabled === false)
        throw Error("Tạo ảnh đang tắt. Hãy bật tạo ảnh hoặc tải ảnh lên.");
      if (
        (kind === "image" ||
          (kind === "prepare" && p.settings.imageEnabled !== false)) &&
        p.settings.imageProvider !== "flux2-local"
      )
        requireImage();
      if (kind === "motion") {
        if (!p.settings.motionMode || p.settings.motionMode === "off")
          throw Error("Ảnh động đang tắt. Chọn chế độ ảnh động trước.");
        const targets = scenes.filter((s) => usesMotion(s, p.settings));
        if (!targets.length) throw Error("Chưa chọn cảnh nào để tạo ảnh động.");
        for (const scene of targets)
          if (!scene.imageSource || !assetExists(scene.image))
            throw Error(
              "Cảnh được chọn chưa có ảnh thật. Tạo hoặc tải ảnh lên trước.",
            );
      }
      if (kind === "render")
        for (const scene of scenes) requireSceneMedia(scene);
      if (
        kind === "render" &&
        p.settings.humanCheck &&
        selected.some((c) =>
          c.scenes.some((s) => !s.approved || !s.audio || !s.image),
        )
      )
        throw Error(
          "Hãy tạo tài nguyên và duyệt tất cả cảnh trước khi render.",
        );
      const groups = b.merge
        ? [selected.map((c) => c.id)]
        : selected.map((c) => [c.id]);
      const jobs = groups.map((chapterIds) => {
        const j: Job & { prepare: boolean } = {
          id: randomUUID(),
          projectId: p.id,
          chapterIds,
          status: "queued",
          kind,
          sceneIds,
          progress: 0,
          message:
            kind === "render" ? "Chờ xuất video" : "Chờ tạo tài nguyên thật",
          createdAt: new Date().toISOString(),
          snapshot: { settings: structuredClone(p.settings) },
          prepare,
        };
        put("job", j);
        return j;
      });
      return NextResponse.json(jobs);
    }
    throw Error("Thao tác không hợp lệ");
  } catch (e) {
    const message =
      e instanceof z.ZodError
        ? e.issues
            .map((issue) =>
              /[À-ỹ]/u.test(issue.message)
                ? issue.message
                : "Dữ liệu nhập chưa hợp lệ. Vui lòng kiểm tra các ô và thử lại.",
            )
            .join(" ")
        : e instanceof SyntaxError
          ? "Dữ liệu gửi lên không hợp lệ. Vui lòng thử lại."
          : e instanceof Error
            ? e.message
            : "Có lỗi xảy ra. Vui lòng thử lại.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
