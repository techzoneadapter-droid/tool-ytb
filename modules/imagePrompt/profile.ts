import { createHash } from "node:crypto";
import type { Chapter, Scene, Settings, VisualProfile } from "../project/types";
import { styledPrompt } from "./styles";
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
      chapter.text.match(/\b[\p{Lu}][\p{L}]+(?:\s+[\p{Lu}][\p{L}]+){1,2}/gu) ||
        [],
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
export function sceneVisual(
  chapter: Chapter,
  scene: Scene,
  settings: Settings,
) {
  const profile = ensureVisualProfile(chapter, settings);
  const characters = profile.characters.filter((c) =>
    scene.text.includes(c.name),
  );
  return {
    seed: stableSeed(profile.seed + ":" + scene.id),
    prompt: styledPrompt(
      scene.text,
      profile.style,
      [
        settings.customPrompt,
        scene.prompt && !scene.prompt.includes(" Chapter context: ")
          ? scene.prompt
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      [
        chapter.title,
        ...characters.map((c) => `${c.name}: ${c.descriptor}`),
        ...profile.locations,
        profile.era,
        profile.clothing,
        profile.visualNotes,
      ]
        .filter(Boolean)
        .join(" | "),
    ),
  };
}
