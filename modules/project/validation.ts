import { z } from "zod";
const asset = z
  .string()
  .regex(/^[a-f0-9-]+\.(png|jpg|jpeg|webp|wav|mp3|mp4)$/)
  .optional();
export const settingsSchema = z.object({
  audioEnabled: z.boolean().optional(),
  splitScenes: z.boolean().optional(),
  fallbackImage: asset,
  fallbackOnImageError: z.boolean().optional(),
  provider: z.literal("openai"),
  imageEnabled: z.boolean().optional(),
  imageProvider: z
    .enum([
      "modal-story",
      "modal-reference",
      "flux2-local",
      "local-fast",
      "auto-local",
      "aihorde",
      "pollinations",
      "openai",
    ])
    .optional(),
  referenceImages: z.array(asset.unwrap()).max(10).optional(),
  motionMode: z.enum(["off", "selected", "all"]).optional(),
  ttsProvider: z
    .enum([
      "modal-vieneu",
      "vieneu-local",
      "korva-local",
      "tts-studio-local",
      "pollinations",
      "cloud",
    ])
    .optional(),
  mode: z.enum(["original", "review", "summary"]),
  style: z.string().max(100),
  customPrompt: z.string().max(2000),
  voice: z.string().trim().min(1).max(100),
  speed: z.number().min(0.5).max(2),
  pitch: z.number().min(-6).max(6),
  volume: z.number().min(0).max(2),
  pause: z.number().min(0).max(3),
  aspect: z.enum(["16:9", "9:16"]),
  burnSubtitles: z.boolean(),
  font: z.enum(["Arial", "Tahoma", "Verdana", "Times New Roman"]),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  outline: z.number().int().min(0).max(5),
  position: z.enum(["bottom", "top"]),
  humanCheck: z.boolean(),
  music: asset,
  musicVolume: z.number().min(0).max(1),
  intro: asset,
  outro: asset,
  logo: asset,
  brandColor: z.string().regex(/^#[0-9a-f]{6}$/i),
});
export const sceneSchema = z.object({
  motionSelected: z.boolean().optional(),
  id: z.string().uuid(),
  text: z.string().min(1).max(2000),
  prompt: z.string().min(1).max(4000),
  image: asset,
  audio: asset,
  duration: z.number().positive().max(3600),
  approved: z.boolean(),
});
