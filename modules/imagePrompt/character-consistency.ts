import { ensureCharacterBible } from "./chapter";
import { stableSeed } from "./profile";
import type { CharacterBible, Project, Chapter } from "../project/types";

export function extractCharactersFromChapter(chapter: Chapter) {
  const names = [
    ...new Set(
      chapter.text.match(
        /(?<![\p{L}])[\p{Lu}][\p{L}]+(?:\s+[\p{Lu}][\p{L}]+){1,2}(?![\p{L}])/gu,
      ) || [],
    ),
  ];
  return names
    .filter(
      (name) =>
        !/^(?:Chương|Chapter|Hệ Thống|Trường Học|Thành Phố|Đại Điện|Hình Xăm)\b/i.test(
          name,
        ),
    )
    .map((name) => ({
      name,
      descriptor: chapter.text
        .split(/(?<=[.!?。])\s+/u)
        .filter((sentence) => sentence.includes(name))
        .join(" ")
        .slice(0, 500),
    }));
}

export function prepareCharacterBible(project: Project) {
  const bible = ensureCharacterBible(project);
  for (const chapter of bible.sourceMode === "manual" ? [] : project.chapters) {
    for (const discovered of extractCharactersFromChapter(chapter)) {
      if (
        bible.characters.some(
          (character) =>
            character.name.normalize("NFC").toLocaleLowerCase("vi") ===
            discovered.name.normalize("NFC").toLocaleLowerCase("vi"),
        )
      )
        continue;
      const source = discovered.descriptor;
      const trait = (pattern: RegExp) =>
        source
          .split(/(?<=[.!?。])\s+/u)
          .find((sentence) => pattern.test(sentence))
          ?.slice(0, 220) || "unspecified";
      const age = /\b(\d{1,3})\s*(?:tuổi|years? old)/i.exec(source);
      bible.characters.push({
        characterId:
          "character_" +
          stableSeed(discovered.name.normalize("NFC").toLocaleLowerCase("vi")),
        name: discovered.name,
        gender: trait(/(?<!\p{L})(?:nam|nữ|male|female)(?!\p{L})/iu),
        approximateAge: age ? Number(age[1]) : null,
        faceDescription: trait(/mặt|face/i),
        hair: trait(/tóc|hair/i),
        body: trait(/dáng|thân hình|build|height/i),
        clothing: trait(/áo|quần|jacket|robe|clothing/i),
        distinctiveFeatures: trait(/sẹo|hình xăm|scar|tattoo/i),
        role: "story character",
        sourceDescription: source,
      });
    }
  }
  bible.visualStyle ||= project.settings.style || "cinematic";
  const ranked = bible.characters
    .map((character) => ({
      character,
      count: project.chapters.filter((chapter) =>
        chapter.text.includes(character.name),
      ).length,
    }))
    .sort((a, b) => b.count - a.count);
  for (const [index, { character, count }] of ranked.entries()) {
    const source = character.sourceDescription;
    const trait = (pattern: RegExp) =>
      source
        .split(/(?<=[.!?。])\s+/u)
        .find((sentence) => pattern.test(sentence))
        ?.slice(0, 220) || "unspecified; keep the same canonical trait";
    character.hairColor ||= trait(
      /tóc (?:đen|nâu|trắng|vàng|bạc|đỏ)|(?:black|brown|blond|silver|white) hair/i,
    );
    character.skinColor ||= trait(/da (?:trắng|ngăm|nâu|đen)|skin|complexion/i);
    character.accessories ||= trait(
      /vòng|nhẫn|khuyên|kiếm|kính|necklace|ring|glasses|accessor/i,
    );
    character.vibe ||= trait(
      /lạnh lùng|dịu dàng|mạnh mẽ|kiêu ngạo|calm|gentle|confident/i,
    );
    character.primary ??= count > 1 || index < 2;
    character.normalizedDescription ||= `${character.name}; ${character.faceDescription}; ${character.hair}; ${character.clothing}`;
    const normalizedTrait = (value: string, pairs: [RegExp, string][]) => {
      const found = pairs
        .filter(([pattern]) => pattern.test(value))
        .map(([, english]) => english);
      return found.length ? found.join(", ") : value.slice(0, 140);
    };
    const hair = normalizedTrait(character.hair, [
      [/ngắn|short/i, "short hair"],
      [/dài|long/i, "long hair"],
      [/xoăn|curly/i, "curly hair"],
      [/thẳng|straight/i, "straight hair"],
    ]);
    const color = (value: string) =>
      normalizedTrait(value, [
        [/đen|black/i, "black"],
        [/nâu|brown/i, "brown"],
        [/trắng|white/i, "white"],
        [/vàng|blond/i, "blond"],
        [/bạc|silver/i, "silver"],
        [/đỏ|red/i, "red"],
      ]);
    const face = normalizedTrait(character.faceDescription, [
      [/góc cạnh|angular/i, "angular face"],
      [/trái xoan|oval/i, "oval face"],
      [/tròn|round/i, "round face"],
      [/mắt.*sắc|sharp eyes/i, "sharp eyes"],
    ]);
    const outfit = normalizedTrait(character.clothing, [
      [/áo khoác|jacket/i, "jacket"],
      [/trường bào|robe/i, "long robe"],
      [/áo giáp|armor/i, "armor"],
      [/đen|black/i, "black"],
      [/trắng|white/i, "white"],
      [/đỏ|red/i, "red"],
      [/xanh|blue/i, "blue"],
    ]);
    const gender = /(?<!\p{L})(?:female|woman|nữ)(?!\p{L})/iu.test(
      character.gender,
    )
      ? "female"
      : /(?<!\p{L})(?:male|man|nam)(?!\p{L})/iu.test(character.gender)
        ? "male"
        : "unspecified, keep unchanged";
    character.normalizedPrompt ||= [
      `Identity ${character.characterId}: ${character.name}.`,
      `Gender: ${gender}. Age: ${character.approximateAge ?? "unspecified, keep unchanged"}.`,
      `Face: ${face}. Build: ${character.body.slice(0, 140)}.`,
      `Hair: ${hair}; color: ${color(character.hairColor)}. Skin: ${character.skinColor.slice(0, 140)}.`,
      `Signature outfit: ${outfit}. Accessories: ${character.accessories.slice(0, 140)}.`,
      `Distinctive marks: ${character.distinctiveFeatures.slice(0, 140)}. Recognizable vibe: ${character.vibe.slice(0, 140)}.`,
    ].join(" ");
  }
  return bible;
}
export function choosePrimaryCharacters(
  chapter: Chapter,
  bible: CharacterBible,
) {
  return bible.characters
    .filter((character) => chapter.text.includes(character.name))
    .sort((a, b) => {
      const count = (name: string) => chapter.text.split(name).length - 1;
      return count(b.name) - count(a.name);
    });
}
export function buildCharacterPromptBlock(
  characters: CharacterBible["characters"],
  central?: string,
  compact = false,
) {
  if (!characters.length)
    return "No identified named character. Show the environment; do not invent new recurring identities.";
  return (
    characters
      .map(
        (character, index) =>
          `${character.characterId} (${character.name === central ? "central subject" : `supporting subject ${index + 1}`}): ${compact ? [character.name, `age=${character.approximateAge ?? "unchanged"}`, ...(["gender", "faceDescription", "body", "hair", "hairColor", "skinColor", "clothing", "accessories", "distinctiveFeatures", "vibe"] as const).map((key) => `${key}=${String(character[key] || "unspecified").slice(0, 70)}`)].join("; ") : character.normalizedPrompt || character.normalizedDescription || character.sourceDescription}`,
      )
      .join("\n") +
    "\nKeep each identity separate. Preserve facial structure, age, gender, hair and signature outfit across chapters. Only pose, camera, expression and lighting vary. Apply only the explicit story changes listed in SCENE; keep every other identity trait unchanged."
  );
}
