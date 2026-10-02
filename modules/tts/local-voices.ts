export const localProviderIds = [
  "vieneu-local",
  "korva-local",
  "tts-studio-local",
] as const;
export type LocalProvider = (typeof localProviderIds)[number];
export type TTSProvider = LocalProvider | "cloud";
export const localVoiceNames: Record<string, string> = {
  ngoc_huyen: "Ngọc Huyền",
  bao_kim: "Bảo Kim",
  khanh_vy: "Khánh Vy",
  phuong_linh: "Phương Linh",
  quynh_nhu: "Quỳnh Như",
  gia_bao: "Gia Bảo",
  hoang_nam: "Hoàng Nam",
  huu_dat: "Hữu Đạt",
  quang_huy: "Quang Huy",
  thanh_phong: "Thanh Phong",
};
export const localVoices = Object.entries(localVoiceNames).map(
  ([id, name], i) => ({
    id,
    name,
    gender: i < 5 ? "Nữ" : "Nam",
    description: "Giọng dựng sẵn của KorvaTTS, chạy trên máy.",
    categories: ["Sách nói", "Kể chuyện"],
  }),
);
export function localVoiceId(id: string) {
  if (id === "Ngọc Huyền") return "ngoc_huyen";
  return id.replaceAll("-", "_");
}
