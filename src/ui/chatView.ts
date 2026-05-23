import { ItemView, MarkdownRenderer, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import { AgentToolExecutor, ChatIntent, PendingEdit, SearchResult, WorkingSetItem } from "../core/types";
import { AIChatClient } from "../services/aiChatClient";

export const CHAT_VIEW_TYPE = "vault-ai-assistant-chat-view";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

type PanelId = "edits" | "workingSet" | "sources";

export class ChatView extends ItemView {
  private messages: ChatMessage[] = [];
  private intent: ChatIntent;
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
    private readonly aiChatClient: AIChatClient,
    private readonly agentTools: AgentToolExecutor,
    defaultIntent: ChatIntent,
  ) {
    super(leaf);
    this.intent = defaultIntent;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Vault AI Assistant";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("vault-ai-assistant-view");
    this.render();
  }

  startTask(content: string, intent: ChatIntent): void {
    if (this.isSending) {
      new Notice("Vault AI Assistant is already working.", 3000);
      return;
    }

    this.intent = intent;
    void this.sendMessage(content);
  }

  private render(): void {
    this.containerEl.empty();

    const toolbar = this.containerEl.createDiv({ cls: "vault-ai-assistant-toolbar" });
    this.renderIntentControl(toolbar);

    const clearButton = toolbar.createEl("button", { attr: { "aria-label": "Clear chat" } });
    setIcon(clearButton, "trash-2");
    this.registerDomEvent(clearButton, "click", () => {
      this.messages = [];
      this.lastSources = [];
      this.pendingEdits = [];
      this.workingSet = [];
      this.render();
    });

    const messagesEl = this.containerEl.createDiv({ cls: "vault-ai-assistant-messages" });
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
      messagesEl.createDiv({ cls: "vault-ai-assistant-status", text: this.statusText || "Working..." });
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

  private renderIntentControl(toolbar: HTMLElement): void {
    const intentControl = toolbar.createDiv({ cls: "vault-ai-assistant-intent-control", attr: { "aria-label": "Chat intent" } });
    const intents: Array<{ intent: ChatIntent; label: string; description: string }> = [
      { intent: "ask", label: "Ask", description: "Inspect the vault with read-only tools" },
      { intent: "edit", label: "Edit", description: "Prepare reviewed changes for approval" },
    ];

    for (const item of intents) {
      const button = intentControl.createEl("button", {
        cls: `vault-ai-assistant-intent-button ${this.intent === item.intent ? "is-active" : ""}`,
        text: item.label,
        attr: { "aria-label": item.description },
      });
      button.disabled = this.isSending;
      this.registerDomEvent(button, "click", () => {
        this.intent = item.intent;
        this.render();
      });
    }
  }

  private getEmptyStateText(): string {
    if (this.intent === "edit") {
      return "Ask for reviewed changes. Edits stay pending until you apply them.";
    }
    return "Ask about your vault. The assistant can inspect notes but will not prepare edits.";
  }

  private async renderMessage(parent: HTMLElement, message: ChatMessage): Promise<void> {
    const cls = [
      "vault-ai-assistant-message",
      message.role === "user" ? "vault-ai-assistant-message-user" : "vault-ai-assistant-message-assistant",
      message.error ? "vault-ai-assistant-message-error" : "",
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
      const sourceEl = body.createDiv({ cls: "vault-ai-assistant-source" });
      const title = sourceEl.createDiv({ cls: "vault-ai-assistant-source-title" });
      title.setText(result.chunk.filePath);
      sourceEl.createDiv({
        cls: "vault-ai-assistant-source-snippet",
        text: result.chunk.content.slice(0, 280),
      });
    }
  }

  private renderPendingEdits(): void {
    const body = this.renderPanel("edits", `Pending edits (${this.pendingEdits.length})`);
    if (!body) {
      return;
    }

    const batchActions = body.createDiv({ cls: "vault-ai-assistant-panel-actions" });
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
      const editEl = body.createDiv({ cls: "vault-ai-assistant-edit" });
      const header = editEl.createDiv({ cls: "vault-ai-assistant-edit-header" });
      header.createDiv({ cls: "vault-ai-assistant-edit-title", text: edit.path });
      header.createDiv({ cls: "vault-ai-assistant-edit-summary", text: `${editKindLabel(edit)}: ${edit.summary}` });

      const diffEl = editEl.createDiv({ cls: "vault-ai-assistant-diff" });
      const diff = buildEditDiff(edit);
      for (const line of diff.slice(0, 240)) {
        diffEl.createDiv({
          cls: `vault-ai-assistant-diff-line vault-ai-assistant-diff-${line.type}`,
          text: `${line.prefix} ${line.text}`,
        });
      }

      if (diff.length > 240) {
        diffEl.createDiv({ cls: "vault-ai-assistant-diff-line", text: `[${diff.length - 240} more diff lines hidden]` });
      }

      const actions = editEl.createDiv({ cls: "vault-ai-assistant-edit-actions" });
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
      const itemEl = body.createDiv({ cls: "vault-ai-assistant-working-set-item" });
      itemEl.createSpan({ cls: `vault-ai-assistant-working-set-role vault-ai-assistant-working-set-${item.role}`, text: item.role });
      itemEl.createSpan({ cls: "vault-ai-assistant-working-set-path", text: item.path });
      itemEl.createSpan({ cls: "vault-ai-assistant-working-set-detail", text: item.detail });
    }

    if (this.workingSet.length > 80) {
      body.createDiv({ cls: "setting-item-description", text: `${this.workingSet.length - 80} more items hidden.` });
    }
  }

  private renderPanel(panelId: PanelId, title: string): HTMLElement | null {
    const panelEl = this.containerEl.createDiv({ cls: "vault-ai-assistant-panel" });
    const header = panelEl.createEl("button", {
      cls: "vault-ai-assistant-panel-header",
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

    return panelEl.createDiv({ cls: `vault-ai-assistant-panel-body vault-ai-assistant-panel-${panelId}` });
  }

  private renderInput(): void {
    const inputRow = this.containerEl.createDiv({ cls: "vault-ai-assistant-input-row" });
    const textarea = inputRow.createEl("textarea", {
      cls: "vault-ai-assistant-input",
      attr: {
        placeholder: this.intent === "edit" ? "Ask for reviewed changes..." : "Ask about your vault...",
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
      this.statusText = this.intent === "edit" ? "Preparing reviewed changes..." : "Inspecting the vault...";
      this.render();
      const result = await this.aiChatClient.completeWithAgent(content, history, this.agentTools, this.intent);
      this.lastSources = result.sources;
      this.pendingEdits = this.pendingEdits.concat(result.pendingEdits);
      this.workingSet = mergeWorkingSet(
        this.workingSet,
        result.workingSet,
        result.pendingEdits.map((edit) => ({ path: edit.path, role: "edited", detail: edit.summary })),
      );
      this.messages.push({ role: "assistant", content: result.answer });
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
      new Notice(`${edit.kind === "create" ? "Created note" : "Applied edit"}: ${edit.path}`, 3000);
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

type DiffLine = { type: "same" | "add" | "remove"; prefix: string; text: string };

function buildEditDiff(edit: PendingEdit): DiffLine[] {
  if (edit.kind === "patch" && typeof edit.find === "string" && typeof edit.replace === "string") {
    return buildLineDiff(edit.find, edit.replace);
  }

  return buildLineDiff(edit.originalContent, edit.newContent);
}

function editKindLabel(edit: PendingEdit): string {
  if (edit.kind === "create") {
    return "New note";
  }
  return edit.kind === "patch" ? "Patch" : "Full edit";
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
