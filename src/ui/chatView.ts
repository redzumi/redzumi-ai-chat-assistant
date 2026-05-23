import { ItemView, MarkdownRenderer, Notice, setIcon, TFolder, WorkspaceLeaf } from "obsidian";
import { AgentToolExecution, AgentToolExecutor, ChatIntent, DebugLogEntry, PendingEdit, SearchResult, WorkingSetItem } from "../core/types";
import { ObsidianMcpServer, summarizePendingEdit } from "../mcp/obsidianMcpServer";
import { AIChatClient } from "../services/aiChatClient";

export const CHAT_VIEW_TYPE = "vault-chat-agent-chat-view";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

type PanelId = "edits" | "workingSet" | "sources" | "debug";

export class ChatView extends ItemView {
  private messages: ChatMessage[] = [];
  private intent: ChatIntent;
  private lastSources: SearchResult[] = [];
  private pendingEdits: PendingEdit[] = [];
  private workingSet: WorkingSetItem[] = [];
  private debugLogs: DebugLogEntry[] = [];
  private isSending = false;
  private statusText = "";
  private readonly expandedPanels: Record<PanelId, boolean> = {
    edits: true,
    workingSet: false,
    sources: false,
    debug: false,
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
    return "Vault Chat Agent";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("vault-chat-agent-view");
    this.render();
  }

  startTask(content: string, intent: ChatIntent): void {
    if (this.isSending) {
      new Notice("Vault Chat Agent is already working.", 3000);
      return;
    }

    this.intent = intent;
    void this.sendMessage(content);
  }

