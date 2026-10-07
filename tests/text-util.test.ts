import assert from "node:assert/strict";
import test from "node:test";
import { bailianAudioUrl, bailianSpeechUrl, voicesForModel } from "../src/bailian.ts";
import { buildIdentityPrompt } from "../src/persona.ts";
import {
  buildReviewDocument,
  chunkForSpeech,
  collectModelIds,
  collectVoiceIds,
  decodeBase64Audio,
  extractChatContent,
  fillJsonTemplate,
  getByPath,
  addedSpans,
  addRecord,
  continueMessage,
  createRecord,
  meaningfulLength,
  historyTitle,
  parseHistory,
  polishMessage,
  polishResult,
  sliceAroundCursor,
  speechCatalogBase,
  speechModelsFrom,
  toSpeechText,
  userMessage,
} from "../src/text-util.ts";

test("slice keeps the cursor neighborhood", () => {
  const text = "甲".repeat(100) + "乙".repeat(20) + "丙".repeat(100);
  const sliced = sliceAroundCursor(text, 110, 40);
  assert.equal(sliced.truncated, true);
  assert.equal(sliced.text.length, 40);
  assert.ok(sliced.text.includes("乙"));
});

test("document builder prefers the selection scope", () => {
  const doc = buildReviewDocument({
    title: "第一章",
    path: "小说/第一章.md",
    scope: "selection",
    fullText: "全文不该出现",
    selection: "她把信折好。",
    cursor: 0,
    maxChars: 100,
  });
  assert.equal(doc.text, "她把信折好。");
  assert.match(userMessage(doc, "林雪"), /选中片段/);
  assert.doesNotMatch(userMessage(doc, "林雪"), /全文不该出现/);
});

test("chat content accepts string and part arrays", () => {
  assert.equal(extractChatContent({ choices: [{ message: { content: " 好 " } }] }), "好");
  assert.equal(
    extractChatContent({ choices: [{ message: { content: [{ text: "林" }, { text: "雪" }] } }] }),
    "林雪",
  );
});

test("speech text drops markdown marks", () => {
  const spoken = toSpeechText("## 致命问题\n**拖**一下\n- 第一点\n`名字`");
  assert.equal(spoken.includes("#"), false);
  assert.equal(spoken.includes("**"), false);
  assert.match(spoken, /拖一下/);
  assert.match(spoken, /名字/);
});

test("chunks stay within the limit and never go under eighty", () => {
  const text = Array.from({ length: 30 }, (_, index) => `第${index}句到此为止。`).join("");
  const chunks = chunkForSpeech(text, 90);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 90));
  assert.equal(chunks.join(""), text);
  const floored = chunkForSpeech("甲".repeat(200), 10);
  assert.ok(floored.every((chunk) => chunk.length <= 80));
  assert.ok(floored.length > 1);
});

test("json template inserts quoted values", () => {
  const body = fillJsonTemplate('{"input": {{text}}, "voice": {{voice}}}', {
    text: '她说："走。"',
    voice: "linxue",
  });
  const parsed = JSON.parse(body) as { input: string; voice: string };
  assert.equal(parsed.input, '她说："走。"');
  assert.equal(parsed.voice, "linxue");
});

test("speech catalog keeps speech models and voice ids", () => {
  const ids = collectModelIds({
    data: [{ id: "gpt-4o-mini" }, { id: "tts-1" }, { id: "tts-1" }, { id: "cosyvoice-v2" }],
  });
  const picked = speechModelsFrom(ids);
  assert.deepEqual(picked.models, ["tts-1", "cosyvoice-v2"]);
  assert.equal(picked.usedWholeCatalog, false);
  assert.equal(speechModelsFrom(["plain-chat"]).usedWholeCatalog, true);
  assert.deepEqual(collectVoiceIds({ voices: [{ voice_id: "linxue" }, { name: "alloy" }] }), ["linxue", "alloy"]);
  assert.equal(
    speechCatalogBase("custom", "", "https://example.com/v1/audio/speech?x=1"),
    "https://example.com/v1",
  );
  assert.equal(speechCatalogBase("openai", "https://api.openai.com/v1/", ""), "https://api.openai.com/v1/");
});

