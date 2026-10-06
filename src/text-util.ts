import type { ReviewMode } from "./persona";
import type { ReviewDocument, ReviewScope } from "./types";

export const HISTORY_LIMIT = 40;

export interface ReviewRecord {
  id: string;
  createdAt: number;
  title: string;
  path: string;
  scope: ReviewScope;
  mode: ReviewMode;
  aiName: string;
  excerpt: string;
  reply: string;
}

export function createRecord(input: Omit<ReviewRecord, "id" | "createdAt" | "excerpt"> & { source: string }): ReviewRecord {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    title: input.title,
    path: input.path,
    scope: input.scope,
    mode: input.mode,
    aiName: input.aiName,
    excerpt: input.source.replace(/\s+/g, " ").trim().slice(0, 42),
    reply: input.reply,
  };
}

export function addRecord(records: ReviewRecord[], record: ReviewRecord): ReviewRecord[] {
  return [record, ...records.filter((item) => item.id !== record.id)].slice(0, HISTORY_LIMIT);
}

export function parseHistory(raw: string): ReviewRecord[] {
  try {
    const parsed = JSON.parse(raw) as { records?: unknown };
    if (!Array.isArray(parsed.records)) return [];
    return parsed.records.filter(isRecord).slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function historyStamp(createdAt: number): string {
  const date = new Date(createdAt);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

const MODE_TEXT: Record<ReviewMode, string> = {
  chatty: "话痨",
  quiet: "淑女安静",
  balanced: "中庸",
};

export function historyTitle(record: ReviewRecord): string {
  const scope = record.scope === "selection" ? "选区" : "全文";
  return `${historyStamp(record.createdAt)} · ${record.title} · ${MODE_TEXT[record.mode]} · ${scope}`;
}

function isRecord(value: unknown): value is ReviewRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ReviewRecord>;
  return typeof row.id === "string"
    && typeof row.createdAt === "number"
    && typeof row.title === "string"
    && typeof row.reply === "string"
    && (row.scope === "document" || row.scope === "selection")
    && (row.mode === "chatty" || row.mode === "quiet" || row.mode === "balanced");
}

export function joinUrl(base: string, path: string): string {
  const root = base.trim().replace(/\/+$/, "");
  const tail = path.startsWith("/") ? path : `/${path}`;
  return `${root}${tail}`;
}

export function parseHeaders(raw: string): Record<string, string> {
  const text = raw.trim();
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("请求头必须是 JSON 对象");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`请求头 ${key} 的值必须是字符串`);
    }
    headers[key] = String(value);
  }
  return headers;
}

export function sliceAroundCursor(text: string, cursor: number, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0 || text.length <= maxChars) {
    return { text, truncated: false };
  }
  const safeCursor = Math.min(Math.max(cursor, 0), text.length);
  const half = Math.floor(maxChars / 2);
  let start = Math.max(0, safeCursor - half);
  let end = Math.min(text.length, start + maxChars);
  start = Math.max(0, end - maxChars);
  return { text: text.slice(start, end), truncated: true };
}

export function buildReviewDocument(input: {
  title: string;
  path: string;
  scope: ReviewScope;
  fullText: string;
  selection: string;
  cursor: number;
  maxChars: number;
}): ReviewDocument {
  const selected = input.selection.trim();
  const source = input.scope === "selection" ? selected : input.fullText;
  const cursor = input.scope === "selection" ? 0 : input.cursor;
  const sliced = sliceAroundCursor(source, cursor, input.maxChars);
  let omittedNote = "";
  if (input.scope === "selection") {
    omittedNote = "用户指定只看选中的这一段。";
  } else if (sliced.truncated) {
    omittedNote = "全文超过字数上限，下面只保留了光标附近的一段，更早或更后的文字没有送进来。";
  }
  return {
    title: input.title || "未命名",
    path: input.path || "",
    scope: input.scope,
    text: sliced.text.trim(),
    truncated: sliced.truncated,
    omittedNote,
  };
}

export interface AddedSpan {
  start: number;
  text: string;
}

export function addedSpans(before: string, after: string): AddedSpan[] {
  let prefix = 0;
  const limit = Math.min(before.length, after.length);
  while (prefix < limit && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  const inserted = after.slice(prefix, after.length - suffix);
  if (!inserted) return [];
  return [{ start: prefix, text: inserted }];
}

export function meaningfulLength(text: string): number {
  const marks = text.match(/[\p{L}\p{N}\p{P}\p{S}]/gu);
  return marks ? marks.length : 0;
}

export function continueMessage(input: { name: string; title: string; before: string; anchor: string }): string {
  const context = input.before.replace(/\s+/g, " ").trim().slice(-500);
  return [
    `${input.name}，请替我把《${input.title}》从这段往下续写。`,
    "只写接在下面这段之后的新正文。",
    context ? `更早的上下文：${context}` : "更早的上下文：没有。",
    "",
    "请从这里往后写：",
    input.anchor,
  ].join("\n");
}

export function concernMessage(input: { name: string; title: string; added: string }): string {
  return [
    `${input.name}，我在《${input.title}》里这一阵只写了这么几个字：`,
    input.added.trim() || "（几乎是空白）",
    "你关心一下我是不是卡文了。",
  ].join("\n");
}

export function polishMessage(input: { name: string; title: string; before: string; selection: string; after: string }): string {
  const around = (text: string) => text.replace(/\s+/g, " ").trim().slice(-180);
  const ahead = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 180);
  return [
    `${input.name}，请润色我在《${input.title}》里选中的这段。`,
    "前后文只供你判断语气和衔接，不要写进结果。",
    input.before.trim() ? `前文：${around(input.before)}` : "前文：没有。",
    input.after.trim() ? `后文：${ahead(input.after)}` : "后文：没有。",
    "",
    "需要润色的原文：",
    input.selection,
  ].join("\n");
}

