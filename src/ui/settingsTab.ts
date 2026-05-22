import { App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS } from "../core/types";
import ObsidianAIAssistantPlugin from "../main";

const PROVIDER_PRESETS = {
  custom: { name: "Custom OpenAI-compatible", apiBaseUrl: "", model: "" },
  openai: { name: "OpenAI", apiBaseUrl: "https://api.openai.com", model: "gpt-4o-mini" },
  deepseek: { name: "DeepSeek", apiBaseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  openrouter: { name: "OpenRouter", apiBaseUrl: "https://openrouter.ai/api", model: "openai/gpt-4o-mini" },
  lmstudio: { name: "LM Studio", apiBaseUrl: "http://localhost:1234", model: "local-model" },
  ollama: { name: "Ollama", apiBaseUrl: "http://localhost:11434", model: "llama3.1" },
} as const;

type ProviderPreset = keyof typeof PROVIDER_PRESETS;

export class ObsidianAIAssistantSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ObsidianAIAssistantPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Vault Chat Assistant" });

    new Setting(containerEl)
      .setName("Provider preset")
      .setDesc("Sets a base URL and starter model for common OpenAI-compatible providers.")
      .addDropdown((dropdown) => {
        for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
          dropdown.addOption(key, preset.name);
        }
        dropdown.setValue(detectProviderPreset(this.plugin.settings.apiBaseUrl));
        dropdown.onChange(async (value) => {
          const preset = PROVIDER_PRESETS[value as ProviderPreset];
          if (!preset || value === "custom") {
            return;
          }
          this.plugin.settings.apiBaseUrl = preset.apiBaseUrl;
          this.plugin.settings.model = preset.model;
          await this.plugin.savePluginData();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Stored in Obsidian plugin data on this device. Local providers can leave this empty.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("API key")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Any model accepted by your configured OpenAI-compatible provider.")
      .addText((text) =>
        text.setValue(this.plugin.settings.model).onChange(async (value) => {
          this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
          await this.plugin.savePluginData();
        }),
      );

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("OpenAI-compatible base URL. The plugin calls /v1/chat/completions.")
      .addText((text) =>
        text.setValue(this.plugin.settings.apiBaseUrl).onChange(async (value) => {
          this.plugin.settings.apiBaseUrl = value.trim() || DEFAULT_SETTINGS.apiBaseUrl;
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

function detectProviderPreset(apiBaseUrl: string): ProviderPreset {
  const normalized = apiBaseUrl.replace(/\/$/, "");
  for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (preset.apiBaseUrl && preset.apiBaseUrl === normalized) {
      return key as ProviderPreset;
    }
  }
  return "custom";
}
