import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { SemanticChunker } from "./core/chunker";
import { IndexStore } from "./core/indexStore";
import { DEFAULT_SETTINGS, DeepSeekRagSettings, PersistedIndex } from "./core/types";
import { indexAllMarkdownFiles } from "./indexing/indexAll";
import { RealtimeIndexer } from "./indexing/realtimeIndexer";
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
  private readonly deepSeekClient = new DeepSeekClient(() => this.settings);
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
          this.searchEngine,
          this.deepSeekClient,
          () => this.settings.topK,
          this.settings.includeContextByDefault,
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
      name: "Re-index notes for DeepSeek RAG",
      callback: () => {
        void this.indexAllNotes();
      },
    });

    this.addSettingTab(new DeepSeekSettingTab(this.app, this));
    this.configureRealtimeIndexer();

    if (this.indexStore.getAllChunks().length === 0) {
      void this.indexAllNotes().catch((error) => {
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

  async indexAllNotes(): Promise<void> {
    this.rebuildChunker();
    const indexed = await indexAllMarkdownFiles(this.app.vault, this.chunker, this.indexStore);
    this.searchEngine.setChunks(this.indexStore.getAllChunks());
    await this.savePluginData();
    new Notice(`DeepSeek RAG: indexed ${indexed} notes.`, 3000);
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

  private rebuildChunker(): void {
    this.chunker = new SemanticChunker(this.settings.chunkSize, this.settings.overlapSize);
  }

  private async activateView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    let leaf: WorkspaceLeaf | null = leaves[0] ?? null;

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice("DeepSeek RAG: could not open chat pane.", 4000);
        return;
      }
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }

    this.app.workspace.revealLeaf(leaf);
  }
}
