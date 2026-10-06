import catalog from "./bailian-voices.json" with { type: "json" };

export interface BailianVoice {
  id: string;
  name: string;
}

export interface BailianVoiceGroup {
  title: string;
  voices: BailianVoice[];
}

export const BAILIAN_VOICE_GROUPS = catalog as BailianVoiceGroup[];

export const BAILIAN_TTS_MODELS = BAILIAN_VOICE_GROUPS.map((group) => group.title);

const SYNTHESIZER_PATH = "/api/v1/services/audio/tts/SpeechSynthesizer";

export function isBailianSpeechUrl(baseUrl: string): boolean {
  return /maas\.aliyuncs\.com|dashscope\.aliyuncs\.com/i.test(baseUrl);
}

export function bailianSpeechUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  url.pathname = SYNTHESIZER_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function voicesForModel(model: string): BailianVoice[] {
  const exact = BAILIAN_VOICE_GROUPS.find((group) => group.title === model.trim());
  return exact?.voices ?? [];
}

export function bailianFormat(format: string): "mp3" | "wav" | "opus" {
  if (format === "wav" || format === "opus") return format;
  return "mp3";
}

export function bailianAudioUrl(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const output = (payload as { output?: unknown }).output;
  const sources = [output, payload];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const row = source as Record<string, unknown>;
    const audio = row.audio;
    if (audio && typeof audio === "object") {
      const url = (audio as { url?: unknown }).url;
      if (typeof url === "string" && url.trim()) return url.trim();
    }
    for (const key of ["audio_url", "url"]) {
      if (typeof row[key] === "string" && /^https?:\/\//.test(row[key])) return row[key].trim();
    }
  }
  return "";
}
