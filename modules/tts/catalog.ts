export type EngineVoice = {
  id: string;
  name?: string;
  description?: string;
  gender?: string;
  aliases?: string[];
};
export function voiceKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
export function findEngineVoice(voices: EngineVoice[], value: string) {
  return (
    voices.find((v) => v.id === value) ||
    voices.find((v) =>
      [v.id, v.name, ...(v.aliases || [])].some(
        (x) => x && voiceKey(x) === voiceKey(value),
      ),
    )
  );
}
