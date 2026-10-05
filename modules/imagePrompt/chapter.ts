import { stableSeed, ensureVisualProfile } from "./profile";
import { buildAnalyzedPrompt } from "./prompt-builder";
import type {
  Project,
  Chapter,
  Settings,
  CharacterBible,
} from "../project/types";

/** Extract once from all chapters. Unknown traits stay unknown instead of being invented. */
export function ensureCharacterBible(project: Project): CharacterBible {
  if (project.characterBible) return project.characterBible;
  const characters = new Map<string, CharacterBible["characters"][number]>();
  for (const chapter of project.chapters) {
    for (const character of ensureVisualProfile(chapter, project.settings)
      .characters) {
      const key = character.name.normalize("NFC").toLocaleLowerCase("vi");
      if (characters.has(key)) continue;
      const source = character.descriptor;
      const trait = (pattern: RegExp) =>
        source
          .split(/(?<=[.!?])\s+/)
          .filter((s) => pattern.test(s))
          .join(" ")
          .slice(0, 500) || "unspecified";
      const age = /\b(\d{1,3})\s*(?:tuổi|years? old)/i.exec(source);
      characters.set(key, {
        characterId: "character_" + stableSeed(key),
        name: character.name,
        gender: trait(/(?<!\p{L})(?:male|female|man|woman|nam|nữ)(?!\p{L})/iu),
        approximateAge: age ? Number(age[1]) : null,
        faceDescription: trait(/khuôn mặt|gương mặt|face|facial/i),
        hair: trait(/tóc|hair/i),
        body: trait(/dáng|thân hình|body|build|height/i),
        clothing: trait(/áo|quần|trang phục|jacket|robe|clothing/i),
        distinctiveFeatures: trait(/sẹo|hình xăm|scar|tattoo|distinctive/i),
        role: "story character",
        sourceDescription: source,
      });
    }
  }
  project.characterBible = {
    version: 1,
    referenceImageStatus: "NOT CURRENTLY VERIFIED",
    characters: [...characters.values()],
  };
  return project.characterBible;
}

export function buildChapterImagePrompt(
  project: Project,
  chapter: Chapter,
  settings: Settings,
) {
  const bible = ensureCharacterBible(project);
  return buildAnalyzedPrompt(chapter, bible, settings).prompt;
}
