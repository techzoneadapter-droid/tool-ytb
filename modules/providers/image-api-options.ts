// Public metadata only. API keys and environment access stay in image-api.ts.
export const imageAPIOptions = [
  {
    id: "openai",
    label: "OpenAI · GPT Image",
    keyEnv: "OPENAI_API_KEY",
    modelEnv: "OPENAI_IMAGE_MODEL",
  },
  {
    id: "gemini",
    label: "Google Gemini · Nano Banana",
    keyEnv: "GEMINI_API_KEY",
    modelEnv: "GEMINI_IMAGE_MODEL",
  },
  {
    id: "stability",
    label: "Stability AI · Stable Image",
    keyEnv: "STABILITY_API_KEY",
    modelEnv: "STABILITY_IMAGE_MODEL",
  },
  {
    id: "api-compatible",
    label: "Image API · OpenAI compatible",
    keyEnv: "API_IMAGE_KEY",
    modelEnv: "API_IMAGE_MODEL",
  },
] as const;

export type ImageAPIProvider = (typeof imageAPIOptions)[number]["id"];
export type ImageAPIOptions = {
  referenceStrength?: number;
  timeoutSeconds?: number;
  retries?: number;
  concurrency?: number;
  size?: "auto" | "1024x1024" | "1024x1536" | "1536x1024";
  seedMode?: "project" | "chapter" | "off";
  references?: boolean;
  debug?: boolean;
  supportsReferenceImages?: boolean;
  supportsMultiImageInput?: boolean;
  supportsSeed?: boolean;
  supportsNegativePrompt?: boolean;
};
export function validateImageBaseURL(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error("Nhập Base URL API ảnh hợp lệ.");
  }
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error(
      "Base URL phải dùng HTTPS (hoặc HTTP localhost), không chứa key, query hoặc thông tin đăng nhập.",
    );
  return url.href.replace(/\/$/, "");
}
export function isImageAPIProvider(value: unknown): value is ImageAPIProvider {
  return imageAPIOptions.some((option) => option.id === value);
}
