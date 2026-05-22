import { App, PluginSettingTab, Setting } from "obsidian";
import DeepSeekRAGPlugin from "../main";

export class DeepSeekSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: DeepSeekRAGPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "DeepSeek RAG" });

    new Setting(containerEl)
      .setName("DeepSeek API key")
      .setDesc("Stored in Obsidian plugin data on this device.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Chat model used for answers.")
      .addText((text) =>
        text.setValue(this.plugin.settings.model).onChange(async (value) => {
          this.plugin.settings.model = value.trim() || "deepseek-chat";
          await this.plugin.savePluginData();
        }),
      );

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("Change only if you use a compatible proxy.")
      .addText((text) =>
        text.setValue(this.plugin.settings.apiBaseUrl).onChange(async (value) => {
          this.plugin.settings.apiBaseUrl = value.trim() || "https://api.deepseek.com";
          await this.plugin.savePluginData();
        }),
      );

    new Setting(containerEl)
      .setName("Chunk size")
      .setDesc("Approximate maximum characters per indexed chunk.")
      .addSlider((slider) =>
        slider
          .setLimits(300, 2400, 100)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.chunkSize)
          .onChange(async (value) => {
            this.plugin.settings.chunkSize = value;
            await this.plugin.savePluginData();
          }),
      );

    new Setting(containerEl)
      .setName("Overlap")
      .setDesc("Characters carried between neighboring chunks.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 500, 25)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.overlapSize)
          .onChange(async (value) => {
            this.plugin.settings.overlapSize = value;
            await this.plugin.savePluginData();
          }),
      );

    new Setting(containerEl)
      .setName("Search results")
      .setDesc("Number of note chunks sent as context.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 12, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.topK)
          .onChange(async (value) => {
            this.plugin.settings.topK = value;
            await this.plugin.savePluginData();
          }),
      );

    new Setting(containerEl)
      .setName("Include context by default")
      .setDesc("New chat panes will search notes before sending a message.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeContextByDefault).onChange(async (value) => {
          this.plugin.settings.includeContextByDefault = value;
          await this.plugin.savePluginData();
        }),
      );

    new Setting(containerEl)
      .setName("Agent mode by default")
      .setDesc("New chat panes can inspect the vault and prepare edits for review before answering.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.agentModeByDefault).onChange(async (value) => {
          this.plugin.settings.agentModeByDefault = value;
          await this.plugin.savePluginData();
        }),
      );

    new Setting(containerEl)
      .setName("Realtime indexing")
      .setDesc("Update the local index when vault files change.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.realtimeIndexing).onChange(async (value) => {
          this.plugin.settings.realtimeIndexing = value;
          await this.plugin.savePluginData();
          this.plugin.configureRealtimeIndexer();
        }),
      );

    containerEl.createEl("h3", { text: "Index" });
    const coverage = this.plugin.getIndexCoverage();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: [
        `${coverage.totalFiles} files tracked.`,
        `${coverage.indexedFiles} indexed with text.`,
        `${coverage.metadataOnlyFiles} metadata-only.`,
        `${coverage.errorFiles} errors.`,
        `${coverage.chunkCount} chunks.`,
      ].join(" "),
    });

    new Setting(containerEl)
      .setName("Re-index vault")
      .setDesc("Rebuilds the local index from supported vault files.")
      .addButton((button) =>
        button
          .setButtonText("Re-index")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("Indexing...");
            try {
              await this.plugin.indexVault();
            } finally {
              button.setDisabled(false);
              this.display();
            }
          }),
      );
  }
}