  private render(): void {
    this.containerEl.empty();

    const toolbar = this.containerEl.createDiv({ cls: "vault-chat-agent-toolbar" });
    this.renderIntentControl(toolbar);

    const debugButton = toolbar.createEl("button", {
      cls: this.expandedPanels.debug ? "vault-chat-agent-toolbar-button is-active" : "vault-chat-agent-toolbar-button",
      attr: { "aria-label": "Show debug log" },
    });
    setIcon(debugButton, "bug");
    this.registerDomEvent(debugButton, "click", () => {
      this.expandedPanels.debug = !this.expandedPanels.debug;
      this.render();
    });

    const exportButton = toolbar.createEl("button", { cls: "vault-chat-agent-toolbar-button", attr: { "aria-label": "Export chat debug data" } });
    setIcon(exportButton, "download");
    this.registerDomEvent(exportButton, "click", () => {
      void this.exportDebugData().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(message, 6000);
      });
    });

    const clearButton = toolbar.createEl("button", { attr: { "aria-label": "Clear chat" } });
    setIcon(clearButton, "trash-2");
    this.registerDomEvent(clearButton, "click", () => {
      this.messages = [];
      this.lastSources = [];
      this.pendingEdits = [];
      this.workingSet = [];
      this.debugLogs = [];
      this.render();
    });

    const messagesEl = this.containerEl.createDiv({ cls: "vault-chat-agent-messages" });
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
      messagesEl.createDiv({ cls: "vault-chat-agent-status", text: this.statusText || "Working..." });
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

    if (this.expandedPanels.debug || this.debugLogs.length > 0) {
      this.renderDebugLog();
    }

    this.renderInput();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  private renderIntentControl(toolbar: HTMLElement): void {
    const intentControl = toolbar.createDiv({ cls: "vault-chat-agent-intent-control", attr: { "aria-label": "Chat intent" } });
    const intents: Array<{ intent: ChatIntent; label: string; description: string }> = [
      { intent: "ask", label: "Ask", description: "Inspect the vault with read-only tools" },
      { intent: "edit", label: "Edit", description: "Prepare reviewed changes for approval" },
    ];

    for (const item of intents) {
      const button = intentControl.createEl("button", {
        cls: `vault-chat-agent-intent-button ${this.intent === item.intent ? "is-active" : ""}`,
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
      "vault-chat-agent-message",
      message.role === "user" ? "vault-chat-agent-message-user" : "vault-chat-agent-message-assistant",
      message.error ? "vault-chat-agent-message-error" : "",
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
      const sourceEl = body.createDiv({ cls: "vault-chat-agent-source" });
      const title = sourceEl.createDiv({ cls: "vault-chat-agent-source-title" });
      title.setText(result.chunk.filePath);
      sourceEl.createDiv({
        cls: "vault-chat-agent-source-snippet",
        text: result.chunk.content.slice(0, 280),
      });
    }
  }

  private renderPendingEdits(): void {
    const body = this.renderPanel("edits", `Pending edits (${this.pendingEdits.length})`);
    if (!body) {
      return;
    }

    const batchActions = body.createDiv({ cls: "vault-chat-agent-panel-actions" });
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
      const editEl = body.createDiv({ cls: "vault-chat-agent-edit" });
      const header = editEl.createDiv({ cls: "vault-chat-agent-edit-header" });
      header.createDiv({ cls: "vault-chat-agent-edit-title", text: edit.path });
      header.createDiv({ cls: "vault-chat-agent-edit-summary", text: `${editKindLabel(edit)}: ${edit.summary}` });

      const diffEl = editEl.createDiv({ cls: "vault-chat-agent-diff" });
      const diff = buildEditDiff(edit);
      for (const line of diff.slice(0, 240)) {
        diffEl.createDiv({
          cls: `vault-chat-agent-diff-line vault-chat-agent-diff-${line.type}`,
          text: `${line.prefix} ${line.text}`,
        });
      }

      if (diff.length > 240) {
        diffEl.createDiv({ cls: "vault-chat-agent-diff-line", text: `[${diff.length - 240} more diff lines hidden]` });
      }

      const actions = editEl.createDiv({ cls: "vault-chat-agent-edit-actions" });
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
      const itemEl = body.createDiv({ cls: "vault-chat-agent-working-set-item" });
      itemEl.createSpan({ cls: `vault-chat-agent-working-set-role vault-chat-agent-working-set-${item.role}`, text: item.role });
      itemEl.createSpan({ cls: "vault-chat-agent-working-set-path", text: item.path });
      itemEl.createSpan({ cls: "vault-chat-agent-working-set-detail", text: item.detail });
    }

    if (this.workingSet.length > 80) {
      body.createDiv({ cls: "setting-item-description", text: `${this.workingSet.length - 80} more items hidden.` });
    }
  }

  private renderPanel(panelId: PanelId, title: string): HTMLElement | null {
    const panelEl = this.containerEl.createDiv({ cls: "vault-chat-agent-panel" });
    const header = panelEl.createEl("button", {
      cls: "vault-chat-agent-panel-header",
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

    return panelEl.createDiv({ cls: `vault-chat-agent-panel-body vault-chat-agent-panel-${panelId}` });
  }

  private renderDebugLog(): void {
    const body = this.renderPanel("debug", `Debug log (${this.debugLogs.length})`);
    if (!body) {
      return;
    }

    const actions = body.createDiv({ cls: "vault-chat-agent-panel-actions" });
    const copyButton = actions.createEl("button", { text: "Copy JSON" });
    const exportButton = actions.createEl("button", { cls: "mod-cta", text: "Export JSON" });
    copyButton.disabled = this.debugLogs.length === 0 && this.messages.length === 0;
    exportButton.disabled = copyButton.disabled;

    this.registerDomEvent(copyButton, "click", () => {
      void this.copyDebugData().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(message, 6000);
      });
    });
    this.registerDomEvent(exportButton, "click", () => {
      void this.exportDebugData().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(message, 6000);
      });
    });

    body.createDiv({
      cls: "setting-item-description",
      text: "Debug export can include prompts, note excerpts, tool results, and model responses.",
    });

    for (const entry of this.debugLogs.slice(-80)) {
      const entryEl = body.createDiv({ cls: "vault-chat-agent-debug-entry" });
      const header = entryEl.createDiv({ cls: "vault-chat-agent-debug-entry-header" });
      header.createSpan({ cls: `vault-chat-agent-debug-type vault-chat-agent-debug-${entry.type}`, text: entry.type });
      header.createSpan({ cls: "vault-chat-agent-debug-time", text: formatDebugTime(entry.timestamp) });
      entryEl.createDiv({ cls: "vault-chat-agent-debug-summary", text: entry.summary });
    }

    if (this.debugLogs.length > 80) {
      body.createDiv({ cls: "setting-item-description", text: `${this.debugLogs.length - 80} older debug events hidden.` });
    }
  }

  private renderInput(): void {
    const inputRow = this.containerEl.createDiv({ cls: "vault-chat-agent-input-row" });
    const textarea = inputRow.createEl("textarea", {
      cls: "vault-chat-agent-input",
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
      const result = await this.aiChatClient.completeWithAgent(
        content,
        history,
        this.createMcpServer(),
        this.intent,
        (entry) => {
          this.debugLogs.push(entry);
          if (this.expandedPanels.debug) {
            this.render();
          }
        },
        {
          intent: this.intent,
          pendingEdits: this.pendingEdits.map(summarizePendingEdit),
        },
      );
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

  private createMcpServer(): ObsidianMcpServer {
    return new ObsidianMcpServer(
      this.agentTools,
      (id) => this.applyPendingEditTool(id),
      () => this.applyAllPendingEditsTool(),
    );
  }

  private async applyPendingEditTool(id: string): Promise<AgentToolExecution> {
    const edit = this.pendingEdits.find((pending) => pending.id === id);
    if (!edit) {
      return { content: `Pending edit not found: ${id || "(missing id)"}.` };
    }

    await this.agentTools.applyEdit(edit);
    this.pendingEdits = this.pendingEdits.filter((pending) => pending.id !== edit.id);
    this.workingSet = mergeWorkingSet(this.workingSet, [{ path: edit.path, role: "edited", detail: `Applied: ${edit.summary}` }]);
    return {
      content: `Applied pending edit ${edit.id} to ${edit.path}.`,
      workingSetItems: [{ path: edit.path, role: "edited", detail: `Applied: ${edit.summary}` }],
    };
  }

  private async applyAllPendingEditsTool(): Promise<AgentToolExecution> {
    if (this.pendingEdits.length === 0) {
      return { content: "There are no pending edits to apply." };
    }

    const edits = [...this.pendingEdits];
    const appliedPaths: string[] = [];
    for (const edit of edits) {
      await this.agentTools.applyEdit(edit);
      this.pendingEdits = this.pendingEdits.filter((pending) => pending.id !== edit.id);
      this.workingSet = mergeWorkingSet(this.workingSet, [{ path: edit.path, role: "edited", detail: `Applied: ${edit.summary}` }]);
      appliedPaths.push(edit.path);
    }

    return {
      content: `Applied ${appliedPaths.length} pending edits:\n${appliedPaths.map((path) => `- ${path}`).join("\n")}`,
      workingSetItems: appliedPaths.map((path) => ({ path, role: "edited", detail: "Applied pending edit" })),
    };
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

  private async copyDebugData(): Promise<void> {
    await navigator.clipboard.writeText(JSON.stringify(this.buildDebugExport(), null, 2));
    new Notice("Copied debug JSON.", 3000);
  }

  private async exportDebugData(): Promise<void> {
    const folderPath = "Vault Chat Agent Debug";
    await this.ensureFolder(folderPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `${folderPath}/chat-debug-${timestamp}.json`;
    await this.app.vault.create(path, JSON.stringify(this.buildDebugExport(), null, 2));
    new Notice(`Exported debug data: ${path}`, 5000);
  }

  private buildDebugExport(): Record<string, unknown> {
    return {
      exportedAt: new Date().toISOString(),
      intent: this.intent,
      isSending: this.isSending,
      messages: this.messages,
      pendingEdits: this.pendingEdits,
      sources: this.lastSources,
      workingSet: this.workingSet,
      debugLogs: this.debugLogs,
    };
  }

  private async ensureFolder(path: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) {
      return;
    }
    if (existing) {
      throw new Error(`Cannot create debug export folder because a file already exists at: ${path}`);
    }
    await this.app.vault.createFolder(path);
  }
}

function formatDebugTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleTimeString();
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
