import type { ReviewMode } from "./persona";
import type { ReviewRecord } from "./text-util";

export type SpeechProvider = "openai" | "custom";
export type SpeechBinaryFormat = "mp3" | "wav" | "opus";
export type CustomSpeechResponse = "audio" | "base64";
export type ReviewScope = "document" | "selection";

export interface LinxueSettings {
  aiName: string;
  mode: ReviewMode;
  persona: string;
  textBaseUrl: string;
  textApiKey: string;
  textModel: string;
  textTemperature: number;
  textMaxTokens: number;
  textExtraHeaders: string;
  maxChars: number;
  speechProvider: SpeechProvider;
  speechBaseUrl: string;
  speechApiKey: string;
  speechModel: string;
  speechVoice: string;
  speechFormat: SpeechBinaryFormat;
  speechExtraHeaders: string;
  speechChunkSize: number;
  customSpeechUrl: string;
  customSpeechHeaders: string;
  customSpeechBody: string;
  customSpeechResponse: CustomSpeechResponse;
  customSpeechBase64Path: string;
  customSpeechMime: string;
  speechModelChoices: string[];
  speechVoiceChoices: string[];
  speechDetectNote: string;
  autoReview: boolean;
  autoReviewMinutes: number;
}

export interface SpeechCatalog {
  models: string[];
  voices: string[];
  note: string;
}

export interface LinxueHost {
  settings: LinxueSettings;
  saveSettings(): Promise<void>;
  review(scope: ReviewScope): Promise<void>;
  polishSelection(): Promise<void>;
  continueWriting(): Promise<void>;
  stopSpeaking(): void;
  testText(): Promise<string>;
  testSpeech(): Promise<void>;
  detectSpeech(): Promise<SpeechCatalog>;
  listHistory(): ReviewRecord[];
  openHistory(id: string): Promise<void>;
  deleteHistory(id: string): Promise<void>;
  clearHistory(): Promise<void>;
}

export interface ReviewDocument {
  title: string;
  path: string;
  scope: ReviewScope;
  text: string;
  truncated: boolean;
  omittedNote: string;
}
