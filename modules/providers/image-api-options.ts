// Public metadata only. API keys and environment access stay in image-api.ts.
export const imageAPIOptions = [
  { id: "openai", label: "OpenAI · GPT Image", keyEnv: "OPENAI_API_KEY", modelEnv: "OPENAI_IMAGE_MODEL" },
  { id: "gemini", label: "Google Gemini · Nano Banana", keyEnv: "GEMINI_API_KEY", modelEnv: "GEMINI_IMAGE_MODEL" },
  { id: "stability", label: "Stability AI · Stable Image", keyEnv: "STABILITY_API_KEY", modelEnv: "STABILITY_IMAGE_MODEL" },
] as const;

export type ImageAPIProvider = (typeof imageAPIOptions)[number]["id"];
export function isImageAPIProvider(value: unknown): value is ImageAPIProvider {
  return imageAPIOptions.some(option => option.id === value);
}
