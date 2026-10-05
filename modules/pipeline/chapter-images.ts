import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { prepareCharacterBible } from "../imagePrompt/character-consistency";
import {
  buildAnalyzedPrompt,
  fingerprint,
} from "../imagePrompt/prompt-builder";
import { stableSeed } from "../imagePrompt/profile";
import { makeImage } from "../imagePrompt";
import { generateAPIImage, imageConfig } from "../providers/image-api";
import {
  imageCapabilities,
  ImagePipelineError,
} from "../providers/api-image-provider";
import { isImageAPIProvider } from "../providers/image-api-options";
import { validImage } from "../project/media";
import { root, get, put } from "../project/store";
import { publishGenerated } from "../providers/local-workers";
import type {
  Project,
  Chapter,
  Settings,
  ChapterAPIImage,
} from "../project/types";

type Dependencies = {
  save: () => void;
  load?: () => Project;
  generate?: typeof generateAPIImage;
  legacy?: typeof makeImage;
  history?: (item: ChapterAPIImage) => void;
  stage?: (chapter: Chapter, label: string, detail: string) => void;
};
const portraitLocks = new Map<string, Promise<void>>();
async function portraitLock<T>(key: string, action: () => Promise<T>) {
  const previous = portraitLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  portraitLocks.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (portraitLocks.get(key) === tail) portraitLocks.delete(key);
  }
}
async function saveAsset(bytes: Buffer) {
  const file = randomUUID() + ".png";
  const directory = path.join(root, "assets");
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `${file}.tmp`);
  try {
    const image = sharp(bytes, { limitInputPixels: 40000000 });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || bytes.length > 40000000)
      throw Error("invalid image");
    await image.png().toFile(temporary);
    await rename(temporary, path.join(directory, file));
    await publishGenerated(path.join(directory, file), "images");
    return { file, width: metadata.width, height: metadata.height };
  } catch {
    await unlink(temporary).catch(() => {});
    throw new ImagePipelineError(
      "IMAGE_DOWNLOAD_FAILED",
      "Không giải mã hoặc lưu được ảnh API vào asset nội bộ.",
    );
  }
}
/** Exactly one master per chapter, persisted before any rendering starts. */
export async function processChapterImages(
  project: Project,
  chapters: Chapter[],
  settings: Settings,
  deps: Dependencies,
) {
  const errors: { chapterId: string; code: string; message: string }[] = [];
  const provider = settings.imageProvider || "openai";
  const api = isImageAPIProvider(provider);
  const model =
    settings.imageModel || (api ? imageConfig(provider).model : provider);
  const capabilities = imageCapabilities(
    provider,
    model,
    settings.imageAPIOptions,
  );
  const generate = deps.generate || generateAPIImage;
  const stage = (
    chapter: Chapter,
    status: ChapterAPIImage["status"],
    label: string,
    detail = label,
  ) => {
    if (chapter.apiImage) chapter.apiImage.status = status;
    deps.stage?.(chapter, label, detail);
    deps.save();
  };
  let bible;
  try {
    bible = prepareCharacterBible(project);
    deps.save();
  } catch {
    throw new ImagePipelineError(
      "CHARACTER_BIBLE_FAILED",
      "Không chuẩn hóa được Character Bible của dự án.",
    );
  }
  for (const chapter of chapters) {
    try {
      deps.stage?.(
        chapter,
        "Phân tích chương",
        "Trích ý đồ hình ảnh và nhân vật trung tâm",
      );
      let built;
      try {
        built = buildAnalyzedPrompt(chapter, bible, settings);
      } catch {
        throw new ImagePipelineError(
          "PROMPT_ANALYSIS_FAILED",
          "Không phân tích được nội dung hình ảnh của chương.",
        );
      }
      const seed =
        settings.imageAPIOptions?.seedMode === "chapter"
          ? stableSeed(project.id + chapter.id)
          : stableSeed(project.id);
      const identityKey = fingerprint({
        engine: provider,
        model,
        style: settings.style,
        aspect: settings.aspect,
        size:
          provider === "openai" || provider === "api-compatible"
            ? settings.imageAPIOptions?.size || "auto"
            : "native",
        seedMode: settings.imageAPIOptions?.seedMode || "project",
        references: settings.imageAPIOptions?.references !== false,
        referenceStrength:
          provider === "stability" && model === "ultra"
            ? (settings.imageAPIOptions?.referenceStrength ?? 0.65)
            : undefined,
        capabilities,
        prompt: built.prompt,
        seed,
      });
      if (
        chapter.apiImage?.cacheKey === identityKey &&
        (await validImage(chapter.apiImage.file))
      ) {
        chapter.apiImage.status = "ready";
        chapter.apiImage.errorCode = undefined;
        chapter.apiImage.errorMessage = undefined;
        mapMaster(chapter, chapter.apiImage, settings);
        deps.save();
        deps.stage?.(
          chapter,
          "Ảnh đã lưu",
          "Dùng lại ảnh master hợp lệ; không gọi API",
        );
        continue;
      }
      // Reuse a manually uploaded chapter image for all its scenes.
      const uploaded = chapter.scenes.find(
        (scene) => scene.imageSource === "upload" && scene.image,
      );
      const existing = (await validImage(uploaded?.image))
        ? uploaded!.image
        : undefined;
      const requestId = randomUUID();
      chapter.apiImage = {
        requestId,
        cacheKey: identityKey,
        projectId: project.id,
        chapterId: chapter.id,
        engine: provider,
        model,
        prompt: built.prompt,
        negativePrompt: built.negativePrompt,
        characterBlock: built.characterBlock,
        characterIds: built.characters.map((c) => c.characterId),
        referenceFiles: [],
        seed,
        status: "analyzing",
        createdAt: new Date().toISOString(),
      };
      stage(
        chapter,
        "characters",
        "Trích nhân vật",
        `${built.characters.length} nhân vật · Character Bible dùng chung toàn dự án`,
      );
      const references: { bytes: Buffer; mime: string; name: string }[] = [];
      stage(
        chapter,
        "characters",
        "Đồng bộ Character Bible",
        "Dùng danh tính chuẩn đã lưu của dự án",
      );
      if (
        api &&
        capabilities.supportsReferenceImages &&
        settings.imageAPIOptions?.references !== false &&
        !existing
      ) {
        stage(
          chapter,
          "characters",
          "Đồng bộ Character Bible",
          "Tạo hoặc dùng lại portrait nhân vật chính",
        );
        await portraitLock(project.id, async () => {
          const latest =
            deps.load?.() ||
            (() => {
              try {
                return get<Project>(project.id, "project");
              } catch {
                return project;
              }
            })();
          for (const character of bible.characters.filter((c) => c.primary)) {
            const persisted = latest.characterBible?.characters.find(
              (c) => c.characterId === character.characterId,
            )?.portrait;
            if (persisted) character.portrait = persisted;
            const portraitKey = fingerprint({
              version: 1,
              provider,
              model,
              style: settings.style,
              identity: character.normalizedPrompt,
            });
            if (
              character.portrait?.cacheKey !== portraitKey ||
              !(await validImage(character.portrait.file))
            ) {
              const portraitSeed = stableSeed(
                project.id + character.characterId,
              );
              try {
                const generated = await generate(
                  provider,
                  `Canonical character reference portrait. ${settings.style || "cinematic"}. ${character.normalizedPrompt} Single person, neutral expression, head and shoulders plus signature outfit and accessories, clear face, plain background. Preserve this exact face and identity in future illustrations.`,
                  "16:9",
                  portraitSeed,
                  model,
                  {
                    options: { ...settings.imageAPIOptions, size: "1024x1024" },
                    negativePrompt: built.negativePrompt,
                    requestId: randomUUID(),
                    onRetry: (attempt) =>
                      deps.stage?.(
                        chapter,
                        "Đồng bộ Character Bible",
                        `Portrait ${character.name}: thử lại ${attempt}`,
                      ),
                  },
                );
                const asset = await saveAsset(generated.bytes);
                character.portrait = {
                  file: asset.file,
                  cacheKey: portraitKey,
                  engine: provider,
                  model,
                  seed: portraitSeed,
                  createdAt: new Date().toISOString(),
                };
                deps.save();
              } catch (error) {
                throw new ImagePipelineError(
                  "CHARACTER_BIBLE_FAILED",
                  `Portrait ${character.name}: ${error instanceof Error ? error.message : "API tạo portrait thất bại"}`,
                );
              }
            }
          }
        });
        for (const character of built.characters.filter((c) => c.portrait)) {
          if (!capabilities.supportsMultiImageInput && references.length) break;
          if (references.length >= 10) break;
          const file = character.portrait!.file;
          references.push({
            bytes: await readFile(path.join(root, "assets", file)),
            mime: "image/png",
            name: `${character.name}.png`,
          });
          chapter.apiImage.referenceFiles.push(file);
        }
      }
      stage(
        chapter,
        "prompt",
        "Tạo prompt",
        `${provider} · ${model} · 1 chương = 1 ảnh`,
      );
      let file: string;
      if (existing) {
        file = existing;
        chapter.apiImage.engine = "upload";
      } else if (api) {
        stage(
          chapter,
          "generating",
          "Gọi API tạo ảnh",
          `${chapter.title} · ${provider} · ${model}`,
        );
        const generated = await generate(
          provider,
          built.prompt,
          settings.aspect,
          seed,
          model,
          {
            options: { retries: 2, ...settings.imageAPIOptions },
            negativePrompt: built.negativePrompt,
            references,
            requestId,
            onRetry: (attempt, status) =>
              deps.stage?.(
                chapter,
                "Gọi API tạo ảnh",
                `Thử lại ${attempt} sau ${status ? `HTTP ${status}` : "timeout"}`,
              ),
          },
        );
        stage(chapter, "saving", "Lưu ảnh nội bộ");
        const asset = await saveAsset(generated.bytes);
        file = asset.file;
        chapter.apiImage.metadata = {
          ...generated.metadata,
          width: asset.width,
          height: asset.height,
        };
      } else {
        stage(chapter, "generating", "Tạo ảnh master chương", provider);
        file = randomUUID() + ".png";
        const generated = await (deps.legacy || makeImage)(
          built.prompt,
          path.join(root, "assets", file),
          settings,
          seed,
        );
        chapter.apiImage.engine = generated.engine || provider;
        chapter.apiImage.model = generated.model || provider;
      }
      Object.assign(chapter.apiImage, {
        file,
        status: "ready",
        createdAt: new Date().toISOString(),
      });
      mapMaster(chapter, chapter.apiImage, settings);
      deps.save();
      const history = { ...chapter.apiImage };
      if (deps.history) deps.history(history);
      else put("image_generation_history", { id: requestId, ...history });
      deps.stage?.(
        chapter,
        "Ảnh đã lưu",
        `${chapter.title} · ảnh master sẵn sàng cho ${chapter.scenes.length} cảnh`,
      );
    } catch (error) {
      const code =
        error instanceof ImagePipelineError ? error.code : "IMAGE_API_FAILED";
      const message =
        error instanceof Error ? error.message : "Tạo ảnh chương thất bại";
      if (chapter.apiImage)
        Object.assign(chapter.apiImage, {
          status: "error",
          errorCode: code,
          errorMessage: message,
        });
      if (chapter.apiImage) {
        if (deps.history) deps.history({ ...chapter.apiImage });
        else
          put("image_generation_history", {
            id: chapter.apiImage.requestId,
            ...chapter.apiImage,
          });
      }
      const fallback =
        settings.fallbackOnImageError &&
        (await validImage(settings.fallbackImage))
          ? settings.fallbackImage
          : undefined;
      for (const scene of chapter.scenes) {
        scene.imageStatus = "error";
        scene.imageError = `${code}: ${message}`;
        scene.image = fallback;
        scene.imageSource = fallback ? "shared" : undefined;
      }
      errors.push({ chapterId: chapter.id, code, message });
      deps.save();
      deps.stage?.(chapter, "Lỗi ảnh chương", `${code}: ${message}`);
    }
  }
  return errors;
}
function mapMaster(
  chapter: Chapter,
  image: ChapterAPIImage,
  settings: Settings,
) {
  for (const scene of chapter.scenes) {
    if (scene.image !== image.file) {
      scene.motion = undefined;
      scene.motionStatus = undefined;
      scene.motionError = undefined;
    }
    Object.assign(scene, {
      chapterId: chapter.id,
      chapterMasterImage: image.file,
      image: image.file,
      imageSource: image.engine,
      imageStatus: "done",
      imageError: undefined,
      imageEngine: image.engine,
      imageModel: image.model,
      finalImagePrompt: image.prompt,
      imageSeed: image.seed,
      approved: !settings.humanCheck,
    });
  }
}
