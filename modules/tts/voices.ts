export const voiceFilters = [
  "Tất cả",
  "Nam",
  "Nữ",
  "Review phim",
  "Sách nói",
  "Kể chuyện",
] as const;
export type VoiceFilter = (typeof voiceFilters)[number];
export type VoicePreset = {
  id: string;
  name: string;
  description: string;
  gender: "Nam" | "Nữ";
  categories: VoiceFilter[];
};
// Local presets, not claims about an identifiable person's voice or a vendor catalogue.
// Attach a licensed provider's voice ID only after verifying that provider's catalogue.
export const vietnameseVoices: VoicePreset[] = [
  {
    id: "ngoc-huyen",
    name: "Ngọc Huyền",
    description: "Nữ miền Bắc, rõ chữ, hợp sách nói và truyện.",
    gender: "Nữ",
    categories: ["Sách nói", "Kể chuyện"],
  },
  {
    id: "minh-quan",
    name: "Minh Quân",
    description: "Nam miền Bắc, trầm, hợp review phim.",
    gender: "Nam",
    categories: ["Review phim"],
  },
  {
    id: "hoai-my",
    name: "Hoài My",
    description: "Nữ nhẹ nhàng, hợp truyện cảm xúc.",
    gender: "Nữ",
    categories: ["Kể chuyện", "Sách nói"],
  },
  {
    id: "thuy-duong",
    name: "Thuỳ Dương",
    description: "Nữ miền Nam, ấm áp, nhịp kể tự nhiên.",
    gender: "Nữ",
    categories: ["Kể chuyện"],
  },
  {
    id: "bao-long",
    name: "Bảo Long",
    description: "Nam mạnh, hợp thuyết minh.",
    gender: "Nam",
    categories: ["Review phim"],
  },
  {
    id: "nam-bac",
    name: "Nam miền Bắc",
    description: "Phát âm rõ ràng, nhịp đọc đều, dễ nghe.",
    gender: "Nam",
    categories: ["Sách nói"],
  },
  {
    id: "nu-bac",
    name: "Nữ miền Bắc",
    description: "Thanh sáng, rõ chữ, phù hợp đọc truyện.",
    gender: "Nữ",
    categories: ["Sách nói", "Kể chuyện"],
  },
  {
    id: "nam-nam",
    name: "Nam miền Nam",
    description: "Gần gũi, ấm, phù hợp kể chuyện đời thường.",
    gender: "Nam",
    categories: ["Kể chuyện"],
  },
  {
    id: "nu-nam",
    name: "Nữ miền Nam",
    description: "Mềm mại, tự nhiên, phù hợp sách nói.",
    gender: "Nữ",
    categories: ["Sách nói", "Kể chuyện"],
  },
  {
    id: "review-phim",
    name: "Giọng review phim",
    description: "Nam, nhịp nhanh, nhấn mạnh diễn biến hấp dẫn.",
    gender: "Nam",
    categories: ["Review phim"],
  },
  {
    id: "sach-noi",
    name: "Giọng sách nói",
    description: "Nữ, rõ chữ, tốc độ vừa, dễ theo dõi nội dung dài.",
    gender: "Nữ",
    categories: ["Sách nói"],
  },
  {
    id: "dem-khuya",
    name: "Giọng kể chuyện đêm khuya",
    description: "Nam trầm, chậm rãi, hợp truyện nhẹ nhàng.",
    gender: "Nam",
    categories: ["Kể chuyện"],
  },
  {
    id: "tin-tuc",
    name: "Giọng tin tức",
    description: "Nữ, mạch lạc, dứt khoát, phù hợp bản tin.",
    gender: "Nữ",
    categories: [],
  },
];
export function getVietnameseVoice(id: string) {
  return vietnameseVoices.find((v) => v.id === id);
}
export function filterVoices(filter: VoiceFilter) {
  return vietnameseVoices.filter(
    (v) =>
      filter === "Tất cả" ||
      v.gender === filter ||
      v.categories.includes(filter),
  );
}
export const legacyOpenAIVoices = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
];
