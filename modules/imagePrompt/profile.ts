import { createHash } from "node:crypto";
import type { Chapter, Settings, VisualProfile } from "../project/types";
export const stableSeed = (value: string) =>
  createHash("sha256").update(value).digest().readUInt32BE(0) & 0x7fffffff;
/** Source excerpts are retained verbatim; no invented character facts or paid extraction. */
export function ensureVisualProfile(
  chapter: Chapter,
  settings: Settings,
): VisualProfile {
  if (chapter.visualProfile) return chapter.visualProfile;
  const names = [
    ...new Set(
      chapter.text.match(
        /(?<![\p{L}])[\p{Lu}][\p{L}]+(?:\s+[\p{Lu}][\p{L}]+){1,2}(?![\p{L}])/gu,
      ) || [],
    ),
  ].slice(0, 8);
  const sentences = chapter.text.split(/(?<=[.!?。])\s+/u);
  chapter.visualProfile = {
    style: settings.style,
    seed: stableSeed(chapter.id),
    characters: names.map((name) => ({
      name,
      descriptor: sentences
        .filter((x) => x.includes(name))
        .join(" ")
        .slice(0, 500),
    })),
    locations: [],
    era: "",
    clothing: "",
    visualNotes: chapter.text.slice(0, 700),
  };
  return chapter.visualProfile;
}