test("bailian speech uses the synthesizer path and published voices", () => {
  assert.equal(
    bailianSpeechUrl("https://ws-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/"),
    "https://ws-example.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
  );
  assert.ok(voicesForModel("qwen-audio-3.1-tts-flash").some((voice) => voice.id === "longanhuan_v3.1"));
  assert.equal(voicesForModel("qwen-audio-3.1-realtime-plus").length, 0);
  assert.equal(bailianAudioUrl({ output: { audio: { url: "https://example.com/a.mp3" } } }), "https://example.com/a.mp3");
});

test("identity prompt keeps the chosen name, address, and shared story", () => {
  const prompt = buildIdentityPrompt({
    name: "阿雪",
    userAddress: "阿年",
    background: "后来去写程序了。",
    sharedStory: "我们一起改过第一篇稿。",
    persona: "你的名字是林雪。你是编辑。",
  });
  assert.match(prompt, /你的名字是阿雪/);
  assert.match(prompt, /称呼对方为「阿年」/);
  assert.match(prompt, /后来去写程序了/);
  assert.match(prompt, /以这段为准/);
  assert.match(prompt, /你是编辑/);
});

test("occupation is stated ahead of the role text", () => {
  const prompt = buildIdentityPrompt({
    name: "林雪",
    occupation: "律师",
    userAddress: "",
    background: "",
    sharedStory: "",
    persona: "按律师的方式回答。",
  });
  assert.match(prompt, /你的职业是律师/);
  assert.ok(prompt.indexOf("你的职业是律师") < prompt.indexOf("按律师的方式回答"));
});

test("added text ignores unchanged surroundings", () => {
  const spans = addedSpans("甲乙丙", "甲新增乙丙");
  assert.equal(spans.map((span) => span.text).join(""), "新增");
  assert.equal(meaningfulLength("  \n"), 0);
  assert.equal(meaningfulLength("啊，"), 2);
  assert.match(continueMessage({ name: "林雪", title: "第一章", before: "夜深了", anchor: "她停下笔" }), /她停下笔/);
});

test("polish keeps the passage and drops a wrapping fence", () => {
  const message = polishMessage({
    name: "林雪",
    title: "第一章",
    before: "夜色很静。",
    selection: "她把信折好。",
    after: "灯还亮着。",
  });
  assert.match(message, /她把信折好。/);
  assert.match(message, /前文：夜色很静。/);
  assert.equal(polishResult("```markdown\n她慢慢把信折好。\n```"), "她慢慢把信折好。");
  assert.equal(polishResult("「她把信折好。」"), "她把信折好。");
});

test("review history keeps the newest records and drops broken ones", () => {
  const first = createRecord({
    title: "第一章",
    path: "小说/第一章.md",
    scope: "document",
    mode: "quiet",
    aiName: "林雪",
    source: "她把信折好。",
    reply: "这里缺一个动作之后的反应。",
  });
  const second = createRecord({
    title: "第二章",
    path: "小说/第二章.md",
    scope: "selection",
    mode: "chatty",
    aiName: "阿雪",
    source: "他没有回头。",
    reply: "这句能留。",
  });
  const stored = addRecord(addRecord([], first), second);
  assert.equal(stored[0].title, "第二章");
  assert.equal(stored.length, 2);
  assert.match(historyTitle(second), /选区/);
  const restored = parseHistory(JSON.stringify({ records: [second, { id: "坏的" }, first] }));
  assert.deepEqual(restored.map((record) => record.id), [second.id, first.id]);
});

test("path lookup and base64 audio", () => {
  assert.equal(getByPath({ data: { audio: "abc" } }, "data.audio"), "abc");
  const buffer = decodeBase64Audio("data:audio/mpeg;base64,YQ==");
  assert.equal(new TextDecoder().decode(buffer), "a");
});
