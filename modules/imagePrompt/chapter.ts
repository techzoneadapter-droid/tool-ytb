import { stableSeed, ensureVisualProfile } from "./profile";
import { imageStyles } from "./styles";
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
        gender: trait(/\b(?:male|female|nam|nữ)\b/i),
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
  const profile = ensureVisualProfile(chapter, settings);
  const relevant = bible.characters.filter((c) =>
    chapter.text.includes(c.name),
  );
  const style =
    imageStyles.find((s) => s.name === settings.style)?.prompt ||
    settings.style;
  return [
    "GLOBAL STYLE: " + style + ". " + settings.customPrompt,
    "CHARACTER BIBLE (fixed project identities): " + JSON.stringify(relevant),
    "CHAPTER CONTEXT: " + [chapter.title, ...profile.locations, profile.era, profile.visualNotes].filter(Boolean).join(" | "),
    "CURRENT CHAPTER EVENT: " + chapter.text.slice(0, 10000),
    "Create one coherent master illustration of the defining chapter event, not a collage. All scenes reuse this image.",
    "CONSISTENCY RULES: same character identity, same facial structure, same hair, same age, same visual identity. Same characteristic clothing unless the story explicitly changes outfit. Preserve unspecified traits consistently. No text, lettering, subtitles or watermark.",
  ].join("\n");
}
