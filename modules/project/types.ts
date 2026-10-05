export type Scene = {
  chapterId?: string;
  chapterMasterImage?: string;
  chapterSceneIndex?: number;
  flow?: {
    sceneId: string;
    chapterId: string;
    status: "pending" | "tts" | "image" | "rendering" | "done" | "error";
    prompt: string;
    voiceStatus?: "pending" | "done" | "error" | "skipped";
    imageGenerated?: boolean;
    videoPath?: string;
    videoRecordId?: string;
    renderKey?: string;
    errorCode?: string;
    errorMessage?: string;
    errorStage?: string;
    updatedAt: string;
  };
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
  masterImage?: ChapterImageJob;
  chapterImageGenerationCount?: number;
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
    | "aihorde"
    | "pollinations"
    | "flow-browser"
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
  characterBible?: CharacterBible;
  id: string;
  name: string;
  createdAt: string;
  chapters: Chapter[];
  settings: Settings;
};
export type ChapterImageJob = {
  generationCount?: number;
  submitCount?: number;
  imageCount?: number;
  requestId: string;
  projectId: string;
  chapterId: string;
  chapterIndex: number;
  prompt: string;
  status:
    | "pending"
    | "preparing"
    | "submitting"
    | "generating"
    | "capturing"
    | "ready"
    | "error";
  startedAt?: string;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  errorStage?: string;
};
export type ChapterRuntimeContext = {
  chapterId: string;
  masterImageBuffer?: Buffer;
  masterImageMime?: string;
};
export type CharacterBible = {
  version: 1;
  referenceImageStatus: "NOT CURRENTLY VERIFIED";
  characters: {
    characterId: string;
    name: string;
    gender: string;
    approximateAge: number | null;
    faceDescription: string;
    hair: string;
    body: string;
    clothing: string;
    distinctiveFeatures: string;
    role: string;
    sourceDescription: string;
  }[];
};
export type Job = {
  startedAt?: string;
  finishedAt?: string;
  id: string;
  projectId: string;
  chapterIds: string[];
  batchId?: string;
  batchIndex?: number;
  batchTotal?: number;
  status:
    | "queued"
    | "audio"
    | "images"
    | "rendering"
    | "paused"
    | "cancelled"
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
    imageTotal?: number;
    rendered?: number;
    total: number;
    failed: number;
  };
  stageProgress?: {
    label: string;
    current: number;
    total: number;
    detail: string;
    concurrency?: number;
    elapsedSeconds?: number;
    etaSeconds?: number;
    ratePerMinute?: number;
    updatedAt: string;
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
  outputMode?: "separate" | "merged";
  outputs?: {
    chapterIds: string[];
    output: string;
    srt?: string;
    vtt?: string;
    verified: boolean;
  }[];
  sceneIds?: string[];
  verified?: boolean;
  prepare?: boolean;
  progress: number;
  message: string;
  output?: string;
  srt?: string;
  vtt?: string;
  error?: string;
  sceneErrors?: {
    requestId?: string;
    sceneId: string;
    chapterId: string;
    sceneIndex: number;
    code: string;
    stage: string;
    message: string;
  }[];
  createdAt: string;
  snapshot: Pick<Project, "settings">;
};
export type VideoRecord = {
  id: string;
  projectId: string;
  chapterIds: string[];
  chapterTitles: string[];
  title: string;
  kind: "scene" | "chapter" | "merged";
  sceneId?: string;
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