export function polishResult(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fenced) text = fenced[1].trim();
  if (text.startsWith("「") && text.endsWith("」")) text = text.slice(1, -1).trim();
  if ((text.startsWith("“") && text.endsWith("”")) || (text.startsWith("\"") && text.endsWith("\""))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

export function userMessage(doc: ReviewDocument, name: string): string {
  const where = doc.scope === "selection" ? "选中片段" : "当前文稿";
  const lines = [
    `${name}，这是我正在写的${where}《${doc.title}》。`,
    doc.path ? `路径：${doc.path}` : "",
    doc.omittedNote,
    "请按我们约定的方式点评不足，并保持你现在的说话模式。不要重写整章。",
    "",
    doc.text || "（这篇是空的，我还没写字。）",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

export function extractChatContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("")
    .trim();
}

export function toSpeechText(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, "这里有一段示例，你可以看屏幕上的文字。")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chunkForSpeech(text: string, size: number): string[] {
  const limit = Math.max(80, size);
  const pieces = text.split(/(?<=[。！？!?；;\n])/u);
  const chunks: string[] = [];
  let buffer = "";
  const pushBuffer = () => {
    const value = buffer.trim();
    if (value) chunks.push(...hardSplit(value, limit));
    buffer = "";
  };
  for (const piece of pieces) {
    if (!piece) continue;
    if (buffer && buffer.length + piece.length > limit) pushBuffer();
    buffer += piece;
  }
  pushBuffer();
  return chunks.length > 0 ? chunks : [text.trim()].filter(Boolean);
}

function hardSplit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("，", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

export function fillJsonTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    if (!(key in vars)) return match;
    return JSON.stringify(vars[key]);
  });
}

export function getByPath(payload: unknown, path: string): unknown {
  const parts = path.split(".").map((part) => part.trim()).filter(Boolean);
  let current: unknown = payload;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function decodeBase64Audio(value: string): ArrayBuffer {
  const cleaned = value.replace(/^data:.*?;base64,/i, "").replace(/\s+/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function mimeForFormat(format: string): string {
  if (format === "wav") return "audio/wav";
  if (format === "opus") return "audio/ogg";
  return "audio/mpeg";
}

export function clipError(status: number, body: string): string {
  const compact = body.replace(/\s+/g, " ").trim().slice(0, 280);
  return compact ? `接口返回 ${status}：${compact}` : `接口返回 ${status}`;
}

const SPEECH_MODEL_PATTERN = /tts|speech|audio|voice|cosy|fish|minimax|qwen[-_.]?tts|gpt-4o-mini-tts/i;

export function looksLikeSpeechModel(id: string): boolean {
  return SPEECH_MODEL_PATTERN.test(id);
}

export function collectModelIds(payload: unknown): string[] {
  const listed = getByPath(payload, "data");
  const rows = Array.isArray(listed) ? listed : Array.isArray(payload) ? payload : [];
  return uniqueStrings(rows.map(modelId));
}

export function speechModelsFrom(ids: string[]): { models: string[]; usedWholeCatalog: boolean } {
  const speech = ids.filter(looksLikeSpeechModel);
  if (speech.length > 0) return { models: speech, usedWholeCatalog: false };
  return { models: ids, usedWholeCatalog: ids.length > 0 };
}

export function collectVoiceIds(payload: unknown): string[] {
  const candidates = [
    getByPath(payload, "voices"),
    getByPath(payload, "data.voices"),
    getByPath(payload, "data"),
    Array.isArray(payload) ? payload : undefined,
  ];
  for (const rows of candidates) {
    if (!Array.isArray(rows)) continue;
    const ids = uniqueStrings(rows.map(voiceId));
    if (ids.length > 0) return ids;
  }
  return [];
}

export function speechCatalogBase(provider: "openai" | "custom", baseUrl: string, customUrl: string): string {
  if (provider === "openai") return baseUrl.trim();
  const raw = customUrl.trim();
  if (!raw) return "";
  const url = new URL(raw);
  const marker = "/audio/speech";
  const at = url.pathname.indexOf(marker);
  url.pathname = at >= 0 ? url.pathname.slice(0, at) || "/" : "/v1";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function modelId(item: unknown): string {
  if (typeof item === "string") return item.trim();
  if (!item || typeof item !== "object") return "";
  const id = (item as { id?: unknown }).id;
  return typeof id === "string" ? id.trim() : "";
}

function voiceId(item: unknown): string {
  if (typeof item === "string") return item.trim();
  if (!item || typeof item !== "object") return "";
  const row = item as Record<string, unknown>;
  for (const key of ["voice", "voice_id", "id", "name", "voice_name"]) {
    if (typeof row[key] === "string" && row[key].trim()) return row[key].trim();
  }
  return "";
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
