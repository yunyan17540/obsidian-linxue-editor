import catalog from "./bailian-voices.json" with { type: "json" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface BailianVoice {
  id: string;
  name: string;
}

export interface BailianVoiceGroup {
  title: string;
  voices: BailianVoice[];
}

export const BAILIAN_VOICE_GROUPS = readVoiceGroups(catalog);

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
  if (!isRecord(payload)) return "";
  const output = payload["output"];
  const sources = [output, payload];
  for (const source of sources) {
    if (!isRecord(source)) continue;
    const audio = source["audio"];
    if (isRecord(audio)) {
      const url = audio["url"];
      if (typeof url === "string" && url.trim()) return url.trim();
    }
    for (const key of ["audio_url", "url"]) {
      const value = source[key];
      if (typeof value === "string" && /^https?:\/\//.test(value)) return value.trim();
    }
  }
  return "";
}

function readVoiceGroups(value: unknown): BailianVoiceGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: BailianVoiceGroup[] = [];
  for (const group of value) {
    if (!isRecord(group) || typeof group["title"] !== "string" || !Array.isArray(group["voices"])) continue;
    const voices: BailianVoice[] = [];
    for (const voice of group["voices"]) {
      if (!isRecord(voice) || typeof voice["id"] !== "string" || typeof voice["name"] !== "string") continue;
      voices.push({ id: voice["id"], name: voice["name"] });
    }
    groups.push({ title: group["title"], voices });
  }
  return groups;
}
