import { NextRequest, NextResponse } from "next/server";
import { ensureVisualProfile } from "@/modules/imagePrompt/profile";
import { findEngineVoice, voiceKey } from "@/modules/tts/catalog";
import { localStatus } from "@/modules/tts/local";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  get,
  list,
  put,
  updateJob,
  removeProject,
} from "@/modules/project/store";
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
  resolveSceneImage,
  validImage,
  verifiedJob,
  assetExists,
  verifiedScene,
} from "@/modules/project/media";
import { isSameOrigin } from "@/modules/project/request";
import { runtimeStatus } from "@/modules/providers/runtime-status";
import { startService } from "@/modules/providers/services";
import { modalConfigured } from "@/modules/providers/modal/client";
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
    if (b.action === "previewChapters") {
      const text = storySchema.parse(b.text);
      return NextResponse.json(
        b.splitChapters === false
          ? [{ title: "Chương 1" }]
          : parseChapters(text).map((c) => ({ title: c.title })),
      );
    }
    if (b.action === "startService") {
      await startService(
        z.enum(["worker", "vieneu", "korva", "flux", "wan"]).parse(b.service),
      );
      return NextResponse.json({ ok: true });
    }
    if (b.action === "create" || b.action === "createVideo") {
      const text = storySchema.parse(b.text);
      const defaultProvider = defaultTTSProvider();
      const configuredVoice =
        process.env.DEFAULT_VIETNAMESE_VOICE || "Ngọc Huyền";
      const baseSettings = {
        ...defaults,
        ttsProvider: defaultProvider,
        voice:
          defaultProvider === "modal-vieneu"
            ? configuredVoice
            : localVoiceId(configuredVoice),
        imageEnabled: true,
        imageProvider: modalConfigured("image") ? "modal-story" : "flux2-local",
        motionMode: "off",
      };
      const settings = settingsSchema.parse({
        ...baseSettings,
        ...(b.settings && typeof b.settings === "object" ? b.settings : {}),
      });
      if (
        settings.fallbackImage &&
        (!(await validImage(settings.fallbackImage)) ||
          !list<{ id: string }>("upload").some(
            (u) => u.id === settings.fallbackImage,
          ))
      )
        throw Error("Ảnh dùng chung chưa được tải lên hợp lệ.");
      const parsedChapters =
        b.splitChapters === false
          ? [{ id: randomUUID(), title: "Chương 1", text, scenes: [] }]
          : parseChapters(text);
      const chapters = parsedChapters.map((chapter) => ({
        ...chapter,
        scenes: (settings.splitScenes === false
          ? [
              {
                id: randomUUID(),
                text: chapter.text,
                prompt: "",
                duration: Math.max(3, chapter.text.split(/\s+/).length / 2.8),
                approved: false,
              },
            ]
          : plan(chapter.text, settings.style)
        ).map((scene) => ({
          ...scene,
          prompt: styledPrompt(
            scene.text,
            settings.style,
            settings.customPrompt,
            chapter.title + ": " + chapter.text,
          ),
        })),
      }));
      const project: Project = {
        id: randomUUID(),
        name: projectNameSchema.parse(b.name),
        createdAt: new Date().toISOString(),
        chapters,
        settings,
      };
      for (const chapter of project.chapters)
        ensureVisualProfile(chapter, settings);
      put("project", project);
      if (b.action === "createVideo") {
        const job: Job = {
          id: randomUUID(),
          projectId: project.id,
          chapterIds: chapters.map((c) => c.id),
          kind: "pipeline",
          status: "queued",
          progress: 0,
          message: "Đã lưu truyện, tách chương và chia cảnh",
          createdAt: new Date().toISOString(),
          snapshot: { settings: structuredClone(settings) },
        };
        put("job", job);
        // Keep the saved project/job even if the process cannot start, so retry is possible.
        try {
          await startService("worker");
        } catch (e) {
          updateJob(job.id, {
            status: "error",
            error: String(e),
            message: "Worker chưa khởi động được",
          });
        }
      }
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
        b.action !== "pause" &&
        list<Job>("job").some(
          (other) =>
            other.id !== j.id &&
            other.projectId === j.projectId &&
            ["audio", "images", "rendering"].includes(other.status),
        )
      )
        throw Error(
          "Dự án đang có tác vụ khác. Hoàn tất tác vụ đó trước khi thử lại.",
        );
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
          snapshot: {
            settings: structuredClone(
              get<Project>(j.projectId, "project").settings,
            ),
          },
        });
      if (b.action !== "pause") await startService("worker");
      return NextResponse.json({ ok: true });
    }
    const p = get<Project>(z.string().uuid().parse(b.projectId), "project");
    if (b.action === "approve") {
      if (
        list<Job>("job").some(
          (j) =>
            j.projectId === p.id &&
            (["queued", "audio", "images", "rendering"].includes(j.status) ||
              (j.status === "paused" &&
                !j.message.startsWith("Tài nguyên đã lưu."))),
        )
      )
        throw Error("Chờ công đoạn hiện tại hoàn tất trước khi duyệt.");
      for (const chapter of p.chapters.filter(
        (c) => !b.chapterIds || b.chapterIds.includes(c.id),
      ))
        for (const scene of chapter.scenes) {
          await requireSceneMedia(scene, p.settings);
          scene.approved = true;
        }
      put("project", p);
      return NextResponse.json(p);
    }
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
    if (b.action === "rename") {
      p.name = projectNameSchema.parse(b.name);
      put("project", p);
      return NextResponse.json(p);
    }
    if (b.action === "delete") {
      removeProject(p.id);
      return NextResponse.json({ ok: true });
    }
    if (b.action === "motionSelection") {
      const ids = z.array(z.string().uuid()).parse(b.sceneIds);
      if (
        ids.some(
          (id) => !p.chapters.some((c) => c.scenes.some((s) => s.id === id)),
        )
      )
        throw Error("Cảnh không hợp lệ.");
      for (const c of p.chapters)
        for (const scene of c.scenes)
          scene.motionSelected = ids.includes(scene.id);
      put("project", p);
      return NextResponse.json(p);
    }
    if (b.action === "settings") {
      const settings = settingsSchema.parse(b.settings);
      if (
        settings.ttsProvider === "vieneu-local" ||
        settings.ttsProvider === "korva-local"
      ) {
        const catalog = await localStatus();
        const match = findEngineVoice(
          settings.ttsProvider === "vieneu-local"
            ? catalog.vieneu.voices
            : catalog.korva.voices,
          settings.voice,
        );
        if (match) settings.voice = match.id;
      }
      if (
        settings.fallbackImage &&
        (!(await validImage(settings.fallbackImage)) ||
          !list<{ id: string }>("upload").some(
            (u) => u.id === settings.fallbackImage,
          ))
      )
        throw Error("Ảnh dùng chung chưa được tải lên hợp lệ.");
      if (
        (
          ["ttsProvider", "voice", "speed", "pitch", "volume", "pause"] as const
        ).some((key) =>
          key === "voice" && settings.ttsProvider !== "cloud"
            ? voiceKey(settings.voice) !== voiceKey(p.settings.voice)
            : settings[key] !== p.settings[key],
        )
      )
        for (const c of p.chapters)
          for (const scene of c.scenes) {
            scene.audio = undefined;
            scene.audioSource = undefined;
            scene.audioStatus = undefined;
            scene.audioError = undefined;
            scene.approved = false;
          }
      if (
        settings.style !== p.settings.style ||
        settings.customPrompt !== p.settings.customPrompt ||
        settings.imageProvider !== p.settings.imageProvider ||
        settings.aspect !== p.settings.aspect
      )
        for (const chapter of p.chapters)
          for (const scene of chapter.scenes) {
            scene.prompt = styledPrompt(
              scene.text,
              settings.style,
              settings.customPrompt,
              chapter.title + ": " + chapter.text,
            );
            if (scene.imageSource !== "upload") {
              scene.image = undefined;
              scene.imageSource = undefined;
              scene.imageStatus = undefined;
              scene.imageError = undefined;
              scene.approved = false;
            }
            scene.motion = undefined;
            scene.motionStatus = undefined;
            scene.motionError = undefined;
          }
      for (const chapter of p.chapters)
        ensureVisualProfile(chapter, settings).style = settings.style;
      p.settings = settings;
      put("project", p);
      return NextResponse.json(p);
    }
    if (b.action === "visualProfile") {
      const chapter = p.chapters.find((c) => c.id === b.chapterId);
      if (!chapter) throw Error("Không tìm thấy chương");
      chapter.visualProfile = z
        .object({
          style: z.string().min(1).max(100),
          seed: z.number().int().min(0).max(2147483647),
          characters: z
            .array(
              z.object({
                name: z.string().min(1).max(100),
                descriptor: z.string().max(500),
              }),
            )
            .max(8),
          locations: z.array(z.string().max(200)).max(10),
          era: z.string().max(200),
          clothing: z.string().max(200),
          visualNotes: z.string().max(700),
        })
        .parse(b.profile);
      for (const scene of chapter.scenes) {
        if (scene.imageSource !== "upload") {
          scene.image = undefined;
          scene.imageSource = undefined;
        }
        scene.motion = undefined;
        scene.approved = false;
      }
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
        ...previous,
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
            c.title + ": " + c.text,
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
        .enum(["audio", "image", "motion", "prepare", "render", "pipeline"])
        .parse(b.kind || (prepare ? "prepare" : "render"));
      const selected = p.chapters.filter((c) => ids.includes(c.id));
      if (kind === "pipeline") {
        for (const chapter of selected)
          if (!chapter.scenes.length) {
            chapter.scenes = (
              p.settings.splitScenes === false
                ? [
                    {
                      id: randomUUID(),
                      text: chapter.text,
                      prompt: "",
                      duration: Math.max(
                        3,
                        chapter.text.split(/\s+/).length / 2.8,
                      ),
                      approved: false,
                    },
                  ]
                : plan(chapter.text, p.settings.style)
            ).map((scene) => ({
              ...scene,
              prompt: styledPrompt(
                scene.text,
                p.settings.style,
                p.settings.customPrompt,
                chapter.title + ": " + chapter.text,
              ),
            }));
          }
        put("project", p);
      }
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
      if (kind === "audio" || kind === "prepare" || kind === "pipeline")
        assertTTS(p.settings);
      if (kind === "image" && p.settings.imageEnabled === false)
        throw Error("Tạo ảnh đang tắt. Hãy bật tạo ảnh hoặc tải ảnh lên.");
      if (
        (kind === "image" ||
          (kind === "prepare" && p.settings.imageEnabled !== false)) &&
        ![
          "modal-story",
          "modal-reference",
          "flux2-local",
          "local-fast",
          "auto-local",
        ].includes(p.settings.imageProvider || "")
      )
        requireImage();
      if (kind === "motion") {
        if (!p.settings.motionMode || p.settings.motionMode === "off")
          throw Error("Ảnh động đang tắt. Chọn chế độ ảnh động trước.");
        const targets = scenes.filter((s) => usesMotion(s, p.settings));
        if (!targets.length) throw Error("Chưa chọn cảnh nào để tạo ảnh động.");
        for (const scene of targets)
          if (!(await resolveSceneImage(scene, p.settings)))
            throw Error(
              "Cảnh được chọn chưa có ảnh thật. Tạo hoặc tải ảnh lên trước.",
            );
      }
      if (kind === "render") {
        const runtime = await runtimeStatus();
        if (!runtime.ffmpeg)
          throw Error(
            "Chưa chạy được FFmpeg/FFprobe. Kiểm tra FFMPEG_PATH và FFPROBE_PATH rồi khởi động lại app và worker.",
          );
        for (const scene of scenes) await requireSceneMedia(scene, p.settings);
      }
      if (
        kind === "render" &&
        p.settings.humanCheck &&
        selected.some((c) => c.scenes.some((s) => !s.approved || !s.audio))
      )
        throw Error(
          "Hãy tạo tài nguyên và duyệt tất cả cảnh trước khi render.",
        );
      const groups =
        kind === "pipeline"
          ? [selected.map((c) => c.id)]
          : b.merge
            ? [selected.map((c) => c.id)]
            : selected.map((c) => [c.id]);
      const jobs = groups.map((chapterIds) => {
        const j: Job & { prepare: boolean } = {
          id: randomUUID(),
          projectId: p.id,
          chapterIds,
          status: "queued",
          kind,
          outputMode:
            kind === "pipeline"
              ? b.merge
                ? "merged"
                : "separate"
              : b.merge
                ? "merged"
                : undefined,
          regenerate: b.regenerate === true,
          sceneIds,
          progress: 0,
          message:
            kind === "render"
              ? "Chờ xuất video"
              : kind === "pipeline" && chapterIds.length > 1
                ? `Chờ xử lý ${chapterIds.length} chương trong một lô`
                : "Chờ tạo tài nguyên thật",
          createdAt: new Date().toISOString(),
          snapshot: { settings: structuredClone(p.settings) },
          prepare,
        };
        put("job", j);
        return j;
      });
      try {
        await startService("worker");
      } catch (e) {
        for (const j of jobs)
          updateJob(j.id, {
            status: "error",
            error: String(e),
            message: "Worker chưa khởi động được",
          });
      }
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
