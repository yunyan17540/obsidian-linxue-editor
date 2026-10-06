import { MarkdownView, Notice, Plugin, WorkspaceLeaf, normalizePath } from "obsidian";
import { detectSpeechCatalog, pingText, requestConcern, requestContinue, requestPolish, requestReview, requestSpeech } from "./api";
import { MODE_LABEL, displayName } from "./persona";
import { DEFAULT_SETTINGS, LinxueSettingTab } from "./settings";
import { Speaker } from "./speaker";
import { addedSpans, addRecord, buildReviewDocument, chunkForSpeech, createRecord, meaningfulLength, parseHistory, toSpeechText, type ReviewRecord } from "./text-util";
import type { LinxueSettings, ReviewScope, SpeechCatalog } from "./types";
import { LinxueView, VIEW_TYPE } from "./view";

function needsBreak(text: string, offset: number): boolean {
  const previous = text[offset - 1] ?? "";
  return previous !== "" && !/[\n\s]/.test(previous);
}

export default class LinxuePlugin extends Plugin {
  settings: LinxueSettings = { ...DEFAULT_SETTINGS };
  private speaker = new Speaker();
  private job = 0;
  private reviewing = false;
  private remembered: MarkdownView | null = null;
  private statusBar: HTMLElement | null = null;
  private ribbon: HTMLElement | null = null;
  private records: ReviewRecord[] = [];
  private watched = new Map<string, { text: string; at: number }>();
  private autoTimer = 0;

  private get who(): string {
    return displayName(this.settings.aiName);
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new LinxueView(leaf, this));
    this.addSettingTab(new LinxueSettingTab(this.app, this));
    this.ribbon = this.addRibbonIcon("audio-lines", `${this.who}点评当前文稿`, () => void this.review("document"));

