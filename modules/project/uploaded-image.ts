import type { Settings } from "./types";

export const uploadedImageRequired =
  "Hãy tải một ảnh dùng chung lên trước khi tạo video.";
export const imageGenerationRemoved =
  "Tạo ảnh bằng AI đã được bỏ. Video chỉ sử dụng một ảnh bạn tải lên.";

/** Preserve all video/audio options while enforcing the app's single-image mode. */
export function uploadedImageSettings(settings: Settings): Settings {
  return { ...settings, imageEnabled: false };
}
