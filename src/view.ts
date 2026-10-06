import { ItemView, MarkdownRenderer, WorkspaceLeaf } from "obsidian";
import { MODE_LABEL, displayName, type ReviewMode } from "./persona";
import { historyTitle } from "./text-util";
import type { LinxueHost } from "./types";

export const VIEW_TYPE = "linxue-review-view";

export class LinxueView extends ItemView {
  private statusEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private historyEl: HTMLElement | null = null;
  private modeEl: HTMLSelectElement | null = null;

  constructor(leaf: WorkspaceLeaf, private host: LinxueHost) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return displayName(this.host.settings.aiName);
  }

  getIcon(): string {
    return "audio-lines";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("linxue-view");

    const bar = root.createDiv({ cls: "linxue-toolbar" });
    this.modeEl = bar.createEl("select");
    (Object.keys(MODE_LABEL) as ReviewMode[]).forEach((mode) => {
      const option = this.modeEl?.createEl("option", { text: MODE_LABEL[mode] });
      if (option) option.value = mode;
    });
    if (this.modeEl) {
      this.modeEl.value = this.host.settings.mode;
      this.modeEl.addEventListener("change", () => {
        this.host.settings.mode = (this.modeEl?.value || "balanced") as ReviewMode;
        void this.host.saveSettings();
      });
    }

    const review = bar.createEl("button", { text: "点评全文", cls: "mod-cta" });
    review.addEventListener("click", () => void this.host.review("document"));
    const selection = bar.createEl("button", { text: "点评选区" });
    selection.addEventListener("click", () => void this.host.review("selection"));
    const polish = bar.createEl("button", { text: "润色选区" });
    polish.addEventListener("click", () => void this.host.polishSelection());
    const writing = bar.createEl("button", { text: "替我续写" });
    writing.addEventListener("click", () => void this.host.continueWriting());
    const stop = bar.createEl("button", { text: "停止" });
    stop.addEventListener("click", () => this.host.stopSpeaking());

    this.statusEl = root.createDiv({ cls: "linxue-status", text: `${displayName(this.host.settings.aiName)}还没开口。` });
    this.bodyEl = root.createDiv({ cls: "linxue-body" });
    const history = root.createDiv({ cls: "linxue-history" });
    const heading = history.createDiv({ cls: "linxue-history-head" });
    heading.createEl("h3", { text: "点评历史" });
    const clear = heading.createEl("button", { text: "清空" });
    clear.addEventListener("click", () => void this.host.clearHistory());
    this.historyEl = history.createDiv({ cls: "linxue-history-list" });
    this.renderHistory();
  }

  setStatus(text: string): void {
    if (this.statusEl) this.statusEl.setText(text);
  }

  setMode(mode: ReviewMode): void {
    if (this.modeEl) this.modeEl.value = mode;
  }

  refreshName(): void {
    const name = displayName(this.host.settings.aiName);
    const idle = this.statusEl?.getText() ?? "";
    if (idle.endsWith("还没开口。")) this.setStatus(`${name}还没开口。`);
  }

  renderHistory(): void {
    if (!this.historyEl) return;
    this.historyEl.empty();
    const records = this.host.listHistory();
    if (records.length === 0) {
      this.historyEl.createDiv({ cls: "linxue-history-empty", text: "还没有点评记录。" });
      return;
    }
    for (const record of records) {
      const row = this.historyEl.createDiv({ cls: "linxue-history-row" });
      const open = row.createEl("button", { cls: "linxue-history-open", text: historyTitle(record) });
      open.title = record.excerpt ? `当时的文字：${record.excerpt}` : record.path;
      open.addEventListener("click", () => void this.host.openHistory(record.id));
      const remove = row.createEl("button", { cls: "linxue-history-delete", text: "删除" });
      remove.addEventListener("click", () => void this.host.deleteHistory(record.id));
    }
  }

  async setTranscript(markdown: string): Promise<void> {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    if (!markdown.trim()) return;
    await MarkdownRenderer.render(this.app, markdown, this.bodyEl, "", this);
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}