    this.addCommand({
      id: "review-document",
      name: "点评当前文稿并朗读",
      callback: () => void this.review("document"),
    });
    this.addCommand({
      id: "review-selection",
      name: "点评选中文字并朗读",
      callback: () => void this.review("selection"),
    });
    this.addCommand({
      id: "polish-selection",
      name: "请求润色选中文字",
      callback: () => void this.polishSelection(),
    });
    this.addCommand({
      id: "continue-writing",
      name: "请求替我续写",
      callback: () => void this.continueWriting(),
    });
    this.addCommand({
      id: "stop-speech",
      name: "停止朗读",
      callback: () => this.stopSpeaking(),
    });
    this.addCommand({
      id: "cycle-mode",
      name: "切换说话模式",
      callback: () => void this.cycleMode(),
    });
    this.addCommand({
      id: "reload-plugin",
      name: "重新加载陪写插件",
      callback: () => void this.reloadSelf(),
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        if (!editor.getSelection()) return;
        menu.addItem((item) => {
          item.setTitle(`让${this.who}听听这段`).setIcon("audio-lines").onClick(() => void this.review("selection"));
        });
        menu.addItem((item) => {
          item.setTitle(`向${this.who}请求帮忙润色`).setIcon("pencil").onClick(() => void this.polishSelection());
        });
        menu.addItem((item) => {
          item.setTitle(`让${this.who}替我续写`).setIcon("pen-line").onClick(() => void this.continueWriting());
        });
      }),
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const view = leaf?.view;
        if (view instanceof MarkdownView && view.file) this.remembered = view;
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view?.file) this.remembered = view;
    });

    this.statusBar = this.addStatusBarItem();
    this.statusBar.setText(`${this.who} · ${MODE_LABEL[this.settings.mode]}`);
    this.statusBar.addEventListener("click", () => void this.activateView());
    this.autoTimer = window.setInterval(() => void this.autoReview(), 30_000);
    this.register(() => window.clearInterval(this.autoTimer));

    if (!this.settings.textApiKey.trim()) {
      this.app.workspace.onLayoutReady(() => this.openSettings());
    }
  }

  openSettings(): void {
    const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  onunload(): void {
    this.speaker.stop();
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<LinxueSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
    if (!this.settings.persona?.trim()) this.settings.persona = DEFAULT_SETTINGS.persona;
    if (!this.settings.aiName?.trim()) this.settings.aiName = DEFAULT_SETTINGS.aiName;
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(this.historyPath())) {
      this.records = parseHistory(await adapter.read(this.historyPath()));
    }
  }

  listHistory(): ReviewRecord[] {
    return this.records;
  }

  async openHistory(id: string): Promise<void> {
    const record = this.records.find((item) => item.id === id);
    if (!record) return;
    await this.activateView();
    const panel = this.view();
    panel?.setStatus(`${record.aiName || this.who} · ${record.title}`);
    await panel?.setTranscript(record.reply);
  }

  async deleteHistory(id: string): Promise<void> {
    this.records = this.records.filter((item) => item.id !== id);
    await this.writeHistory();
    this.view()?.renderHistory();
  }

  async clearHistory(): Promise<void> {
    this.records = [];
    await this.writeHistory();
    this.view()?.renderHistory();
    new Notice("点评历史已清空");
  }

  private historyPath(): string {
    const dir = this.manifest.dir || `.obsidian/plugins/${this.manifest.id}`;
    return normalizePath(`${dir}/history.json`);
  }

  private async rememberReview(record: ReviewRecord): Promise<void> {
    this.records = addRecord(this.records, record);
    await this.writeHistory();
    this.view()?.renderHistory();
  }

  private async writeHistory(): Promise<void> {
    await this.app.vault.adapter.write(this.historyPath(), JSON.stringify({ records: this.records }, null, 2));
  }

  async saveSettings(): Promise<void> {
    if (!this.settings.aiName.trim()) this.settings.aiName = DEFAULT_SETTINGS.aiName;
    await this.saveData(this.settings);
    this.applyName();
  }

  private applyName(): void {
    if (this.statusBar) this.statusBar.setText(`${this.who} · ${MODE_LABEL[this.settings.mode]}`);
    if (this.ribbon) this.ribbon.setAttribute("aria-label", `${this.who}点评当前文稿`);
    const panel = this.view();
    panel?.setMode(this.settings.mode);
    panel?.refreshName();
    if (panel && panel.getDisplayText() !== this.who) void this.reopenPanel();
  }

  private async reopenPanel(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) leaf.detach();
    await this.activateView();
  }

  stopSpeaking(): void {
    if (!this.reviewing) {
      this.speaker.stop();
      this.view()?.setStatus("朗读已停。");
      return;
    }
    this.job += 1;
    this.reviewing = false;
    this.speaker.stop();
    this.view()?.setStatus("点评已停止。");
    new Notice("点评已停止");
  }

  async testText(): Promise<string> {
    return pingText(this.settings);
  }

  async detectSpeech(): Promise<SpeechCatalog> {
    return detectSpeechCatalog(this.settings);
  }

  async testSpeech(): Promise<void> {
    this.speaker.stop();
    const generation = this.speaker.currentGeneration;
    const panel = this.view();
    const clip = await requestSpeech(this.settings, `我是${this.who}。接口是通的。`);
    await this.speaker.play(clip.data, clip.mime, generation);
    panel?.setStatus("语音试听结束。");
  }

  async review(scope: ReviewScope): Promise<void> {
    if (this.reviewing) {
      new Notice("点评或润色正在进行，请稍等，或点「停止」");
      return;
    }
    const view = this.sourceView();
    if (!view?.file) {
      new Notice("先打开一篇正在写的文稿");
      return;
    }
    const editor = view.editor;
    if (!editor) {
      new Notice("请切换到编辑或实时预览后再点评");
      return;
    }
    const selection = editor.getSelection();
    if (scope === "selection" && !selection.trim()) {
      new Notice("还没有选中文字");
      return;
    }
    const cursor = editor.posToOffset(editor.getCursor());
    const doc = buildReviewDocument({
      title: view.file.basename,
      path: view.file.path,
      scope,
      fullText: editor.getValue(),
      selection,
      cursor,
      maxChars: this.settings.maxChars,
    });
    if (!doc.text) {
      new Notice("这篇还是空的");
      return;
    }

    const id = ++this.job;
    this.reviewing = true;
    this.speaker.stop();
    const generation = this.speaker.currentGeneration;
    new Notice(`正在点评《${doc.title}》`);
    await this.activateView();
    const panel = this.view();
    panel?.setStatus(`正在点评《${doc.title}》，请稍等`);
    panel?.setTranscript("");

    try {
      const reply = await requestReview(this.settings, doc);
      if (id !== this.job) return;

      await this.rememberReview(createRecord({
        title: doc.title,
        path: doc.path,
        scope: doc.scope,
        mode: this.settings.mode,
        aiName: this.who,
        source: doc.text,
        reply,
      }));
      await panel?.setTranscript(reply);
      const spoken = toSpeechText(reply);
      const chunks = chunkForSpeech(spoken, this.settings.speechChunkSize);
      panel?.setStatus(`${this.who}开始说，共 ${chunks.length} 段。`);

      let upcoming = requestSpeech(this.settings, chunks[0]);
      for (let index = 0; index < chunks.length; index++) {
        const clip = await upcoming;
        if (id !== this.job) return;
        if (index + 1 < chunks.length) upcoming = requestSpeech(this.settings, chunks[index + 1]);
        panel?.setStatus(`${this.who}在说第 ${index + 1} / ${chunks.length} 段`);
        await this.speaker.play(clip.data, clip.mime, generation);
        if (id !== this.job) return;
      }
      panel?.setStatus(`${this.who}说完了。文字稿留在上面。`);
    } catch (error) {
      if (id !== this.job) return;
      const message = error instanceof Error ? error.message : "点评失败";
      const hasTranscript = Boolean(panel?.contentEl.querySelector(".linxue-body")?.textContent?.trim());
      panel?.setStatus(hasTranscript ? `文字稿已写下。朗读中断：${message}` : message);
      new Notice(message);
    } finally {
      if (id === this.job) this.reviewing = false;
    }
  }

  async polishSelection(): Promise<void> {
    if (this.reviewing) {
      new Notice("点评或润色正在进行，请稍等，或点「停止」");
      return;
    }
    const view = this.sourceView();
    const editor = view?.editor;
    const file = view?.file;
    if (!file || !editor) {
      new Notice("请在编辑或实时预览里选中要润色的文字");
      return;
    }
    const selection = editor.getSelection();
    if (!selection.trim()) {
      new Notice("还没有选中文字");
      return;
    }
    if (selection.length > this.settings.maxChars) {
      new Notice("选区超过送审字数上限，请缩短后再润色");
      return;
    }
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const fullText = editor.getValue();
    const start = editor.posToOffset(from);
    const end = editor.posToOffset(to);
    const id = ++this.job;
    this.reviewing = true;
    new Notice(`${this.who}正在润色选中的文字`);
    await this.activateView();
    const panel = this.view();
    panel?.setStatus(`${this.who}正在润色《${file.basename}》的选区`);
    try {
      const polished = await requestPolish(this.settings, {
        title: file.basename,
        before: fullText.slice(Math.max(0, start - 240), start),
        selection,
        after: fullText.slice(end, end + 240),
      });
      if (id !== this.job) return;
      if (editor.getRange(from, to) !== selection) {
        new Notice("选区在润色期间变了，没有替换");
        panel?.setStatus("润色结果已拿到，但原文变了，没有写入。");
        await panel?.setTranscript(polished);
        return;
      }
      editor.replaceRange(polished, from, to);
      panel?.setStatus(`${this.who}已替换选区。可用 Ctrl+Z 撤回。`);
      await panel?.setTranscript(`原文：\n\n${selection}\n\n润色：\n\n${polished}`);
      await this.rememberReview(createRecord({
        title: file.basename,
        path: file.path,
        scope: "selection",
        mode: this.settings.mode,
        aiName: this.who,
        source: selection,
        reply: `原文：\n\n${selection}\n\n润色：\n\n${polished}`,
      }));
    } catch (error) {
      if (id !== this.job) return;
      const message = error instanceof Error ? error.message : "润色失败";
      panel?.setStatus(message);
      new Notice(message);
    } finally {
      if (id === this.job) this.reviewing = false;
    }
  }

  async continueWriting(): Promise<void> {
    if (this.reviewing) {
      new Notice("点评或续写正在进行，请稍等，或点「停止」");
      return;
    }
    const view = this.sourceView();
    const editor = view?.editor;
    const file = view?.file;
    if (!file || !editor) {
      new Notice("请先打开一篇文稿");
      return;
    }
    const selection = editor.getSelection();
    const cursor = editor.getCursor("to");
    const offset = editor.posToOffset(cursor);
    const fullText = editor.getValue();
    const anchor = (selection || fullText.slice(Math.max(0, offset - 240), offset)).trim();
    if (!anchor) {
      new Notice("先写一点，或者选中要接着往下写的位置");
      return;
    }
    const id = ++this.job;
    this.reviewing = true;
    new Notice(`${this.who}正在往下写`);
    await this.activateView();
    const panel = this.view();
    panel?.setStatus(`${this.who}正在替你续写《${file.basename}》`);
    try {
      const written = await requestContinue(this.settings, {
        title: file.basename,
        before: fullText.slice(Math.max(0, offset - 700), offset),
        anchor,
      });
      if (id !== this.job) return;
      const prefix = needsBreak(fullText, offset) ? "\n" : "";
      editor.replaceRange(`${prefix}${written}`, cursor, cursor);
      panel?.setStatus(`${this.who}已接在光标后面。可用 Ctrl+Z 撤回。`);
      await panel?.setTranscript(written);
      await this.rememberReview(createRecord({
        title: file.basename,
        path: file.path,
        scope: "selection",
        mode: this.settings.mode,
        aiName: this.who,
        source: anchor,
        reply: `续写：\n\n${written}`,
      }));
    } catch (error) {
      if (id !== this.job) return;
      const message = error instanceof Error ? error.message : "续写失败";
      panel?.setStatus(message);
      new Notice(message);
    } finally {
      if (id === this.job) this.reviewing = false;
    }
  }

  private async autoReview(): Promise<void> {
    if (!this.settings.autoReview || this.reviewing) return;
    const view = this.sourceView();
    const file = view?.file;
    const editor = view?.editor;
    if (!file || !editor) return;
    const text = editor.getValue();
    const now = Date.now();
    const previous = this.watched.get(file.path);
    const minutes = Math.max(1, this.settings.autoReviewMinutes || 15);
    if (!previous) {
      this.watched.set(file.path, { text, at: now });
      return;
    }
    if (now - previous.at < minutes * 60_000) return;
    const added = addedSpans(previous.text, text).map((span) => span.text).join("");
    this.watched.set(file.path, { text, at: now });
    if (meaningfulLength(added) < 1) return;
    if (meaningfulLength(added) < 15) {
      await this.speakConcern(file.basename, file.path, added);
      return;
    }
    const cursor = editor.posToOffset(editor.getCursor());
    const doc = buildReviewDocument({
      title: file.basename,
      path: file.path,
      scope: "document",
      fullText: added,
      selection: "",
      cursor: Math.min(cursor, added.length),
      maxChars: this.settings.maxChars,
    });
    doc.omittedNote = `这是最近 ${minutes} 分钟里新写的内容，不是整篇。`;
    await this.reviewPrepared(doc);
  }

  private async speakConcern(title: string, path: string, added: string): Promise<void> {
    const id = ++this.job;
    this.reviewing = true;
    await this.activateView();
    const panel = this.view();
    panel?.setStatus(`${this.who}看你这一阵写得很少`);
    try {
      const reply = await requestConcern(this.settings, { title, added });
      if (id !== this.job) return;
      await panel?.setTranscript(reply);
      await this.rememberReview(createRecord({
        title,
        path,
        scope: "document",
        mode: this.settings.mode,
        aiName: this.who,
        source: added,
        reply,
      }));
      const generation = this.speaker.currentGeneration;
      const clip = await requestSpeech(this.settings, toSpeechText(reply));
      if (id !== this.job) return;
      await this.speaker.play(clip.data, clip.mime, generation);
      panel?.setStatus(`${this.who}问完了。`);
    } catch (error) {
      if (id !== this.job) return;
      const message = error instanceof Error ? error.message : "关心没能说出来";
      panel?.setStatus(message);
    } finally {
      if (id === this.job) this.reviewing = false;
    }
  }

  private async reviewPrepared(doc: ReturnType<typeof buildReviewDocument>): Promise<void> {
    const id = ++this.job;
    this.reviewing = true;
    this.speaker.stop();
    const generation = this.speaker.currentGeneration;
    await this.activateView();
    const panel = this.view();
    panel?.setStatus(`正在看最近新写的《${doc.title}》`);
    panel?.setTranscript("");
    try {
      const reply = await requestReview(this.settings, doc);
      if (id !== this.job) return;
      await this.rememberReview(createRecord({
        title: doc.title,
        path: doc.path,
        scope: doc.scope,
        mode: this.settings.mode,
        aiName: this.who,
        source: doc.text,
        reply,
      }));
      await panel?.setTranscript(reply);
      const chunks = chunkForSpeech(toSpeechText(reply), this.settings.speechChunkSize);
      let upcoming = requestSpeech(this.settings, chunks[0]);
      for (let index = 0; index < chunks.length; index++) {
        const clip = await upcoming;
        if (id !== this.job) return;
        if (index + 1 < chunks.length) upcoming = requestSpeech(this.settings, chunks[index + 1]);
        await this.speaker.play(clip.data, clip.mime, generation);
      }
      panel?.setStatus(`${this.who}看完这一阵新写的内容了。`);
    } catch (error) {
      if (id !== this.job) return;
      panel?.setStatus(error instanceof Error ? error.message : "自动点评失败");
    } finally {
      if (id === this.job) this.reviewing = false;
    }
  }

  private sourceView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file) {
      this.remembered = active;
      return active;
    }
    if (this.remembered?.file) return this.remembered;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file) {
        this.remembered = view;
        return view;
      }
    }
    return null;
  }

  private async reloadSelf(): Promise<void> {
    const plugins = (this.app as unknown as {
      plugins: { disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<void> };
    }).plugins;
    await plugins.disablePlugin(this.manifest.id);
    await plugins.enablePlugin(this.manifest.id);
    new Notice("陪写插件已重新加载");
  }

  private async cycleMode(): Promise<void> {
    const order = ["chatty", "quiet", "balanced"] as const;
    const next = order[(order.indexOf(this.settings.mode) + 1) % order.length];
    this.settings.mode = next;
    await this.saveSettings();
    new Notice(`${this.who}切换到${MODE_LABEL[next]}`);
  }

  private view(): LinxueView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const view = leaves[0]?.view;
    return view instanceof LinxueView ? view : null;
  }

  private async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("split");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf as WorkspaceLeaf);
  }
}
