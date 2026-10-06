import { requestUrl } from "obsidian";
import { SPEECH_STYLE, concernInstruction, continueInstruction, displayName, modeInstruction, personaWithName, polishInstruction, temperatureFor } from "./persona";
import type { LinxueSettings, ReviewDocument } from "./types";
import { bailianAudioUrl, bailianFormat, bailianSpeechUrl, isBailianSpeechUrl, voicesForModel, BAILIAN_TTS_MODELS } from "./bailian";
import type { SpeechCatalog } from "./types";
import {
  clipError,
  collectModelIds,
  collectVoiceIds,
  decodeBase64Audio,
  extractChatContent,
  fillJsonTemplate,
  getByPath,
  joinUrl,
  mimeForFormat,
  parseHeaders,
  speechCatalogBase,
  speechModelsFrom,
  concernMessage,
  continueMessage,
  polishMessage,
  polishResult,
  userMessage,
} from "./text-util";

export interface SpeechClip {
  data: ArrayBuffer;
  mime: string;
}

function authHeaders(apiKey: string, extraRaw: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...parseHeaders(extraRaw),
  };
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
  return headers;
}

export async function requestReview(settings: LinxueSettings, doc: ReviewDocument): Promise<string> {
  if (!settings.textBaseUrl.trim() || !settings.textModel.trim()) {
    throw new Error("请先在设置里填写文本接口地址和模型名");
  }
  const url = joinUrl(settings.textBaseUrl, "/chat/completions");
  const body: Record<string, unknown> = {
    model: settings.textModel.trim(),
    temperature: temperatureFor(settings.mode, settings.textTemperature),
    messages: [
      {
        role: "system",
        content: `${personaWithName(settings.persona, settings.aiName)}\n\n${SPEECH_STYLE}\n\n${modeInstruction(settings.mode)}`,
      },
      { role: "user", content: userMessage(doc, displayName(settings.aiName)) },
    ],
  };
  if (settings.textMaxTokens > 0) body.max_tokens = settings.textMaxTokens;
  const response = await requestUrl({
    url,
    method: "POST",
    headers: authHeaders(settings.textApiKey, settings.textExtraHeaders),
    body: JSON.stringify(body),
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(clipError(response.status, response.text));
  }
  const content = extractChatContent(response.json);
  if (!content) throw new Error("文本接口没有返回可读内容");
  return content;
}

async function requestWriting(settings: LinxueSettings, system: string, user: string, temperature: number): Promise<string> {
  if (!settings.textBaseUrl.trim() || !settings.textModel.trim()) {
    throw new Error("请先在设置里填写文本接口地址和模型名");
  }
  const response = await requestUrl({
    url: joinUrl(settings.textBaseUrl, "/chat/completions"),
    method: "POST",
    headers: authHeaders(settings.textApiKey, settings.textExtraHeaders),
    body: JSON.stringify({
      model: settings.textModel.trim(),
      temperature,
      messages: [
        { role: "system", content: `${personaWithName(settings.persona, settings.aiName)}\n\n${system}` },
        { role: "user", content: user },
      ],
    }),
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) throw new Error(clipError(response.status, response.text));
  const content = polishResult(extractChatContent(response.json));
  if (!content) throw new Error("文本接口没有返回可读内容");
  return content;
}

export async function requestContinue(settings: LinxueSettings, input: { title: string; before: string; anchor: string }): Promise<string> {
  return requestWriting(
    settings,
    continueInstruction(settings.mode),
    continueMessage({ ...input, name: displayName(settings.aiName) }),
    Math.min(temperatureFor(settings.mode, settings.textTemperature), 0.85),
  );
}

export async function requestConcern(settings: LinxueSettings, input: { title: string; added: string }): Promise<string> {
  return requestWriting(
    settings,
    `${SPEECH_STYLE}\n\n${concernInstruction()}`,
    concernMessage({ ...input, name: displayName(settings.aiName) }),
    0.7,
  );
}

export async function requestPolish(settings: LinxueSettings, input: { title: string; before: string; selection: string; after: string }): Promise<string> {
  if (!settings.textBaseUrl.trim() || !settings.textModel.trim()) {
    throw new Error("请先在设置里填写文本接口地址和模型名");
  }
  const content = await requestWriting(
    settings,
    polishInstruction(settings.mode),
    polishMessage({ ...input, name: displayName(settings.aiName) }),
    Math.min(temperatureFor(settings.mode, settings.textTemperature), 0.6),
  );
  if (!content) throw new Error("润色结果是空的");
  return content;
}

export async function requestSpeech(settings: LinxueSettings, text: string): Promise<SpeechClip> {
  if (settings.speechProvider === "custom") return requestCustomSpeech(settings, text);
  if (isBailianSpeechUrl(settings.speechBaseUrl)) return requestBailianSpeech(settings, text);
  return requestOpenAiSpeech(settings, text);
}

async function requestOpenAiSpeech(settings: LinxueSettings, text: string): Promise<SpeechClip> {
  if (!settings.speechBaseUrl.trim() || !settings.speechModel.trim()) {
    throw new Error("请先在设置里填写语音接口地址和模型名");
  }
  const url = joinUrl(settings.speechBaseUrl, "/audio/speech");
  const response = await requestUrl({
    url,
    method: "POST",
    headers: authHeaders(settings.speechApiKey, settings.speechExtraHeaders),
    body: JSON.stringify({
      model: settings.speechModel.trim(),
      voice: settings.speechVoice.trim() || "alloy",
      input: text,
      response_format: settings.speechFormat,
    }),
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(clipError(response.status, response.text));
  }
  const mime = response.headers["content-type"] || response.headers["Content-Type"] || mimeForFormat(settings.speechFormat);
  if (mime.includes("json") || mime.includes("text")) {
    throw new Error(clipError(response.status, response.text || "语音接口返回的不是音频"));
  }
  return { data: response.arrayBuffer, mime: mime.split(";")[0] || mimeForFormat(settings.speechFormat) };
}

async function requestBailianSpeech(settings: LinxueSettings, text: string): Promise<SpeechClip> {
  if (!settings.speechModel.trim() || !settings.speechVoice.trim()) {
    throw new Error("请先选择百炼的语音模型和音色");
  }
  if (/realtime/i.test(settings.speechModel)) {
    throw new Error("这个模型是实时对话模型，朗读请改用 qwen-audio-3.1-tts-flash 或 qwen-audio-3.0-tts-flash");
  }
  const response = await requestUrl({
    url: bailianSpeechUrl(settings.speechBaseUrl),
    method: "POST",
    headers: authHeaders(settings.speechApiKey, settings.speechExtraHeaders),
    body: JSON.stringify({
      model: settings.speechModel.trim(),
      input: {
        text,
        voice: settings.speechVoice.trim(),
        format: bailianFormat(settings.speechFormat),
        sample_rate: 24000,
      },
    }),
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(clipError(response.status, response.text));
  }
  const audioUrl = bailianAudioUrl(response.json);
  if (!audioUrl) throw new Error("百炼没有返回音频地址");
  const audio = await requestUrl({ url: audioUrl, method: "GET", throw: false });
  if (audio.status < 200 || audio.status >= 300) {
    throw new Error(clipError(audio.status, audio.text || "音频下载失败"));
  }
  const mime = audio.headers["content-type"] || audio.headers["Content-Type"] || mimeForFormat(settings.speechFormat);
  return { data: audio.arrayBuffer, mime: mime.split(";")[0] || mimeForFormat(settings.speechFormat) };
}

async function requestCustomSpeech(settings: LinxueSettings, text: string): Promise<SpeechClip> {
  if (!settings.customSpeechUrl.trim()) throw new Error("请先填写自定义语音接口地址");
  const body = fillJsonTemplate(settings.customSpeechBody, {
    text,
    voice: settings.speechVoice.trim(),
    model: settings.speechModel.trim(),
    format: settings.speechFormat,
  });
  const response = await requestUrl({
    url: settings.customSpeechUrl.trim(),
    method: "POST",
    headers: authHeaders(settings.speechApiKey, settings.customSpeechHeaders),
    body,
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(clipError(response.status, response.text));
  }
  if (settings.customSpeechResponse === "audio") {
    const mime = response.headers["content-type"] || response.headers["Content-Type"] || settings.customSpeechMime;
    if (mime.includes("json") || mime.includes("text")) {
      throw new Error(clipError(response.status, response.text || "自定义语音接口返回的不是音频"));
    }
    return { data: response.arrayBuffer, mime: mime.split(";")[0] || settings.customSpeechMime };
  }
  const encoded = getByPath(response.json, settings.customSpeechBase64Path.trim() || "audio");
  if (typeof encoded !== "string" || !encoded.trim()) {
    throw new Error("在返回 JSON 里没有找到音频字段，请检查 Base64 路径");
  }
  return {
    data: decodeBase64Audio(encoded),
    mime: settings.customSpeechMime.trim() || "audio/mpeg",
  };
}

export async function detectSpeechCatalog(settings: LinxueSettings): Promise<SpeechCatalog> {
  if (settings.speechProvider === "openai" && isBailianSpeechUrl(settings.speechBaseUrl)) {
    return detectBailianCatalog(settings);
  }
  const base = speechCatalogBase(settings.speechProvider, settings.speechBaseUrl, settings.customSpeechUrl);
  if (!base) throw new Error("请先填写语音接口地址");
  const headers = authHeaders(
    settings.speechApiKey,
    settings.speechProvider === "custom" ? settings.customSpeechHeaders : settings.speechExtraHeaders,
  );
  const modelsResponse = await requestUrl({
    url: joinUrl(base, "/models"),
    method: "GET",
    headers,
    throw: false,
  });
  if (modelsResponse.status < 200 || modelsResponse.status >= 300) {
    throw new Error(clipError(modelsResponse.status, modelsResponse.text));
  }
  const found = speechModelsFrom(collectModelIds(modelsResponse.json));
  if (found.models.length === 0) throw new Error("模型列表是空的");

  let voices: string[] = [];
  const misses: string[] = [];
  for (const path of ["/audio/voices", "/voices"]) {
    const response = await requestUrl({
      url: joinUrl(base, path),
      method: "GET",
      headers,
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      misses.push(`${path} ${response.status}`);
      continue;
    }
    voices = collectVoiceIds(response.json);
    if (voices.length > 0) break;
    misses.push(`${path} 没有音色字段`);
  }

  const notes = [`检测到 ${found.models.length} 个语音模型。`];
  if (found.usedWholeCatalog) {
    notes.push("接口没有标明哪些是语音模型，所以列出了全部模型，请自己选一个语音模型。");
  }
  if (voices.length > 0) notes.push(`检测到 ${voices.length} 个音色。`);
  else notes.push(`这个接口没有返回音色列表（${misses.join("，")}）。音色请按服务商文档手填。`);
  return { models: found.models, voices, note: notes.join("") };
}

async function detectBailianCatalog(settings: LinxueSettings): Promise<SpeechCatalog> {
  const chosen = BAILIAN_TTS_MODELS.includes(settings.speechModel.trim())
    ? settings.speechModel.trim()
    : BAILIAN_TTS_MODELS[0];
  const voices = voicesForModel(chosen).map((voice) => voice.id);
  const probe = await requestUrl({
    url: bailianSpeechUrl(settings.speechBaseUrl),
    method: "POST",
    headers: authHeaders(settings.speechApiKey, settings.speechExtraHeaders),
    body: JSON.stringify({
      model: chosen,
      input: { text: "在。", voice: voices[0], format: "mp3", sample_rate: 24000 },
    }),
    throw: false,
  });
  if (probe.status === 401 || probe.status === 403) {
    throw new Error(clipError(probe.status, probe.text));
  }
  const reachable = probe.status >= 200 && probe.status < 300 && Boolean(bailianAudioUrl(probe.json));
  const note = reachable
    ? `百炼语音接口可用。已载入 ${BAILIAN_TTS_MODELS.length} 个朗读模型和 ${voices.length} 个系统音色。`
    : `已载入百炼系统音色。接口探测返回 ${probe.status}，请确认模型和音色属于同一组后再试听。`;
  return { models: [...BAILIAN_TTS_MODELS], voices, note };
}

export async function pingText(settings: LinxueSettings): Promise<string> {
  const probe: ReviewDocument = {
    title: "连通测试",
    path: "",
    scope: "document",
    text: "请只回复两个字：在的。不要点评。",
    truncated: false,
    omittedNote: "这是设置页的连通测试，不是文稿。",
  };
  return requestReview(settings, probe);
}
