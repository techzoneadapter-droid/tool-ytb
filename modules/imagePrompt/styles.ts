export const imageStyles = [
  {
    name: "Tu tiên",
    prompt:
      "Chinese xianxia cultivation, immortal sects, spiritual energy, mystical mountains, cinematic lighting.",
  },
  {
    name: "Tiên hiệp",
    prompt:
      "Xianxia immortal heroes, floating palaces, celestial swords, mystical clouds, epic composition.",
  },
  {
    name: "Kiếm hiệp",
    prompt:
      "Wuxia swordsmen, ancient China, bamboo forest, intricate robes, cinematic martial arts film still.",
  },
  {
    name: "Cổ trang",
    prompt:
      "Historical Chinese period drama, detailed hanfu, traditional palaces, natural cinematic lighting.",
  },
  {
    name: "Anime cinematic",
    prompt:
      "Cinematic anime, detailed painted backgrounds, expressive faces, dramatic lighting, coherent character design.",
  },
  {
    name: "3D realistic",
    prompt:
      "Realistic 3D cinematic render, physically based materials, detailed skin and fabric, global illumination.",
  },
  {
    name: "Review phim",
    prompt:
      "Cinematic movie review illustration, dramatic film still, expressive subjects, realistic lighting, clear composition.",
  },
  {
    name: "Tu tiên / Tiên hiệp",
    prompt:
      "Chinese xianxia cultivation fantasy, immortal sect, spiritual energy, ancient mountains, floating palaces, mystical clouds, dramatic cinematic lighting, detailed costume, consistent characters, epic composition, no text, no watermark.",
  },
  {
    name: "Huyền huyễn",
    prompt:
      "Chinese xuanhuan fantasy, otherworldly realms, ancient divine beasts, magical artifacts, immense landscapes, vivid spiritual powers, richly detailed robes, epic fantasy composition.",
  },
  {
    name: "Võ hiệp cổ trang",
    prompt:
      "Wuxia martial arts period drama, wandering swordsmen, traditional Chinese weapons, bamboo forests, dynamic combat poses, practical ancient clothing, atmospheric lighting.",
  },
  {
    name: "Cổ trang Trung Hoa",
    prompt:
      "Historical Chinese period drama, traditional architecture, authentic layered hanfu, imperial courtyards, intricate embroidered fabrics, natural cinematic light.",
  },
  {
    name: "Anime",
    prompt:
      "Japanese anime illustration, expressive character faces, clean line art, cel shading, detailed atmospheric backgrounds, dramatic composition.",
  },
  {
    name: "Manhua",
    prompt:
      "Chinese manhua illustration, elegant detailed linework, flowing robes, expressive characters, vibrant digital painting, dynamic vertical storytelling composition.",
  },
  {
    name: "Dark fantasy",
    prompt:
      "Dark fantasy, ominous ancient ruins, unsettling mystical atmosphere, weathered armor, deep shadows, restrained cold colors, dramatic chiaroscuro.",
  },
  {
    name: "Điện ảnh chân thực",
    prompt:
      "Photorealistic cinematic film still, believable anatomy and materials, natural skin texture, motivated lighting, atmospheric depth, cinematic composition.",
  },
  {
    name: "Hoạt hình 2.5D",
    prompt:
      "2.5D animated film style, painterly layered environments, softly modeled characters, dimensional lighting, stylized depth, appealing shapes.",
  },
  {
    name: "Chibi",
    prompt:
      "Chibi illustration, small stylized bodies, oversized expressive heads, charming simplified shapes, bright clean colors, soft light.",
  },
];
export function styledPrompt(text: string, style: string, custom = "") {
  const preset =
    imageStyles.find((p) => p.name === style) ||
    imageStyles.find((p) => p.name === "Điện ảnh chân thực")!;
  return (
    preset.prompt +
    " Scene: " +
    text +
    ". " +
    custom +
    " Consistent characters, no text, no watermark."
  );
}
