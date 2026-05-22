import { ItemView, MarkdownRenderer, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import { AgentToolExecutor, PendingEdit, SearchResult, WorkingSetItem } from "../core/types";
import { DeepSeekClient } from "../services/deepseekClient";
import { GraphSearchEngine } from "../search/graphSearch";

export const CHAT_VIEW_TYPE = "deepseek-rag-chat-view";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

export class ChatView extends ItemView {
  private messages: ChatMessage[] = [];
  private includeContext: boolean;
  private agentMode: boolean;
  private lastSources: SearchResult[] = [];
  private pendingEdits: PendingEdit[] = [];
  private workingSet: WorkingSetItem[] = [];
  private isSending = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly searchEngine: GraphSearchEngine,
    private readonly deepSeekClient: DeepSeekClient,
    private readonly agentTools: AgentToolExecutor,
    private readonly getTopK: () => number,
    includeContextByDefault: boolean,
    agentModeByDefault: boolean,
  ) {
    super(leaf);
    this.includeContext = includeContextByDefault;
    this.agentMode = agentModeByDefault;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "DeepSeek RAG";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("deepseek-rag-view");
    this.render();
  }

  startAgentTask(content: string): void {
    if (this.isSending) {
      new Notice("DeepSeek RAG is already working.", 3000);
      return;
    }

    this.agentMode = true;
    void this.sendMessage(content);
  }

  private render(): void {
    this.containerEl.empty();

    const toolbar = this.containerEl.createDiv({ cls: "deepseek-rag-toolbar" });
    const contextLabel = toolbar.createEl("label");
    const contextToggle = contextLabel.createEl("input", { type: "checkbox" });
    contextToggle.checked = this.includeContext;
    contextLabel.appendText(" Use note context");
    this.registerDomEvent(contextToggle, "change", () => {
      this.includeContext = contextToggle.checked;
    });

    const agentLabel = toolbar.createEl("label");
    const agentToggle = agentLabel.createEl("input", { type: "checkbox" });
    agentToggle.checked = this.agentMode;
    agentLabel.appendText(" Agent");
    this.registerDomEvent(agentToggle, "change", () => {
      this.agentMode = agentToggle.checked;
    });

    const clearButton = toolbar.createEl("button", { attr: { "aria-label": "Clear chat" } });
    setIcon(clearButton, "trash-2");
    this.registerDomEvent(clearButton, "click", () => {
      this.messages = [];
      this.lastSources = [];
      this.pendingEdits = [];
      this.workingSet = [];
      this.render();
    });

    const messagesEl = this.containerEl.createDiv({ cls: "deepseek-rag-messages" });
    if (this.messages.length === 0) {
      messagesEl.createEl("div", {
        cls: "setting-item-description",
        text: "Ask a question about your notes.",
      });
    }

    for (const message of this.messages) {
      void this.renderMessage(messagesEl, message);
    }

    if (this.pendingEdits.length > 0) {
      this.renderPendingEdits();
    }

    if (this.workingSet.length > 0) {
      this.renderWorkingSet();
    }

    if (this.lastSources.length > 0) {
      this.renderSources();
    }

    this.renderInput();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  private async renderMessage(parent: HTMLElement, message: ChatMessage): Promise<void> {
    const cls = [
      "deepseek-rag-message",
      message.role === "user" ? "deepseek-rag-message-user" : "deepseek-rag-message-assistant",
      message.error ? "deepseek-rag-message-error" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const messageEl = parent.createDiv({ cls });

    if (message.role === "assistant" && !message.error) {
      await MarkdownRenderer.render(this.app, message.content, messageEl, "", this);
    } else {
      messageEl.setText(message.content);
    }
  }

  private renderSources(): void {
    const sourcesEl = this.containerEl.createDiv({ cls: "deepseek-rag-sources" });
    sourcesEl.createEl("div", { cls: "setting-item-name", text: "Sources" });

    for (const result of this.lastSources) {
      const sourceEl = sourcesEl.createDiv({ cls: "deepseek-rag-source" });
      const title = sourceEl.createDiv({ cls: "deepseek-rag-source-title" });
      title.setText(result.chunk.filePath);
      sourceEl.createDiv({
        cls: "deepseek-rag-source-snippet",
        text: result.chunk.content.slice(0, 280),
      });
    }
  }

  private renderPendingEdits(): void {
    const editsEl = this.containerEl.createDiv({ cls: "deepseek-rag-edits" });
    editsEl.createEl("div", { cls: "setting-item-name", text: "Pending edits" });

    for (const edit of this.pendingEdits) {
      const editEl = editsEl.createDiv({ cls: "deepseek-rag-edit" });
      const header = editEl.createDiv({ cls: "deepseek-rag-edit-header" });
      header.createDiv({ cls: "deepseek-rag-edit-title", text: edit.path });
      header.createDiv({ cls: "deepseek-rag-edit-summary", text: `${edit.kind === "patch" ? "Patch" : "Full edit"}: ${edit.summary}` });

      const diffEl = editEl.createDiv({ cls: "deepseek-rag-diff" });
      const diff = buildEditDiff(edit);
      for (const line of diff.slice(0, 240)) {
        diffEl.createDiv({
          cls: `deepseek-rag-diff-line deepseek-rag-diff-${line.type}`,
          text: `${line.prefix} ${line.text}`,
        });
      }

      if (diff.length > 240) {
        diffEl.createDiv({ cls: "deepseek-rag-diff-line", text: `[${diff.length - 240} more diff lines hidden]` });
      }

      const actions = editEl.createDiv({ cls: "deepseek-rag-edit-actions" });
      const applyButton = actions.createEl("button", { cls: "mod-cta", text: "Apply" });
      const rejectButton = actions.createEl("button", { text: "Reject" });

      this.registerDomEvent(applyButton, "click", () => {
        void this.applyPendingEdit(edit);
      });
      this.registerDomEvent(rejectButton, "click", () => {
        this.pendingEdits = this.pendingEdits.filter((pending) => pending.id !== edit.id);
        this.render();
      });
    }
  }

  private renderWorkingSet(): void {
    const workingSetEl = this.containerEl.createDiv({ cls: "deepseek-rag-working-set" });
    workingSetEl.createEl("div", { cls: "setting-item-name", text: "Working set" });

    for (const item of this.workingSet.slice(0, 80)) {
      const itemEl = workingSetEl.createDiv({ cls: "deepseek-rag-working-set-item" });
      itemEl.createSpan({ cls: `deepseek-rag-working-set-role deepseek-rag-working-set-${item.role}`, text: item.role });
      itemEl.createSpan({ cls: "deepseek-rag-working-set-path", text: item.path });
      itemEl.createSpan({ cls: "deepseek-rag-working-set-detail", text: item.detail });
    }

    if (this.workingSet.length > 80) {
      workingSetEl.createDiv({ cls: "setting-item-description", text: `${this.workingSet.length - 80} more items hidden.` });
    }
  }


  private renderInput(): void {
    const inputRow = this.containerEl.createDiv({ cls: "deepseek-rag-input-row" });
    const textarea = inputRow.createEl("textarea", {
      cls: "deepseek-rag-input",
      attr: {
        placeholder: "Message DeepSeek...",
      },
    });
    const sendButton = inputRow.createEl("button", { cls: "mod-cta", attr: { "aria-label": "Send" } });
    setIcon(sendButton, "send");
    sendButton.disabled = this.isSending;

    const send = () => {
      const value = textarea.value.trim();
      if (!value || this.isSending) {
        return;
      }
      void this.sendMessage(value);
    };

    this.registerDomEvent(sendButton, "click", send);
    this.registerDomEvent(textarea, "keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });
  }

  private async sendMessage(content: string): Promise<void> {
    const history = this.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    this.messages.push({ role: "user", content });
    this.isSending = true;
    this.render();

    try {
      let answer: string;
      if (this.agentMode) {
        const result = await this.deepSeekClient.completeWithAgent(content, history, this.agentTools);
        this.lastSources = result.sources;
        this.pendingEdits = this.pendingEdits.concat(result.pendingEdits);
        this.workingSet = mergeWorkingSet(
          this.workingSet,
          result.workingSet,
          result.pendingEdits.map((edit) => ({ path: edit.path, role: "edited", detail: edit.summary })),
        );
        answer = result.answer;
      } else {
        this.lastSources = this.includeContext ? this.searchEngine.search(content, this.getTopK()) : [];
        this.workingSet = mergeWorkingSet(
          this.workingSet,
          unique(this.lastSources.map((source) => source.chunk.filePath)).map((path) => ({
            path,
            role: "searched",
            detail: `Context for: ${content}`,
          })),
        );
        answer = await this.deepSeekClient.complete(content, history, this.lastSources);
      }
      this.messages.push({ role: "assistant", content: answer });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(message, 6000);
      this.messages.push({ role: "assistant", content: message, error: true });
    } finally {
      this.isSending = false;
      this.render();
    }
  }

  private async applyPendingEdit(edit: PendingEdit): Promise<void> {
    try {
      await this.agentTools.applyEdit(edit);
      this.pendingEdits = this.pendingEdits.filter((pending) => pending.id !== edit.id);
      this.workingSet = mergeWorkingSet(this.workingSet, [{ path: edit.path, role: "edited", detail: `Applied: ${edit.summary}` }]);
      new Notice(`Applied edit: ${edit.path}`, 3000);
      this.render();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(message, 6000);
    }
  }
}

function mergeWorkingSet(existing: WorkingSetItem[], ...groups: WorkingSetItem[][]): WorkingSetItem[] {
  const merged = new Map(existing.map((item) => [`${item.path}:${item.role}`, item]));
  for (const item of groups.flat()) {
    const key = `${item.path}:${item.role}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, item);
      continue;
    }
    if (!current.detail.includes(item.detail)) {
      merged.set(key, { ...current, detail: `${current.detail}; ${item.detail}` });
    }
  }
  return Array.from(merged.values());
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

type DiffLine = { type: "same" | "add" | "remove"; prefix: string; text: string };

function buildEditDiff(edit: PendingEdit): DiffLine[] {
  if (edit.kind === "patch" && typeof edit.find === "string" && typeof edit.replace === "string") {
    return buildLineDiff(edit.find, edit.replace);
  }

  return buildLineDiff(edit.originalContent, edit.newContent);
}

function buildLineDiff(oldContent: string, newContent: string): DiffLine[] {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const table: number[][] = Array.from({ length: oldLines.length + 1 }, () => Array(newLines.length + 1).fill(0));

  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i][j] = oldLines[i] === newLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      diff.push({ type: "same", prefix: " ", text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      diff.push({ type: "remove", prefix: "-", text: oldLines[i] });
      i += 1;
    } else {
      diff.push({ type: "add", prefix: "+", text: newLines[j] });
      j += 1;
    }
  }

  while (i < oldLines.length) {
    diff.push({ type: "remove", prefix: "-", text: oldLines[i] });
    i += 1;
  }

  while (j < newLines.length) {
    diff.push({ type: "add", prefix: "+", text: newLines[j] });
    j += 1;
  }

  return collapseUnchanged(diff);
}

function collapseUnchanged(diff: DiffLine[]): DiffLine[] {
  const result: DiffLine[] = [];
  let unchangedBuffer: DiffLine[] = [];

  const flush = () => {
    if (unchangedBuffer.length <= 8) {
      result.push(...unchangedBuffer);
    } else {
      result.push(...unchangedBuffer.slice(0, 3));
      result.push({ type: "same", prefix: " ", text: `[${unchangedBuffer.length - 6} unchanged lines]` });
      result.push(...unchangedBuffer.slice(-3));
    }
    unchangedBuffer = [];
  };

  for (const line of diff) {
    if (line.type === "same") {
      unchangedBuffer.push(line);
    } else {
      flush();
      result.push(line);
    }
  }
  flush();

  return result;
}
