import { ItemView, MarkdownView, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { IndexStore } from "../core/indexStore";
import { SearchResult } from "../core/types";
import { GraphSearchEngine } from "../search/graphSearch";

export const RELATED_NOTES_VIEW_TYPE = "vault-chat-agent-related-notes-view";

interface RelatedNoteResult {
  path: string;
  score: number;
  bestScore: number;
  snippet: string;
  matches: number;
}

export class RelatedNotesView extends ItemView {
  private results: RelatedNoteResult[] = [];
  private statusText = "";
  private refreshTimer: number | null = null;
  private refreshVersion = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly indexStore: IndexStore,
    private readonly searchEngine: GraphSearchEngine,
    private readonly startChatForNote: (path: string) => void,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return RELATED_NOTES_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Related Notes";
  }

  getIcon(): string {
    return "network";
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("vault-chat-agent-related-view");
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleRefresh()));
    this.registerEvent(this.app.workspace.on("editor-change", () => this.scheduleRefresh()));
    await this.refresh();
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async refresh(): Promise<void> {
    const version = ++this.refreshVersion;
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const activeFile = activeView?.file ?? this.app.workspace.getActiveFile();
    if (!activeFile) {
      this.results = [];
      this.statusText = "Open a note to see related notes.";
      this.render();
      return;
    }

    const query = await this.buildRelatedQuery(activeView, activeFile);
    if (version !== this.refreshVersion) {
      return;
    }
    if (!query.trim()) {
      this.results = [];
      this.statusText = "No indexed content is available for this note.";
      this.render();
      return;
    }

    const sourceLabel = activeView?.editor.getSelection().trim() ? "selection" : activeFile.path;
    this.statusText = `Related to ${sourceLabel}`;
    const rawResults = this.searchEngine.search(query, 32, (chunk) => chunk.filePath !== activeFile.path);
    if (version !== this.refreshVersion) {
      return;
    }
    this.results = groupRelatedResults(rawResults).slice(0, 12);
    this.render();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 450);
  }

  private render(): void {
    this.containerEl.empty();

    const toolbar = this.containerEl.createDiv({ cls: "vault-chat-agent-related-toolbar" });
    toolbar.createDiv({ cls: "vault-chat-agent-related-title", text: "Related Notes" });
    const refreshButton = toolbar.createEl("button", {
      cls: "vault-chat-agent-toolbar-button",
      attr: { "aria-label": "Refresh related notes" },
    });
    setIcon(refreshButton, "refresh-cw");
    refreshButton.onclick = () => {
      void this.refresh().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(message, 6000);
      });
    };

    this.containerEl.createDiv({ cls: "vault-chat-agent-related-status", text: this.statusText });

    const body = this.containerEl.createDiv({ cls: "vault-chat-agent-related-list" });
    if (this.results.length === 0) {
      body.createDiv({
        cls: "setting-item-description",
        text: "No related indexed notes found.",
      });
      return;
    }

    for (const result of this.results) {
      const item = body.createDiv({ cls: "vault-chat-agent-related-item" });
      const header = item.createDiv({ cls: "vault-chat-agent-related-item-header" });
      const openButton = header.createEl("button", { cls: "vault-chat-agent-related-path", text: result.path });
      openButton.onclick = () => {
        void this.app.workspace.openLinkText(result.path, "", false);
      };
      header.createSpan({ cls: "vault-chat-agent-related-score", text: result.score.toFixed(3) });
      const actions = item.createDiv({ cls: "vault-chat-agent-related-actions" });
      const chatButton = actions.createEl("button", { text: "Ask about this note" });
      chatButton.onclick = () => {
        this.startChatForNote(result.path);
      };
      item.createDiv({
        cls: "vault-chat-agent-related-meta",
        text: `${result.matches} ${result.matches === 1 ? "match" : "matches"}`,
      });
      item.createDiv({ cls: "vault-chat-agent-related-snippet", text: result.snippet });
    }
  }

  private async buildRelatedQuery(activeView: MarkdownView | null, activeFile: TFile): Promise<string> {
    const selection = activeView?.editor.getSelection().trim();
    if (selection) {
      return clip(selection, 4000);
    }

    const document = this.indexStore.getAllDocuments().find((item) => item.path === activeFile.path);
    const chunks = this.indexStore
      .getAllChunks()
      .filter((chunk) => chunk.filePath === activeFile.path)
      .sort((a, b) => a.startOffset - b.startOffset)
      .slice(0, 4);

    if (document || chunks.length > 0) {
      return [
        activeFile.basename,
        document?.aliases.join(" ") ?? "",
        document?.tags.join(" ") ?? "",
        document?.headings.join(" ") ?? "",
        chunks.map((chunk) => chunk.content).join("\n\n"),
      ]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 5000);
    }

    return clip(await this.app.vault.cachedRead(activeFile), 5000);
  }
}

function groupRelatedResults(results: SearchResult[]): RelatedNoteResult[] {
  const grouped = new Map<string, RelatedNoteResult>();
  for (const result of results) {
    const current = grouped.get(result.chunk.filePath);
    if (!current) {
      grouped.set(result.chunk.filePath, {
        path: result.chunk.filePath,
        score: result.score,
        bestScore: result.score,
        snippet: result.chunk.content.slice(0, 320),
        matches: 1,
      });
      continue;
    }

    current.score += result.score * 0.65;
    current.matches += 1;
    if (result.score > current.bestScore) {
      current.bestScore = result.score;
      current.snippet = result.chunk.content.slice(0, 320);
    }
  }

  return Array.from(grouped.values()).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function clip(content: string, maxChars: number): string {
  return content.length <= maxChars ? content : content.slice(0, maxChars);
}
