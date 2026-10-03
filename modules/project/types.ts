export type Scene = {
  finalImagePrompt?: string;
  imageSeed?: number;
  imageEngine?: string;
  imageModel?: string;
  motion?: string;
  motionSelected?: boolean;
  motionStatus?: "working" | "done" | "error";
  motionError?: string;
  id: string;
  text: string;
  prompt: string;
  image?: string;
  audio?: string;
  audioSource?: string;
  imageSource?: string;
  audioStatus?: "working" | "done" | "error";
  imageStatus?: "working" | "done" | "error";
  audioError?: string;
  imageError?: string;
  duration: number;
  approved: boolean;
};
export type Chapter = {
  visualProfile?: VisualProfile;
  id: string;
  title: string;
  text: string;
  scenes: Scene[];
};
export type VisualProfile = {
  style: string;
  seed: number;
  characters: { name: string; descriptor: string }[];
  locations: string[];
  era: string;
  clothing: string;
  visualNotes: string;
};
export type Settings = {
  audioEnabled?: boolean;
  splitScenes?: boolean;
  fallbackImage?: string;
  fallbackOnImageError?: boolean;
  imageEnabled?: boolean;
  imageProvider?:
    | "modal-story"
    | "modal-reference"
    | "flux2-local"
    | "local-fast"
    | "auto-local"
    | "openai";
  referenceImages?: string[];
  motionMode?: "off" | "selected" | "all";
  ttsProvider?: import("../tts/local-voices").TTSProvider;
  provider: "openai";
  mode: "original" | "review" | "summary";
  style: string;
  customPrompt: string;
  voice: string;
  speed: number;
  pitch: number;
  volume: number;
  pause: number;
  aspect: "16:9" | "9:16";
  burnSubtitles: boolean;
  font: string;
  color: string;
  outline: number;
  position: "bottom" | "top";
  humanCheck: boolean;
  music?: string;
  musicVolume: number;
  intro?: string;
  outro?: string;
  logo?: string;
  brandColor: string;
};
export type Project = {
  id: string;
  name: string;
  createdAt: string;
  chapters: Chapter[];
  settings: Settings;
};
export type Job = {
  startedAt?: string;
  finishedAt?: string;
  id: string;
  projectId: string;
  chapterIds: string[];
  status:
    | "queued"
    | "audio"
    | "images"
    | "rendering"
    | "paused"
    | "ready"
    | "done"
    | "error";
  regenerate?: boolean;
  subtitlesReady?: boolean;
  completedItems?: string[];
  counts?: {
    motion?: number;
    audio: number;
    image: number;
    total: number;
    failed: number;
  };
  kind?:
    | "pipeline"
    | "audio"
    | "image"
    | "motion"
    | "prepare"
    | "render"
    | "merge-video";
  sourceVideoIds?: string[];
  outputTitle?: string;
  sceneIds?: string[];
  verified?: boolean;
  prepare?: boolean;
  progress: number;
  message: string;
  output?: string;
  srt?: string;
  vtt?: string;
  error?: string;
  createdAt: string;
  snapshot: Pick<Project, "settings">;
};
export type VideoRecord = {
  id: string;
  projectId: string;
  chapterIds: string[];
  chapterTitles: string[];
  title: string;
  kind: "chapter" | "merged";
  output: string;
  srt?: string;
  vtt?: string;
  createdAt: string;
  updatedAt: string;
  duration: number;
  width: number;
  height: number;
  fileSize: number;
  verified: boolean;
  version: number;
  sourceJobId?: string;
  sourceVideoIds?: string[];
};

export const defaults: Settings = {
  provider: "openai",
  mode: "original",
  style: "Điện ảnh chân thực",
  customPrompt: "",
  voice: "ngoc-huyen",
  speed: 1,
  pitch: 0,
  volume: 1,
  pause: 0.4,
  aspect: "16:9",
  burnSubtitles: true,
  font: "Arial",
  color: "#ffffff",
  outline: 2,
  position: "bottom",
  humanCheck: false,
  musicVolume: 0.12,
  brandColor: "#6554d9",
};
