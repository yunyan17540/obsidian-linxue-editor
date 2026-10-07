import { App, Notice, Plugin, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import { BAILIAN_TTS_MODELS, isBailianSpeechUrl, voicesForModel } from "./bailian";
import { DEFAULT_AI_NAME, DEFAULT_PERSONA, DEFAULT_PROGRAMMER_PERSONA, MODE_HINT, MODE_LABEL, isReviewMode, reviewModes, type IdentityProfile } from "./persona";
import { isRecord } from "./text-util";
import type { CustomSpeechResponse, LinxueHost, LinxueSettings, SpeechBinaryFormat, SpeechCatalog, SpeechProvider } from "./types";

type TextSettingKey =
  | "textBaseUrl"
  | "textApiKey"
  | "textModel"
  | "textExtraHeaders"
  | "speechBaseUrl"
  | "speechApiKey"
  | "speechExtraHeaders"
  | "customSpeechUrl"
  | "customSpeechHeaders"
  | "customSpeechBody"
  | "customSpeechBase64Path"
  | "customSpeechMime"
  | "background"
  | "sharedStory";

type NumberSettingKey = "textTemperature" | "textMaxTokens" | "maxChars" | "speechChunkSize" | "autoReviewMinutes";

export const DEFAULT_SETTINGS: LinxueSettings = {
  aiName: DEFAULT_AI_NAME,
  userAddress: "",
  background: "",
  sharedStory: "",
  identity: "editor",
  identities: [],
  editorPersona: DEFAULT_PERSONA,
  programmerPersona: DEFAULT_PROGRAMMER_PERSONA,
  mode: "balanced",
  persona: DEFAULT_PERSONA,
  textBaseUrl: "https://api.openai.com/v1",
  textApiKey: "",
  textModel: "",
  textTemperature: 0,
  textMaxTokens: 0,
  textExtraHeaders: "",
  maxChars: 12000,
  speechProvider: "openai",
  speechBaseUrl: "https://api.openai.com/v1",
  speechApiKey: "",
  speechModel: "tts-1",
  speechVoice: "alloy",
  speechFormat: "mp3",
  speechExtraHeaders: "",
  speechChunkSize: 450,
  customSpeechUrl: "",
  customSpeechHeaders: "",
  customSpeechBody: '{\n  "model": {{model}},\n  "voice": {{voice}},\n  "input": {{text}}\n}',
  customSpeechResponse: "audio",
  customSpeechBase64Path: "audio",
  customSpeechMime: "audio/mpeg",
  speechModelChoices: [],
  speechVoiceChoices: [],
  speechDetectNote: "",
  autoReview: false,
  autoReviewMinutes: 15,
};

export function defaultIdentities(editorPersona = DEFAULT_PERSONA, programmerPersona = DEFAULT_PROGRAMMER_PERSONA): IdentityProfile[] {
  return [
    { id: "editor", label: "小说编辑", occupation: "小说编辑", persona: editorPersona.trim() || DEFAULT_PERSONA, builtin: "editor" },
    { id: "programmer", label: "程序员", occupation: "程序员", persona: programmerPersona.trim() || DEFAULT_PROGRAMMER_PERSONA, builtin: "programmer" },
  ];
}

export function normalizeIdentity(settings: LinxueSettings): void {
  if (!settings.aiName?.trim()) settings.aiName = DEFAULT_AI_NAME;
  const editorText = settings.editorPersona?.trim() || settings.persona?.trim() || DEFAULT_PERSONA;
  const programmerText = settings.programmerPersona?.trim() || DEFAULT_PROGRAMMER_PERSONA;
  const incoming = Array.isArray(settings.identities) ? settings.identities : [];
  const cleaned = incoming.flatMap((item) => cleanIdentity(item));
  const editor = cleaned.find((item) => item.builtin === "editor" || item.id === "editor");
  const programmer = cleaned.find((item) => item.builtin === "programmer" || item.id === "programmer");
  const extras = cleaned.filter((item) => item !== editor && item !== programmer);
  settings.identities = [
    { id: "editor", label: editor?.label.trim() || "小说编辑", occupation: editor?.occupation.trim() || "小说编辑", persona: editor?.persona.trim() || editorText, builtin: "editor" },
    { id: "programmer", label: programmer?.label.trim() || "程序员", occupation: programmer?.occupation.trim() || "程序员", persona: programmer?.persona.trim() || programmerText, builtin: "programmer" },
    ...extras,
  ];
  settings.editorPersona = settings.identities[0].persona;
  settings.programmerPersona = settings.identities[1].persona;
  if (!settings.identities.some((item) => item.id === settings.identity)) settings.identity = "editor";
  const active = settings.identities.find((item) => item.id === settings.identity) ?? settings.identities[0];
  settings.persona = active.persona;
}

let customSerial = 0;

function cleanIdentity(item: Partial<IdentityProfile> | null): IdentityProfile[] {
  if (!item || (item.builtin !== "editor" && item.builtin !== "programmer" && !item.label?.trim() && !item.persona?.trim())) return [];
  const builtin = item.builtin === "editor" || item.builtin === "programmer" ? item.builtin : undefined;
  customSerial += 1;
  const id = builtin || (item.id?.trim() && item.id !== "editor" && item.id !== "programmer" ? item.id.trim() : `custom-${customSerial}`);
  return [{
    id,
    label: item.label?.trim() || (builtin === "programmer" ? "程序员" : builtin === "editor" ? "小说编辑" : "自定义身份"),
    occupation: item.occupation?.trim() || item.label?.trim() || "",
    persona: item.persona?.trim() || "",
    builtin,
  }];
}

export class LinxueSettingTab extends PluginSettingTab {
  private draft: LinxueSettings = { ...DEFAULT_SETTINGS };
  private savedSnapshot = "";
  private root: HTMLElement | null = null;

  constructor(app: App, private host: LinxueHost & Plugin) {
    super(app, host);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "陪写设置",
        desc: "文本接口、语音接口、自动点评和 AI 人设。填写后点保存才会写入本库。",
        aliases: ["文本接口", "语音接口", "API Key", "模型", "音色", "自动点评", "人设", "职业", "Linxue"],
        render: (setting) => {
          this.root = setting.settingEl;
          this.display();
        },
      },
    ];
  }

  display(): void {
    this.draft = { ...this.host.settings, identities: this.host.settings.identities.map((item) => ({ ...item })) };
    this.savedSnapshot = JSON.stringify(this.draft);
    this.render();
  }

  private render(): void {
    const containerEl = this.root ?? this.containerEl;
    containerEl.empty();
    containerEl.createEl("p", {
      text: "点评走文本接口，朗读走语音接口。填写后点页面底部的「保存」，密钥才会写入本库。不连接本地模型。",
    });

    this.watchSetting(containerEl);
    this.nameSetting(containerEl);
    this.modeSetting(containerEl);
    this.textSettings(containerEl);
    this.speechSettings(containerEl);
    this.personaSetting(containerEl);
    this.saveBar(containerEl);
  }

  private watchSetting(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("自动点评")
      .setDesc("打开后，按设定的分钟数查看当前文稿新写的内容。不足 1 个字或符号就跳过；不足 15 个字时只关心你是不是卡文了。")
      .addToggle((toggle) => {
        toggle.setValue(this.draft.autoReview).onChange((value) => {
          this.draft.autoReview = value;
        });
      });
    this.numberField(containerEl, "自动点评间隔", "autoReviewMinutes", "单位是分钟，最少 1 分钟");
  }

  private nameSetting(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("AI身份名称")
      .setDesc("面板、状态栏、提示和语音里都用这个名字。留空时恢复为林雪。")
      .addText((text) => {
        text.setPlaceholder(DEFAULT_AI_NAME).setValue(this.draft.aiName).onChange((value) => {
          this.draft.aiName = value.trim();
        });
      });
    new Setting(containerEl)
      .setName("对你的称呼")
      .setDesc("她说话时怎么叫你。留空则用「你」。")
      .addText((text) => {
        text.setPlaceholder("你").setValue(this.draft.userAddress).onChange((value) => {
          this.draft.userAddress = value.trim();
        });
      });
  }

  private modeSetting(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("说话模式")
      .setDesc(MODE_HINT[this.draft.mode])
      .addDropdown((dropdown) => {
        for (const mode of reviewModes()) dropdown.addOption(mode, MODE_LABEL[mode]);
        dropdown.setValue(this.draft.mode).onChange((value) => {
          if (!isReviewMode(value)) return;
          this.draft.mode = value;
          this.render();
        });
      });
  }

  private textSettings(containerEl: HTMLElement): void {
    this.section(containerEl, "文本接口");
    containerEl.createEl("p", {
      text: "使用兼容 OpenAI Chat Completions 的地址，例如 https://api.openai.com/v1 ，实际请求会发到 /chat/completions。",
    });
    this.textField(containerEl, "接口根地址", "textBaseUrl");
    this.secretField(containerEl, "API Key", "textApiKey", "留空时只使用下面的额外请求头");
    this.textField(containerEl, "模型名", "textModel", "必填，例如 gpt-4o-mini 或你的网关模型名");
    this.numberField(containerEl, "温度", "textTemperature", "0 表示按模式自动：话痨 0.9，中庸 0.7，淑女安静 0.45");
    this.numberField(containerEl, "最大 tokens", "textMaxTokens", "0 表示不传这个字段，交给接口默认值");
    this.numberField(containerEl, "送审字数上限", "maxChars", "超过后只送光标附近的文字");
    this.areaField(containerEl, "额外请求头", "textExtraHeaders", "可选，JSON 对象。会覆盖同名默认头。", 4);

    new Setting(containerEl)
      .setName("测试文本接口")
      .setDesc("让陪写身份只回两个字，用来确认地址、密钥和模型。")
      .addButton((button) => {
        button.setButtonText("测试").onClick(() => {
          button.setDisabled(true);
          void this.persist()
            .then(() => this.host.testText())
            .then((reply) => {
              new Notice(`已保存。文本接口可用：${reply.slice(0, 40)}`);
              button.setDisabled(false);
            }, (error: unknown) => {
              new Notice(errorText(error));
              button.setDisabled(false);
            });
        });
      });
  }

  private speechSettings(containerEl: HTMLElement): void {
    this.section(containerEl, "语音接口");
    new Setting(containerEl)
      .setName("接口类型")
      .setDesc("兼容 OpenAI 的 /audio/speech，或自己填 URL 和请求体。")
      .addDropdown((dropdown) => {
        dropdown.addOption("openai", "OpenAI 兼容");
        dropdown.addOption("custom", "自定义 HTTP");
        dropdown.setValue(this.draft.speechProvider).onChange((value) => {
          if (!isSpeechProvider(value)) return;
          this.draft.speechProvider = value;
          this.render();
        });
      });

    const bailian = this.draft.speechProvider === "openai" && isBailianSpeechUrl(this.draft.speechBaseUrl);
    const voiceChoices = bailian
      ? voicesForModel(this.draft.speechModel).map((voice) => `${voice.name} · ${voice.id}`)
      : this.draft.speechVoiceChoices;
    this.choiceField(
      containerEl,
      "音色",
      "speechVoice",
      voiceChoices,
      bailian
        ? "百炼系统音色，名称后面是实际提交的 voice。换模型后列表会跟着换。"
        : "从检测结果里选，也可以手填。自定义请求体里用 {{voice}}",
      bailian ? (value) => value.split(" · ").pop()?.trim() || value : undefined,
    );
    this.numberField(containerEl, "每段字数", "speechChunkSize", "长点评会分段合成，播完一段再要下一段");

    if (this.draft.speechProvider === "openai") {
      this.textField(containerEl, "接口根地址", "speechBaseUrl", "实际请求会发到 /audio/speech");
      this.secretField(containerEl, "API Key", "speechApiKey", "可以和文本接口不同");
      this.choiceField(
        containerEl,
        "模型名",
        "speechModel",
        bailian ? BAILIAN_TTS_MODELS : this.draft.speechModelChoices,
        bailian
          ? "百炼朗读模型。qwen-audio-realtime 是实时对话，不能用来朗读这篇文稿。"
          : "从检测结果里选，也可以手填，例如 tts-1",
        undefined,
        () => this.render(),
      );
      new Setting(containerEl)
        .setName("音频格式")
        .addDropdown((dropdown) => {
          dropdown.addOption("mp3", "mp3");
          dropdown.addOption("wav", "wav");
          dropdown.addOption("opus", "opus");
          dropdown.setValue(this.draft.speechFormat).onChange((value) => {
            if (!isSpeechFormat(value)) return;
            this.draft.speechFormat = value;
          });
        });
      this.areaField(containerEl, "额外请求头", "speechExtraHeaders", "可选，JSON 对象。", 4);
    } else {
      this.secretField(containerEl, "API Key", "speechApiKey", "会以 Bearer 放进 Authorization，不需要就留空");
      this.choiceField(
        containerEl,
        "模型名",
        "speechModel",
        this.draft.speechModelChoices,
        "可选。从检测结果里选，或手填。请求体里用 {{model}}",
      );
      this.textField(containerEl, "请求地址", "customSpeechUrl", "完整 URL");
      this.areaField(
        containerEl,
        "请求体模板",
        "customSpeechBody",
        "占位符会替换成带引号的 JSON 字符串：{{text}} {{voice}} {{model}} {{format}}。不要再给占位符加引号。",
        8,
      );
      this.areaField(containerEl, "请求头", "customSpeechHeaders", "JSON 对象，可选。", 4);
      new Setting(containerEl)
        .setName("返回格式")
        .addDropdown((dropdown) => {
          dropdown.addOption("audio", "直接返回音频字节");
          dropdown.addOption("base64", "JSON 里的 Base64");
          dropdown.setValue(this.draft.customSpeechResponse).onChange((value) => {
            if (!isCustomResponse(value)) return;
            this.draft.customSpeechResponse = value;
            this.render();
          });
        });
      if (this.draft.customSpeechResponse === "base64") {
        this.textField(containerEl, "Base64 字段路径", "customSpeechBase64Path", "例如 audio 或 data.audio");
      }
      this.textField(containerEl, "音频 MIME", "customSpeechMime", "播放时使用，例如 audio/mpeg 或 audio/wav");
    }

    new Setting(containerEl)
      .setName("检测可用语音")
      .setDesc(this.draft.speechDetectNote || "向当前语音地址请求模型列表和音色列表，并填进上面的选项。")
      .addButton((button) => {
        button.setButtonText("检测").onClick(() => {
          button.setDisabled(true);
          void this.persist()
            .then(() => this.host.detectSpeech())
            .then((catalog) => {
              this.applyCatalog(catalog);
              this.render();
              new Notice("已保存，并更新了可用的语音模型和音色");
              button.setDisabled(false);
            }, (error: unknown) => {
              new Notice(errorText(error));
              button.setDisabled(false);
            });
        });
      });

    new Setting(containerEl)
      .setName("试听")
      .setDesc("先保存当前填写的内容，再合成并播放一句很短的自我介绍。")
      .addButton((button) => {
        button.setButtonText("播放").onClick(() => {
          button.setDisabled(true);
          void this.persist()
            .then(() => this.host.testSpeech())
            .then(() => {
              button.setDisabled(false);
            }, (error: unknown) => {
              new Notice(errorText(error));
              button.setDisabled(false);
            });
        });
      });
  }

  private applyCatalog(catalog: SpeechCatalog): void {
    this.draft.speechModelChoices = catalog.models;
    this.draft.speechVoiceChoices = catalog.voices;
    this.draft.speechDetectNote = catalog.note;
    if (catalog.models.length > 0 && !catalog.models.includes(this.draft.speechModel)) {
      this.draft.speechModel = catalog.models[0];
    }
    if (catalog.voices.length > 0 && !catalog.voices.includes(this.draft.speechVoice)) {
      this.draft.speechVoice = catalog.voices[0];
    }
  }

  private personaSetting(containerEl: HTMLElement): void {
    this.section(containerEl, "AI人设");
    const active = this.currentIdentity();
    new Setting(containerEl)
      .setName("身份")
      .setDesc("自带小说编辑和程序员。也可以新增，每份单独记名称、职业和提示词。称呼、背景和你们的故事不会跟着换。")
      .addDropdown((dropdown) => {
        for (const identity of this.draft.identities) dropdown.addOption(identity.id, identity.label);
        dropdown.setValue(active.id).onChange((value) => this.applyIdentity(value));
      })
      .addButton((button) => button.setButtonText("新增").onClick(() => this.addIdentity()));
    this.namedField(containerEl, "身份名称", active.label, "下拉框和切换提示里显示这个。", (value) => {
      active.label = value || "自定义身份";
    });
    this.namedField(containerEl, "职业", active.occupation, "会写进提示词，优先于下面原稿里的职业。", (value) => {
      active.occupation = value;
    });
    this.areaField(containerEl, "背景经历", "background", "她自己的经历。留空则只用当前身份原稿里的经历。", 5);
    this.areaField(containerEl, "两人的故事", "sharedStory", "填写后，若和身份原稿冲突，以这里为准。", 5);
    new Setting(containerEl)
      .setName("系统提示词")
      .setDesc("当前身份的工作方式。说话模式会附加在这段后面。")
      .addTextArea((area) => {
        area.setValue(this.draft.persona).onChange((value) => {
          this.draft.persona = value;
          this.storeActivePersona(value);
        });
        area.inputEl.rows = 16;
        area.inputEl.addClass("linxue-wide-input");
      });
    const restore = new Setting(containerEl)
      .setName(active.builtin ? "恢复当前身份" : "删除当前身份")
      .setDesc(active.builtin ? "只恢复这一份自带原稿，其他身份和上面的称呼、经历、故事不动。" : "删掉这份自定义身份，并回到小说编辑。");
    restore.addButton((button) => {
      button.setButtonText(active.builtin ? "恢复" : "删除").onClick(() => {
        if (active.builtin) {
          active.persona = active.builtin === "programmer" ? DEFAULT_PROGRAMMER_PERSONA : DEFAULT_PERSONA;
          active.occupation = active.builtin === "programmer" ? "程序员" : "小说编辑";
          active.label = active.occupation;
          this.draft.persona = active.persona;
        } else {
          this.draft.identities = this.draft.identities.filter((item) => item.id !== active.id);
          this.applyIdentity("editor");
          return;
        }
        this.render();
      });
    });
  }

  private currentIdentity(): IdentityProfile {
    return this.draft.identities.find((item) => item.id === this.draft.identity) ?? this.draft.identities[0];
  }

  private addIdentity(): void {
    this.storeActivePersona(this.draft.persona);
    const used = new Set(this.draft.identities.map((item) => item.id));
    let serial = this.draft.identities.length + 1;
    while (used.has(`custom-${serial}`)) serial += 1;
    const id = `custom-${serial}`;
    this.draft.identities.push({
      id,
      label: "自定义身份",
      occupation: "",
      persona: "从现在开始，按我填写的职业和关系与我相处。先理解我要做什么，再给出具体、可执行的回应。不要空泛夸奖，也不要替我决定一切。",
    });
    this.draft.identity = id;
    this.draft.persona = this.currentIdentity().persona;
    this.render();
  }

  private applyIdentity(next: string): void {
    this.storeActivePersona(this.draft.persona);
    this.draft.identity = next;
    this.draft.persona = this.currentIdentity().persona;
    this.render();
  }

  private storeActivePersona(value: string): void {
    const active = this.currentIdentity();
    active.persona = value;
    if (active.builtin === "editor") this.draft.editorPersona = value;
    if (active.builtin === "programmer") this.draft.programmerPersona = value;
  }

  private namedField(containerEl: HTMLElement, name: string, value: string, desc: string, assign: (value: string) => void): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text.setValue(value).onChange((next) => assign(next.trim()));
        text.inputEl.addClass("linxue-wide-input");
      });
  }

  private section(containerEl: HTMLElement, name: string): void {
    new Setting(containerEl).setName(name).setHeading();
  }

  private textField(
    containerEl: HTMLElement,
    name: string,
    key: TextSettingKey,
    desc = "",
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text.setValue(this.draft[key]).onChange((value) => {
          this.draft[key] = value.trim();
        });
        text.inputEl.addClass("linxue-wide-input");
      });
  }

  private choiceField(
    containerEl: HTMLElement,
    name: string,
    key: "speechModel" | "speechVoice",
    choices: string[],
    desc: string,
    storedValue: ((label: string) => string) | undefined = undefined,
    afterChange?: () => void,
  ): void {
    const setting = new Setting(containerEl).setName(name).setDesc(desc);
    const current = this.draft[key];
    const matched = choices.find((choice) => (storedValue ? storedValue(choice) : choice) === current);
    if (choices.length > 0) {
      setting.addDropdown((dropdown) => {
        const options = matched || !current ? choices : [current, ...choices];
        for (const option of options) dropdown.addOption(option, option);
        dropdown.setValue(matched || current).onChange((value) => {
          this.draft[key] = storedValue ? storedValue(value) : value;
          afterChange?.();
        });
      });
    }
    setting.addText((text) => {
      text.setPlaceholder("手填").setValue(this.draft[key]).onChange((value) => {
        this.draft[key] = value.trim();
      });
    });
  }

  private secretField(containerEl: HTMLElement, name: string, key: TextSettingKey, desc: string): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.draft[key]).onChange((value) => {
          this.draft[key] = value.trim();
        });
      });
  }

  private numberField(containerEl: HTMLElement, name: string, key: NumberSettingKey, desc: string): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(this.draft[key])).onChange((value) => {
          const parsed = Number(value);
          this.draft[key] = Number.isFinite(parsed) ? parsed : 0;
        });
      });
  }

  private areaField(
    containerEl: HTMLElement,
    name: string,
    key: TextSettingKey,
    desc: string,
    rows: number,
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addTextArea((area) => {
        area.setValue(this.draft[key]).onChange((value) => {
          this.draft[key] = value;
        });
        area.inputEl.rows = rows;
        area.inputEl.addClass("linxue-wide-input");
      });
  }

  private saveBar(containerEl: HTMLElement): void {
    const bar = containerEl.createDiv({ cls: "linxue-savebar" });
    const status = bar.createSpan({ cls: "linxue-save-status" });
    const dirty = () => JSON.stringify(this.draft) !== this.savedSnapshot;
    const paint = () => status.setText(dirty() ? "有未保存的修改" : "已保存到本库");
    paint();
    const button = bar.createEl("button", { text: "保存", cls: "mod-cta" });
    button.addEventListener("click", () => {
      void this.persist().then(() => {
        paint();
        new Notice("陪写设置已保存");
      }, (error: unknown) => new Notice(errorText(error)));
    });
    containerEl.addEventListener("input", () => paint());
    containerEl.addEventListener("change", () => paint());
  }

  private async persist(): Promise<void> {
    this.host.settings = { ...this.draft, identities: this.draft.identities.map((item) => ({ ...item })) };
    await this.host.saveSettings();
    this.savedSnapshot = JSON.stringify(this.draft);
  }
}

