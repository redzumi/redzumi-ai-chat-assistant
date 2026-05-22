import { ItemView, MarkdownRenderer, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import { AgentToolExecutor, PendingEdit, SearchResult, WorkingSetItem } from "../core/types";
import { AIChatClient } from "../services/aiChatClient";
import { GraphSearchEngine } from "../search/graphSearch";

export const CHAT_VIEW_TYPE = "obsidian-ai-assistant-chat-view";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

type ChatMode = "chat" | "rag" | "agent";
type PanelId = "edits" | "workingSet" | "sources";

export class ChatView extends ItemView {
  private messages: ChatMessage[] = [];
  private mode: ChatMode;
  private lastSources: SearchResult[] = [];
  private pendingEdits: PendingEdit[] = [];
  private workingSet: WorkingSetItem[] = [];
  private isSending = false;
  private statusText = "";
  private readonly expandedPanels: Record<PanelId, boolean> = {
    edits: true,
    workingSet: false,
    sources: false,
  };

  constructor(
    leaf: WorkspaceLeaf,
    private readonly searchEngine: GraphSearchEngine,
    private readonly aiChatClient: AIChatClient,
    private readonly agentTools: AgentToolExecutor,
    private readonly getTopK: () => number,
    includeContextByDefault: boolean,
    agentModeByDefault: boolean,
  ) {
    super(leaf);
    this.mode = agentModeByDefault ? "agent" : includeContextByDefault ? "rag" : "chat";
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Obsidian AI Assistant";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("obsidian-ai-assistant-view");
    this.render();
  }

  startAgentTask(content: string): void {
    if (this.isSending) {
      new Notice("Obsidian AI Assistant is already working.", 3000);
      return;
    }

    this.mode = "agent";
    void this.sendMessage(content);
  }

  private render(): void {
    this.containerEl.empty();

    const toolbar = this.containerEl.createDiv({ cls: "obsidian-ai-assistant-toolbar" });
    this.renderModeControl(toolbar);

    const clearButton = toolbar.createEl("button", { attr: { "aria-label": "Clear chat" } });
    setIcon(clearButton, "trash-2");
    this.registerDomEvent(clearButton, "click", () => {
      this.messages = [];
      this.lastSources = [];
      this.pendingEdits = [];
      this.workingSet = [];
      this.render();
    });

    const messagesEl = this.containerEl.createDiv({ cls: "obsidian-ai-assistant-messages" });
    if (this.messages.length === 0) {
      messagesEl.createEl("div", {
        cls: "setting-item-description",
        text: this.getEmptyStateText(),
      });
    }

    for (const message of this.messages) {
      void this.renderMessage(messagesEl, message);
    }

    if (this.isSending) {
      messagesEl.createDiv({ cls: "obsidian-ai-assistant-status", text: this.statusText || "Working..." });
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

  private renderModeControl(toolbar: HTMLElement): void {
    const modeControl = toolbar.createDiv({ cls: "obsidian-ai-assistant-mode-control", attr: { "aria-label": "Chat mode" } });
    const modes: Array<{ mode: ChatMode; label: string; description: string }> = [
      { mode: "chat", label: "Chat", description: "No note context" },
      { mode: "rag", label: "Context", description: "Search note context before answering" },
      { mode: "agent", label: "Agent", description: "Inspect vault and propose edits" },
    ];

    for (const item of modes) {
      const button = modeControl.createEl("button", {
        cls: `obsidian-ai-assistant-mode-button ${this.mode === item.mode ? "is-active" : ""}`,
        text: item.label,
        attr: { "aria-label": item.description },
      });
      button.disabled = this.isSending;
      this.registerDomEvent(button, "click", () => {
        this.mode = item.mode;
        this.render();
      });
    }
  }

  private getEmptyStateText(): string {
    if (this.mode === "agent") {
      return "Ask the agent to inspect notes, review files, or prepare edits.";
    }
    if (this.mode === "rag") {
      return "Ask a question using indexed note context.";
    }
    return "Ask a plain chat question.";
  }

  private async renderMessage(parent: HTMLElement, message: ChatMessage): Promise<void> {
    const cls = [
      "obsidian-ai-assistant-message",
      message.role === "user" ? "obsidian-ai-assistant-message-user" : "obsidian-ai-assistant-message-assistant",
      message.error ? "obsidian-ai-assistant-message-error" : "",
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
    const body = this.renderPanel("sources", `Sources (${this.lastSources.length})`);
    if (!body) {
      return;
    }

    for (const result of this.lastSources) {
      const sourceEl = body.createDiv({ cls: "obsidian-ai-assistant-source" });
      const title = sourceEl.createDiv({ cls: "obsidian-ai-assistant-source-title" });
      title.setText(result.chunk.filePath);
      sourceEl.createDiv({
        cls: "obsidian-ai-assistant-source-snippet",
        text: result.chunk.content.slice(0, 280),
      });
    }
  }

  private renderPendingEdits(): void {
    const body = this.renderPanel("edits", `Pending edits (${this.pendingEdits.length})`);
    if (!body) {
      return;
    }

    const batchActions = body.createDiv({ cls: "obsidian-ai-assistant-panel-actions" });
    const applyAllButton = batchActions.createEl("button", { cls: "mod-cta", text: "Apply all" });
    const rejectAllButton = batchActions.createEl("button", { text: "Reject all" });
    applyAllButton.disabled = this.isSending;
    this.registerDomEvent(applyAllButton, "click", () => {
      void this.applyAllPendingEdits();
    });
    this.registerDomEvent(rejectAllButton, "click", () => {
      this.pendingEdits = [];
      this.render();
    });

    for (const edit of this.pendingEdits) {
      const editEl = body.createDiv({ cls: "obsidian-ai-assistant-edit" });
      const header = editEl.createDiv({ cls: "obsidian-ai-assistant-edit-header" });
      header.createDiv({ cls: "obsidian-ai-assistant-edit-title", text: edit.path });
      header.createDiv({ cls: "obsidian-ai-assistant-edit-summary", text: `${edit.kind === "patch" ? "Patch" : "Full edit"}: ${edit.summary}` });

      const diffEl = editEl.createDiv({ cls: "obsidian-ai-assistant-diff" });
      const diff = buildEditDiff(edit);
      for (const line of diff.slice(0, 240)) {
        diffEl.createDiv({
          cls: `obsidian-ai-assistant-diff-line obsidian-ai-assistant-diff-${line.type}`,
          text: `${line.prefix} ${line.text}`,
        });
      }

      if (diff.length > 240) {
        diffEl.createDiv({ cls: "obsidian-ai-assistant-diff-line", text: `[${diff.length - 240} more diff lines hidden]` });
      }

      const actions = editEl.createDiv({ cls: "obsidian-ai-assistant-edit-actions" });
      const openButton = actions.createEl("button", { text: "Open" });
      const applyButton = actions.createEl("button", { cls: "mod-cta", text: "Apply" });
      const rejectButton = actions.createEl("button", { text: "Reject" });
      applyButton.disabled = this.isSending;

      this.registerDomEvent(openButton, "click", () => {
        void this.app.workspace.openLinkText(edit.path, "", false);
      });
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
    const body = this.renderPanel("workingSet", `Working set (${this.workingSet.length})`);
    if (!body) {
      return;
    }

    for (const item of this.workingSet.slice(0, 80)) {
      const itemEl = body.createDiv({ cls: "obsidian-ai-assistant-working-set-item" });
      itemEl.createSpan({ cls: `obsidian-ai-assistant-working-set-role obsidian-ai-assistant-working-set-${item.role}`, text: item.role });
      itemEl.createSpan({ cls: "obsidian-ai-assistant-working-set-path", text: item.path });
      itemEl.createSpan({ cls: "obsidian-ai-assistant-working-set-detail", text: item.detail });
    }

    if (this.workingSet.length > 80) {
      body.createDiv({ cls: "setting-item-description", text: `${this.workingSet.length - 80} more items hidden.` });
    }
  }

  private renderPanel(panelId: PanelId, title: string): HTMLElement | null {
    const panelEl = this.containerEl.createDiv({ cls: "obsidian-ai-assistant-panel" });
    const header = panelEl.createEl("button", {
      cls: "obsidian-ai-assistant-panel-header",
      attr: { "aria-expanded": String(this.expandedPanels[panelId]) },
    });
    setIcon(header, this.expandedPanels[panelId] ? "chevron-down" : "chevron-right");
    header.createSpan({ text: title });
    this.registerDomEvent(header, "click", () => {
      this.expandedPanels[panelId] = !this.expandedPanels[panelId];
      this.render();
    });

    if (!this.expandedPanels[panelId]) {
      return null;
    }

    return panelEl.createDiv({ cls: `obsidian-ai-assistant-panel-body obsidian-ai-assistant-panel-${panelId}` });
  }

  private renderInput(): void {
    const inputRow = this.containerEl.createDiv({ cls: "obsidian-ai-assistant-input-row" });
    const textarea = inputRow.createEl("textarea", {
      cls: "obsidian-ai-assistant-input",
      attr: {
        placeholder: this.mode === "agent" ? "Ask the agent..." : this.mode === "rag" ? "Ask with note context..." : "Message assistant...",
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
      if (this.mode === "agent") {
        this.statusText = "Agent is inspecting the vault...";
        this.render();
        const result = await this.aiChatClient.completeWithAgent(content, history, this.agentTools);
        this.lastSources = result.sources;
        this.pendingEdits = this.pendingEdits.concat(result.pendingEdits);
        this.workingSet = mergeWorkingSet(
          this.workingSet,
          result.workingSet,
          result.pendingEdits.map((edit) => ({ path: edit.path, role: "edited", detail: edit.summary })),
        );
        answer = result.answer;
      } else {
        this.statusText = this.mode === "rag" ? "Searching note context..." : "Waiting for model...";
        this.render();
        this.lastSources = this.mode === "rag" ? this.searchEngine.search(content, this.getTopK()) : [];
        this.workingSet = mergeWorkingSet(
          this.workingSet,
          unique(this.lastSources.map((source) => source.chunk.filePath)).map((path) => ({
            path,
            role: "searched",
            detail: `Context for: ${content}`,
          })),
        );
        answer = await this.aiChatClient.complete(content, history, this.lastSources);
      }
      this.messages.push({ role: "assistant", content: answer });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(message, 6000);
      this.messages.push({ role: "assistant", content: message, error: true });
    } finally {
      this.isSending = false;
      this.statusText = "";
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

  private async applyAllPendingEdits(): Promise<void> {
    const edits = [...this.pendingEdits];
    for (const edit of edits) {
      try {
        await this.agentTools.applyEdit(edit);
        this.pendingEdits = this.pendingEdits.filter((pending) => pending.id !== edit.id);
        this.workingSet = mergeWorkingSet(this.workingSet, [{ path: edit.path, role: "edited", detail: `Applied: ${edit.summary}` }]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(message, 6000);
        this.render();
        return;
      }
    }

    new Notice(`Applied ${edits.length} edits.`, 3000);
    this.render();
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
