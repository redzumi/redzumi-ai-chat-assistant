import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { ObsidianAgentTools } from "./agent/obsidianTools";
import { SemanticChunker } from "./core/chunker";
import { IndexStore } from "./core/indexStore";
import { DEFAULT_SETTINGS, DeepSeekRagSettings, IndexCoverage, PersistedIndex } from "./core/types";
import { indexVaultFiles } from "./indexing/indexAll";
import { RealtimeIndexer } from "./indexing/realtimeIndexer";
import { GraphSearchEngine } from "./search/graphSearch";
import { HybridSearchEngine } from "./search/hybridSearch";
import { DeepSeekClient } from "./services/deepseekClient";
import { CHAT_VIEW_TYPE, ChatView } from "./ui/chatView";
import { DeepSeekSettingTab } from "./ui/settingsTab";

interface PluginData {
  settings?: Partial<DeepSeekRagSettings>;
  index?: PersistedIndex;
}

export default class DeepSeekRAGPlugin extends Plugin {
  settings: DeepSeekRagSettings = { ...DEFAULT_SETTINGS };

  private chunker = new SemanticChunker(DEFAULT_SETTINGS.chunkSize, DEFAULT_SETTINGS.overlapSize);
  private readonly indexStore = new IndexStore();
  private readonly searchEngine = new HybridSearchEngine();
  private readonly graphSearchEngine = new GraphSearchEngine(this.app.vault, this.app.metadataCache, this.searchEngine);
  private readonly agentTools = new ObsidianAgentTools(
    this.app,
    this.indexStore,
    this.graphSearchEngine,
    () => this.settings.topK,
  );
  private readonly deepSeekClient = new DeepSeekClient(
    () => this.settings,
    () => this.indexStore.getVaultOverview(),
  );
  private realtimeIndexer: RealtimeIndexer | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();
    this.rebuildChunker();
    this.searchEngine.setChunks(this.indexStore.getAllChunks());

    this.registerView(
      CHAT_VIEW_TYPE,
      (leaf: WorkspaceLeaf) =>
        new ChatView(
          leaf,
          this.graphSearchEngine,
          this.deepSeekClient,
          this.agentTools,
          () => this.settings.topK,
          this.settings.includeContextByDefault,
          this.settings.agentModeByDefault,
        ),
    );

    this.addRibbonIcon("message-square", "Open DeepSeek RAG", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-deepseek-rag-chat",
      name: "Open DeepSeek RAG chat",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "reindex-deepseek-rag",
      name: "Re-index vault for DeepSeek RAG",
      callback: () => {
        void this.indexVault();
      },
    });

    this.addCommand({
      id: "summarize-current-note-deepseek-rag",
      name: "DeepSeek RAG: summarize current note",
      callback: () => {
        void this.runCurrentNoteTask("summarize");
      },
    });

    this.addCommand({
      id: "review-current-note-deepseek-rag",
      name: "DeepSeek RAG: review current note",
      callback: () => {
        void this.runCurrentNoteTask("review");
      },
    });

    this.addCommand({
      id: "extract-tasks-current-note-deepseek-rag",
      name: "DeepSeek RAG: extract tasks from current note",
      callback: () => {
        void this.runCurrentNoteTask("tasks");
      },
    });

    this.addCommand({
      id: "improve-current-note-deepseek-rag",
      name: "DeepSeek RAG: propose improvements to current note",
      callback: () => {
        void this.runCurrentNoteTask("improve");
      },
    });

    this.addSettingTab(new DeepSeekSettingTab(this.app, this));
    this.configureRealtimeIndexer();

    if (this.indexStore.getAllChunks().length === 0) {
      void this.indexVault().catch((error) => {
        console.error("DeepSeek RAG initial indexing failed", error);
        new Notice("DeepSeek RAG: initial indexing failed. See console for details.", 6000);
      });
    }
  }

  onunload(): void {
    this.realtimeIndexer?.stop();
    this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
  }

  async loadPluginData(): Promise<void> {
    const data = (await this.loadData()) as PluginData | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings ?? {});
    this.indexStore.load(data?.index);
  }

  async savePluginData(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      index: this.indexStore.toPersistedIndex(),
    } satisfies PluginData);
  }

  async indexVault(): Promise<void> {
    this.rebuildChunker();
    const indexed = await indexVaultFiles(this.app.vault, this.app.metadataCache, this.chunker, this.indexStore);
    this.searchEngine.setChunks(this.indexStore.getAllChunks());
    await this.savePluginData();
    new Notice(`DeepSeek RAG: indexed ${indexed.indexedFiles}/${indexed.totalFiles} files.`, 3000);
  }

  configureRealtimeIndexer(): void {
    this.realtimeIndexer?.stop();
    this.realtimeIndexer = null;

    if (!this.settings.realtimeIndexing) {
      return;
    }

    this.rebuildChunker();
    this.realtimeIndexer = new RealtimeIndexer(
      this.app.vault,
      this.app.metadataCache,
      this.chunker,
      this.indexStore,
      () => this.savePluginData(),
      () => this.searchEngine.setChunks(this.indexStore.getAllChunks()),
      (eventRef) => this.registerEvent(eventRef),
    );
    this.realtimeIndexer.start();
  }

  getIndexedChunkCount(): number {
    return this.indexStore.getAllChunks().length;
  }

  getIndexCoverage(): IndexCoverage {
    return this.indexStore.getCoverage();
  }

  private rebuildChunker(): void {
    this.chunker = new SemanticChunker(this.settings.chunkSize, this.settings.overlapSize);
  }

  private async activateView(): Promise<ChatView | null> {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    let leaf: WorkspaceLeaf | null = leaves[0] ?? null;

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice("DeepSeek RAG: could not open chat pane.", 4000);
        return null;
      }
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }

    this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof ChatView ? leaf.view : null;
  }

  private async runCurrentNoteTask(task: "summarize" | "review" | "tasks" | "improve"): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("DeepSeek RAG: no active note.", 3000);
      return;
    }

    const view = await this.activateView();
    if (!view) {
      return;
    }

    view.startAgentTask(this.buildCurrentNotePrompt(task, file.path));
  }

  private buildCurrentNotePrompt(task: "summarize" | "review" | "tasks" | "improve", path: string): string {
    const prefix = `Use openNote on "${path}" first. Treat it as the current note.`;
    switch (task) {
      case "summarize":
        return `${prefix} Summarize the note clearly, cite the file path, and mention any obvious missing context from linked notes.`;
      case "review":
        return `${prefix} Review the note for clarity, structure, contradictions, stale TODOs, and missing links. Do not edit unless I ask; give concrete suggestions with section references.`;
      case "tasks":
        return `${prefix} Extract actionable tasks from the note. Group them by urgency when possible and cite the file path. Do not edit the file.`;
      case "improve":
        return `${prefix} Propose concrete improvements to this note. If small text edits are useful, use proposePatch or proposePatchBatch so I can review them before applying.`;
    }
  }
}
