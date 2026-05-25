import { App, Notice, PluginSettingTab, Setting, SuggestModal } from "obsidian";
import { DEFAULT_SETTINGS, SavedPrompt } from "../core/types";
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

    containerEl.createEl("h2", { text: "Vault Chat Agent" });

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
      .addText((text) => {
        text.setValue(this.plugin.settings.model).onChange(async (value) => {
          this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
          await this.plugin.savePluginData();
        });
      })
      .addButton((button) =>
        button.setButtonText("Browse").onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Loading...");
          try {
            const models = await fetchProviderModels(this.plugin.settings);
            if (models.length === 0) {
              new Notice("Vault Chat Agent: provider returned no models.", 4000);
              return;
            }
            new ModelPickerModal(this.app, models, async (model) => {
              this.plugin.settings.model = model;
              await this.plugin.savePluginData();
              this.display();
            }).open();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Vault Chat Agent: could not load models. ${message}`, 7000);
          } finally {
            button.setDisabled(false);
            button.setButtonText("Browse");
          }
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
      .setName("Default chat intent")
      .setDesc("Choose whether new chat panes start in read-only Ask or reviewed Edit.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("ask", "Ask")
          .addOption("edit", "Edit")
          .setValue(this.plugin.settings.defaultIntent)
          .onChange(async (value) => {
            this.plugin.settings.defaultIntent = value === "edit" ? "edit" : "ask";
            await this.plugin.savePluginData();
          }),
      );

    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Extra instructions added to every chat. Use this to set tone, assumptions, and explanation style.")
      .addTextArea((text) => {
        text.inputEl.rows = 5;
        text.inputEl.addClass("vault-chat-agent-system-prompt-input");
        text
          .setPlaceholder(DEFAULT_SETTINGS.systemPrompt)
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Strip reasoning blocks")
      .setDesc("Remove <think>, <reasoning>, and <thought> blocks from assistant output.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.stripReasoningBlocks).onChange(async (value) => {
          this.plugin.settings.stripReasoningBlocks = value;
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

    containerEl.createEl("h3", { text: "Saved prompts" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Reusable prompts for the Prompt: run saved prompt command. Edit prompts can propose reviewed patches; Ask prompts only answer in chat.",
    });

    new Setting(containerEl)
      .setName("Add saved prompt")
      .setDesc("Create a prompt that can be run from the command palette.")
      .addButton((button) =>
        button
          .setButtonText("Add prompt")
          .setCta()
          .onClick(async () => {
            this.plugin.settings.savedPrompts = [
              ...this.plugin.settings.savedPrompts,
              createSavedPrompt(),
            ];
            await this.plugin.savePluginData();
            this.display();
          }),
      );

    for (const prompt of this.plugin.settings.savedPrompts) {
      new Setting(containerEl)
        .setName("Saved prompt")
        .setDesc(prompt.id)
        .addText((text) =>
          text
            .setPlaceholder("Prompt title")
            .setValue(prompt.title)
            .onChange(async (value) => {
              prompt.title = value;
              await this.plugin.savePluginData();
            }),
        )
        .addDropdown((dropdown) =>
          dropdown
            .addOption("ask", "Ask")
            .addOption("edit", "Edit")
            .setValue(prompt.intent)
            .onChange(async (value) => {
              prompt.intent = value === "edit" ? "edit" : "ask";
              await this.plugin.savePluginData();
            }),
        )
        .addButton((button) =>
          button
            .setButtonText("Delete")
            .setWarning()
            .onClick(async () => {
              this.plugin.settings.savedPrompts = this.plugin.settings.savedPrompts.filter((item) => item.id !== prompt.id);
              await this.plugin.savePluginData();
              this.display();
            }),
        );

      new Setting(containerEl)
        .setName("Prompt text")
        .setDesc("Instructions to run against the current selection or active note.")
        .addTextArea((text) => {
          text.inputEl.rows = 4;
          text.inputEl.addClass("vault-chat-agent-saved-prompt-input");
          text
            .setPlaceholder("Example: Rewrite this as concise meeting notes.")
            .setValue(prompt.prompt)
            .onChange(async (value) => {
              prompt.prompt = value;
              await this.plugin.savePluginData();
            });
        });
    }

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

function createSavedPrompt(): SavedPrompt {
  return {
    id: `prompt:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    title: "New prompt",
    prompt: "",
    intent: "ask",
  };
}

class ModelPickerModal extends SuggestModal<string> {
  constructor(
    app: App,
    private readonly models: string[],
    private readonly onChoose: (model: string) => Promise<void>,
  ) {
    super(app);
    this.setPlaceholder("Search provider models...");
  }

  getSuggestions(query: string): string[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) {
      return this.models.slice(0, 100);
    }
    return this.models.filter((model) => model.toLocaleLowerCase().includes(normalized)).slice(0, 100);
  }

  renderSuggestion(model: string, el: HTMLElement): void {
    el.setText(model);
  }

  onChooseSuggestion(model: string): void {
    void this.onChoose(model);
  }
}

async function fetchProviderModels(settings: { apiBaseUrl: string; apiKey: string }): Promise<string[]> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (settings.apiKey.trim()) {
    headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
  }

  const response = await fetch(`${settings.apiBaseUrl.replace(/\/$/, "")}/v1/models`, {
    method: "GET",
    headers,
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Request failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as unknown;
  const models = parseModelIds(data);
  return Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
}

function parseModelIds(data: unknown): string[] {
  if (!isRecord(data)) {
    return [];
  }
  const rawModels = data.data;
  if (!Array.isArray(rawModels)) {
    return [];
  }
  return rawModels.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    return typeof item.id === "string" && item.id.trim() ? [item.id.trim()] : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
