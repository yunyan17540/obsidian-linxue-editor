import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { BAILIAN_TTS_MODELS, isBailianSpeechUrl, voicesForModel } from "./bailian";
import { DEFAULT_AI_NAME, DEFAULT_PERSONA, DEFAULT_PROGRAMMER_PERSONA, IDENTITY_LABEL, MODE_HINT, MODE_LABEL, type IdentityId, type ReviewMode } from "./persona";
import type { LinxueHost, LinxueSettings, SpeechCatalog } from "./types";

export const DEFAULT_SETTINGS: LinxueSettings = {
  aiName: DEFAULT_AI_NAME,
  userAddress: "",
  background: "",
  sharedStory: "",
  identity: "editor",
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

export function normalizeIdentity(settings: LinxueSettings): void {
  if (settings.identity !== "editor" && settings.identity !== "programmer") settings.identity = "editor";
  if (!settings.aiName?.trim()) settings.aiName = DEFAULT_AI_NAME;
  if (!settings.editorPersona?.trim()) settings.editorPersona = settings.persona?.trim() || DEFAULT_PERSONA;
  if (!settings.programmerPersona?.trim()) settings.programmerPersona = DEFAULT_PROGRAMMER_PERSONA;
  const active = settings.identity === "programmer" ? settings.programmerPersona : settings.editorPersona;
  settings.persona = active.trim() ? active : settings.identity === "programmer" ? DEFAULT_PROGRAMMER_PERSONA : DEFAULT_PERSONA;
}

export class LinxueSettingTab extends PluginSettingTab {
  private draft: LinxueSettings = { ...DEFAULT_SETTINGS };
  private savedSnapshot = "";

  constructor(app: App, private host: LinxueHost) {
    super(app, host as unknown as Plugin);
  }

  display(): void {
    this.draft = { ...this.host.settings };
    this.savedSnapshot = JSON.stringify(this.draft);
    this.render();
  }

  private render(): void {
    const { containerEl } = this;
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
        (Object.keys(MODE_LABEL) as ReviewMode[]).forEach((mode) => {
          dropdown.addOption(mode, MODE_LABEL[mode]);
        });
        dropdown.setValue(this.draft.mode).onChange((value) => {
          this.draft.mode = value as ReviewMode;
          this.render();
        });
      });
  }

  private textSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "文本接口" });
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
        button.setButtonText("测试").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.persist();
            const reply = await this.host.testText();
            new Notice(`已保存。文本接口可用：${reply.slice(0, 40)}`);
          } catch (error) {
            new Notice(errorText(error));
          } finally {
            button.setDisabled(false);
          }
        });
      });
  }

  private speechSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "语音接口" });
    new Setting(containerEl)
      .setName("接口类型")
      .setDesc("兼容 OpenAI 的 /audio/speech，或自己填 URL 和请求体。")
      .addDropdown((dropdown) => {
        dropdown.addOption("openai", "OpenAI 兼容");
        dropdown.addOption("custom", "自定义 HTTP");
        dropdown.setValue(this.draft.speechProvider).onChange((value) => {
          this.draft.speechProvider = value as LinxueSettings["speechProvider"];
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
            this.draft.speechFormat = value as LinxueSettings["speechFormat"];
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
            this.draft.customSpeechResponse = value as LinxueSettings["customSpeechResponse"];
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
        button.setButtonText("检测").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.persist();
            const catalog = await this.host.detectSpeech();
            this.applyCatalog(catalog);
            this.render();
            new Notice("已保存，并更新了可用的语音模型和音色");
          } catch (error) {
            new Notice(errorText(error));
          } finally {
            button.setDisabled(false);
          }
        });
      });

    new Setting(containerEl)
      .setName("试听")
      .setDesc("先保存当前填写的内容，再合成并播放一句很短的自我介绍。")
      .addButton((button) => {
        button.setButtonText("播放").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.persist();
            await this.host.testSpeech();
          } catch (error) {
            new Notice(errorText(error));
          } finally {
            button.setDisabled(false);
          }
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
    containerEl.createEl("h3", { text: "AI人设" });
    new Setting(containerEl)
      .setName("身份")
      .setDesc("在小说编辑和程序员之间切换。两边各自记住修改，称呼、背景和你们的故事不会被换掉。")
      .addDropdown((dropdown) => {
        (Object.keys(IDENTITY_LABEL) as IdentityId[]).forEach((identity) => {
          dropdown.addOption(identity, IDENTITY_LABEL[identity]);
        });
        dropdown.setValue(this.draft.identity).onChange((value) => {
          this.applyIdentity(value as IdentityId);
        });
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
    new Setting(containerEl)
      .setName("恢复当前身份")
      .setDesc("只恢复正在使用的这一份原稿，另一份身份和上面的称呼、经历、故事不动。")
      .addButton((button) => {
        button.setButtonText("恢复").onClick(() => {
          const source = this.draft.identity === "programmer" ? DEFAULT_PROGRAMMER_PERSONA : DEFAULT_PERSONA;
          this.draft.persona = source;
          this.storeActivePersona(source);
          this.render();
        });
      });
  }

  private applyIdentity(next: IdentityId): void {
    this.storeActivePersona(this.draft.persona);
    this.draft.identity = next;
    const stored = next === "programmer" ? this.draft.programmerPersona : this.draft.editorPersona;
    const fallback = next === "programmer" ? DEFAULT_PROGRAMMER_PERSONA : DEFAULT_PERSONA;
    this.draft.persona = stored.trim() ? stored : fallback;
    this.storeActivePersona(this.draft.persona);
    this.render();
  }

  private storeActivePersona(value: string): void {
    if (this.draft.identity === "programmer") this.draft.programmerPersona = value;
    else this.draft.editorPersona = value;
  }

  private textField(
    containerEl: HTMLElement,
    name: string,
    key: keyof LinxueSettings,
    desc = "",
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text.setValue(String(this.draft[key] ?? "")).onChange((value) => {
          this.assign(key, value.trim());
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
        options.forEach((option) => dropdown.addOption(option, option));
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

  private secretField(containerEl: HTMLElement, name: string, key: keyof LinxueSettings, desc: string): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(String(this.draft[key] ?? "")).onChange((value) => {
          this.assign(key, value.trim());
        });
      });
  }

  private numberField(containerEl: HTMLElement, name: string, key: keyof LinxueSettings, desc: string): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(this.draft[key] ?? 0)).onChange((value) => {
          const parsed = Number(value);
          this.assign(key, Number.isFinite(parsed) ? parsed : 0);
        });
      });
  }

  private areaField(
    containerEl: HTMLElement,
    name: string,
    key: keyof LinxueSettings,
    desc: string,
    rows: number,
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addTextArea((area) => {
        area.setValue(String(this.draft[key] ?? "")).onChange((value) => {
          this.assign(key, value);
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
      this.persist().then(() => {
        paint();
        new Notice("陪写设置已保存");
      }, (error: unknown) => new Notice(errorText(error)));
    });
    containerEl.addEventListener("input", () => paint());
    containerEl.addEventListener("change", () => paint());
  }

  private async persist(): Promise<void> {
    this.host.settings = { ...this.draft };
    await this.host.saveSettings();
    this.savedSnapshot = JSON.stringify(this.draft);
  }

  private assign(key: keyof LinxueSettings, value: string | number): void {
    (this.draft as unknown as Record<string, string | number>)[key] = value;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}
