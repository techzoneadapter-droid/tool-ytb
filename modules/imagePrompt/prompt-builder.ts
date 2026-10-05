import { createHash } from "node:crypto";
import { imageStyles } from "./styles";
import {
  choosePrimaryCharacters,
  buildCharacterPromptBlock,
} from "./character-consistency";
import type {
  Chapter,
  CharacterBible,
  Settings,
  ChapterVisualAnalysis,
} from "../project/types";

export const negativePrompt =
  "text, lettering, subtitles, watermark, logo, collage, panels, duplicate person, merged identities, swapped faces, inconsistent age, changed hairstyle, distorted face, extra limbs, malformed hands, blur, low resolution";
export function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function analyzeChapterForVisuals(
  chapter: Chapter,
  bible: CharacterBible,
): ChapterVisualAnalysis {
  const characters = choosePrimaryCharacters(chapter, bible).slice(0, 6);
  const cacheKey = fingerprint({
    version: 1,
    title: chapter.title,
    text: chapter.text,
    characters: characters.map((c) => [c.characterId, c.name]),
    context: {
      locations: chapter.visualProfile?.locations,
      era: chapter.visualProfile?.era,
      clothing: chapter.visualProfile?.clothing,
    },
  });
  if (chapter.imageAnalysis?.cacheKey === cacheKey)
    return chapter.imageAnalysis;
  const sentences = chapter.text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?。])\s+/u)
    .filter(Boolean);
  const visual =
    /đánh|chạy|bước|nhìn|đứng|ngồi|cầm|bay|kiếm|chiến|gặp|mở|phát hiện|walk|fight|run|hold|discover|meet/i;
  const location =
    /(?:trong|tại|bên|giữa|ngoài|trên|dưới)\s+(?:căn phòng|rừng|núi|thành phố|ngôi nhà|hang|đường|đại điện|sân|làng|biển|sông)[^,.!?]{0,65}|(?:forest|mountain|city|room|village|sea|river)/i;
  const scored = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      score:
        (visual.test(sentence) ? 3 : 0) +
        (location.test(sentence) ? 2 : 0) +
        (characters[0] && sentence.includes(characters[0].name) ? 3 : 0) -
        (sentence.length > 600 ? 2 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  // Extract a defining visual beat, rather than forwarding the complete chapter.
  const action =
    scored[0]?.sentence.slice(0, 450) ||
    `A quiet establishing illustration for ${chapter.title}`;
  const text = chapter.text;
  const time = /đêm|bóng tối|moon|night/i.test(action)
    ? "night, moonlight"
    : /hoàng hôn|chiều tà|sunset/i.test(action)
      ? "sunset, warm light"
      : /bình minh|sáng sớm|dawn/i.test(action)
        ? "dawn, soft light"
        : "daylight unless the defining event states otherwise";
  const mood = /sợ|kinh|hoảng|máu|nguy hiểm|fear|danger/i.test(action)
    ? "tense, dramatic"
    : /vui|cười|hạnh phúc|smile|joy/i.test(action)
      ? "hopeful, warm"
      : /buồn|khóc|cô đơn|sad|cry/i.test(action)
        ? "melancholic, restrained"
        : "cinematic, focused";
  const explicitChanges = sentences
    .filter(
      (sentence) =>
        characters.some((c) => sentence.includes(c.name)) &&
        /thay áo|thay đồ|mặc áo|khoác|bị thương|ướt|bẩn|già đi|lớn lên|injured|wet|dirty|changes? (?:outfit|clothes)|aged/i.test(
          sentence,
        ),
    )
    .slice(0, 3)
    .map((sentence) => sentence.slice(0, 250));
  chapter.imageAnalysis = {
    version: 1,
    cacheKey,
    summary: `${chapter.title}: ${action}`,
    characters: characters.map((c) => c.characterId),
    centralCharacter: characters[0]?.name,
    location:
      chapter.visualProfile?.locations.join(", ") ||
      location.exec(action)?.[0] ||
      location.exec(text)?.[0] ||
      "a coherent story-appropriate environment, minimal background distractions",
    time,
    mood,
    action,
    explicitChanges,
    createdAt: new Date().toISOString(),
  };
  return chapter.imageAnalysis;
}
export function buildAnalyzedPrompt(
  chapter: Chapter,
  bible: CharacterBible,
  settings: Settings,
) {
  const analysis = analyzeChapterForVisuals(chapter, bible);
  const characters = choosePrimaryCharacters(chapter, bible).slice(0, 6);
  let characterBlock = buildCharacterPromptBlock(
    characters,
    analysis.centralCharacter,
  );
  const styleName = settings.style || bible.visualStyle || "cinematic";
  const style =
    imageStyles.find((style) => style.name === styleName)?.prompt || styleName;
  const blocks = [
    `STYLE: ${style}. Clean cinematic web-novel illustration, consistent project art direction. ${settings.customPrompt || ""}`,
    `SCENE: ${analysis.summary}. Setting: ${analysis.location}. Time: ${analysis.time}. Mood: ${analysis.mood}. Explicit identity/outfit changes: ${analysis.explicitChanges.join("; ") || "none"}.`,
    `CHARACTERS:\n${characterBlock}`,
    `CAMERA/COMPOSITION: one coherent chapter master image, no collage. ${analysis.centralCharacter ? `Center ${analysis.centralCharacter}; keep supporting subjects distinct.` : "Clear establishing composition."} Medium/wide cinematic shot, readable silhouettes, deliberate depth and light. Compose for ${settings.aspect} with safe central framing.`,
    `NEGATIVE: ${negativePrompt}`,
  ];
  const prompt = blocks.join("\n");
  // Preserve all identity/composition blocks when shortening, trim only story/style detail.
  if (prompt.length > 9000)
    characterBlock = buildCharacterPromptBlock(
      characters,
      analysis.centralCharacter,
      true,
    );
  const short = [
    blocks[0].slice(0, 600),
    `SCENE: ${analysis.action.slice(0, 250)}. ${analysis.location}. ${analysis.time}. ${analysis.mood}. Explicit changes: ${analysis.explicitChanges.join("; ") || "none"}.`,
    `CHARACTERS:\n${characterBlock}`,
    blocks[3],
    blocks[4],
  ].join("\n");
  return {
    analysis,
    prompt: prompt.length <= 9000 ? prompt : short,
    negativePrompt,
    characterBlock,
    characters,
  };
}