function isSpeechProvider(value: string): value is SpeechProvider {
  return value === "openai" || value === "custom";
}

function isSpeechFormat(value: string): value is SpeechBinaryFormat {
  return value === "mp3" || value === "wav" || value === "opus";
}

function isCustomResponse(value: string): value is CustomSpeechResponse {
  return value === "audio" || value === "base64";
}

export function settingsFromStored(value: unknown): Partial<LinxueSettings> {
  if (!isRecord(value)) return {};
  const next: Partial<LinxueSettings> = {};
  const text = (key: TextSettingKey): void => {
    const field = value[key];
    if (typeof field === "string") next[key] = field;
  };
  const number = (key: NumberSettingKey): void => {
    const field = value[key];
    if (typeof field === "number") next[key] = field;
  };
  const textKeys: TextSettingKey[] = [
    "textBaseUrl",
    "textApiKey",
    "textModel",
    "textExtraHeaders",
    "speechBaseUrl",
    "speechApiKey",
    "speechExtraHeaders",
    "customSpeechUrl",
    "customSpeechHeaders",
    "customSpeechBody",
    "customSpeechBase64Path",
    "customSpeechMime",
    "background",
    "sharedStory",
  ];
  const numberKeys: NumberSettingKey[] = ["textTemperature", "textMaxTokens", "maxChars", "speechChunkSize", "autoReviewMinutes"];
  for (const key of textKeys) text(key);
  for (const key of numberKeys) number(key);
  copyPlainString(value, next, "aiName");
  copyPlainString(value, next, "userAddress");
  copyPlainString(value, next, "identity");
  copyPlainString(value, next, "editorPersona");
  copyPlainString(value, next, "programmerPersona");
  copyPlainString(value, next, "persona");
  copyPlainString(value, next, "speechModel");
  copyPlainString(value, next, "speechVoice");
  copyPlainString(value, next, "speechDetectNote");
  const mode = value["mode"];
  if (typeof mode === "string" && isReviewMode(mode)) next.mode = mode;
  const provider = value["speechProvider"];
  if (typeof provider === "string" && isSpeechProvider(provider)) next.speechProvider = provider;
  const format = value["speechFormat"];
  if (typeof format === "string" && isSpeechFormat(format)) next.speechFormat = format;
  const response = value["customSpeechResponse"];
  if (typeof response === "string" && isCustomResponse(response)) next.customSpeechResponse = response;
  if (typeof value["autoReview"] === "boolean") next.autoReview = value["autoReview"];
  const models = stringList(value["speechModelChoices"]);
  if (models) next.speechModelChoices = models;
  const voices = stringList(value["speechVoiceChoices"]);
  if (voices) next.speechVoiceChoices = voices;
  if (Array.isArray(value["identities"])) next.identities = value["identities"].flatMap(readStoredIdentity);
  return next;
}

function copyPlainString(
  source: Record<string, unknown>,
  target: Partial<LinxueSettings>,
  key: "aiName" | "userAddress" | "identity" | "editorPersona" | "programmerPersona" | "persona" | "speechModel" | "speechVoice" | "speechDetectNote",
): void {
  const field = source[key];
  if (typeof field === "string") target[key] = field;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    items.push(item);
  }
  return items;
}

function readStoredIdentity(value: unknown): IdentityProfile[] {
  if (!isRecord(value)) return [];
  const label = value["label"];
  const persona = value["persona"];
  if (typeof label !== "string" && typeof persona !== "string") return [];
  const builtin = value["builtin"];
  const profile: IdentityProfile = {
    id: typeof value["id"] === "string" ? value["id"] : "",
    label: typeof label === "string" ? label : "",
    occupation: typeof value["occupation"] === "string" ? value["occupation"] : "",
    persona: typeof persona === "string" ? persona : "",
  };
  if (builtin === "editor" || builtin === "programmer") profile.builtin = builtin;
  return [profile];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}
