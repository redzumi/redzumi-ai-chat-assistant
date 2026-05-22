import { AgentCompletion, AgentToolExecutor, ObsidianAIAssistantSettings, PendingEdit, SearchResult, WorkingSetItem } from "../core/types";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class AIChatClient {
  constructor(
    private readonly getSettings: () => ObsidianAIAssistantSettings,
    private readonly getVaultOverview: () => string,
  ) {}

  async complete(userMessage: string, history: ChatMessage[], context: SearchResult[]): Promise<string> {
    const settings = this.getSettings();
    if (this.requiresApiKey(settings) && !settings.apiKey.trim()) {
      throw new Error("AI provider API key is not configured.");
    }

    const content = await this.requestCompletion([
      { role: "system", content: this.buildSystemPrompt(context) },
      ...history.slice(-12),
      { role: "user", content: userMessage },
    ], 1800);

    return content.trim();
  }

  async completeWithAgent(userMessage: string, history: ChatMessage[], tools: AgentToolExecutor): Promise<AgentCompletion> {
    const messages: ChatMessage[] = [
      { role: "system", content: this.buildAgentSystemPrompt() },
      ...history.slice(-8),
      { role: "user", content: userMessage },
    ];
    const sources = new Map<string, SearchResult>();
    const pendingEdits: PendingEdit[] = [];
    const workingSet = new Map<string, WorkingSetItem>();

    for (let step = 0; step < 5; step += 1) {
      const content = await this.requestCompletion(messages, 4000);
      const action = parseAgentAction(content);

      if (action.final) {
        return { answer: action.final.trim(), sources: Array.from(sources.values()), pendingEdits, workingSet: Array.from(workingSet.values()) };
      }

      if (!action.tool) {
        return { answer: content.trim(), sources: Array.from(sources.values()), pendingEdits, workingSet: Array.from(workingSet.values()) };
      }

      messages.push({ role: "assistant", content });
      const result = await tools.execute(action.tool, action.args ?? {});
      for (const source of result.sources ?? []) {
        sources.set(source.chunk.id, source);
        mergeWorkingSetItem(workingSet, {
          path: source.chunk.filePath,
          role: "searched",
          detail: `Used by ${action.tool}`,
        });
      }
      if (result.pendingEdit) {
        pendingEdits.push(result.pendingEdit);
      }
      for (const pendingEdit of result.pendingEdits ?? []) {
        pendingEdits.push(pendingEdit);
      }
      for (const item of result.workingSetItems ?? []) {
        mergeWorkingSetItem(workingSet, item);
      }
      messages.push({
        role: "user",
        content: [
          `Tool result for ${action.tool}:`,
          result.content,
          "",
          "Continue. Use another tool if needed, or return final JSON.",
        ].join("\n"),
      });
    }

    messages.push({
      role: "user",
      content: "Stop using tools and provide the best final answer now as JSON: {\"final\":\"...\"}.",
    });
    const finalContent = await this.requestCompletion(messages, 1800);
    const finalAction = parseAgentAction(finalContent);
    return { answer: (finalAction.final ?? finalContent).trim(), sources: Array.from(sources.values()), pendingEdits, workingSet: Array.from(workingSet.values()) };
  }

  private async requestCompletion(messages: ChatMessage[], maxTokens: number): Promise<string> {
    const settings = this.getSettings();
    if (this.requiresApiKey(settings) && !settings.apiKey.trim()) {
      throw new Error("AI provider API key is not configured.");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (settings.apiKey.trim()) {
      headers.Authorization = `Bearer ${settings.apiKey}`;
    }

    const response = await fetch(`${settings.apiBaseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: 0.2,
        max_tokens: maxTokens,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI provider request failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("AI provider returned an unexpected response.");
    }

    return content.trim();
  }

  private requiresApiKey(settings: ObsidianAIAssistantSettings): boolean {
    try {
      const url = new URL(settings.apiBaseUrl);
      return !["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname);
    } catch {
      return true;
    }
  }

  private buildAgentSystemPrompt(): string {
    return [
      "You are an AI agent inside Obsidian.",
      "You can inspect the user's vault and propose file edits with tools before answering.",
      "You cannot directly apply edits. All edits are pending until the user reviews and applies them.",
      "Use tools when the answer needs more context than the current conversation.",
      "Cite file paths when using vault content.",
      "If the vault does not contain enough information, say so clearly.",
      "",
      "Available tools:",
      "- searchNotes: args {\"query\":\"...\",\"topK\":6}. Search indexed chunks.",
      "- getCurrentNote: args {}. Get the current active note path and metadata.",
      "- openCurrentNote: args {\"maxChars\":6000}. Read the current active note.",
      "- openNote: args {\"path\":\"...\",\"maxChars\":6000}. Read a specific text note/file.",
      "- listFolder: args {\"path\":\"...\"}. List files in a folder. Use empty path for vault root.",
      "- getLinks: args {\"path\":\"...\"}. Show outgoing links and backlinks for a file.",
      "- getVaultOverview: args {}. Show the current vault index overview.",
      "- proposePatch: args {\"path\":\"...\",\"summary\":\"...\",\"find\":\"exact existing text\",\"replace\":\"replacement text\"}. Prepare a small pending patch for user review.",
      "- proposePatchBatch: args {\"summary\":\"...\",\"patches\":[{\"path\":\"...\",\"summary\":\"...\",\"find\":\"exact existing text\",\"replace\":\"replacement text\"}]}. Prepare multiple pending patches for user review.",
      "- proposeEdit: args {\"path\":\"...\",\"summary\":\"...\",\"newContent\":\"full replacement file content\"}. Prepare a pending edit for user review.",
      "",
      "Prefer proposePatch for one normal edit and proposePatchBatch for multiple normal edits. Use proposeEdit only when the user asks to rewrite a full file or the patch would be larger than the original file.",
      "Before proposePatch, proposePatchBatch, or proposeEdit, open each target file unless the exact current content is already available in the conversation.",
      "For proposePatch and proposePatchBatch, every find must be an exact substring from the current file and specific enough to match once.",
      "For proposeEdit, newContent must be the complete replacement content for the file, not a partial patch.",
      "",
      "Respond with exactly one JSON object and no markdown.",
      "To call a tool: {\"tool\":\"searchNotes\",\"args\":{\"query\":\"project plan\",\"topK\":6},\"reason\":\"...\"}",
      "To answer finally: {\"final\":\"Your answer with cited file paths and mention any pending edits.\"}",
      "",
      "VAULT INDEX OVERVIEW:",
      this.getVaultOverview(),
    ].join("\n");
  }

  private buildSystemPrompt(context: SearchResult[]): string {
    if (context.length === 0) {
      return [
        "You are a helpful assistant inside Obsidian.",
        "Use the vault index overview to understand what the user's storage contains.",
        "Answer plainly and say when the indexed notes do not provide enough context.",
        "",
        "VAULT INDEX OVERVIEW:",
        this.getVaultOverview(),
      ].join("\n");
    }

    const sources = context
      .map((result, index) => {
        const chunk = result.chunk;
        const heading = chunk.headings.length ? `\nSection: ${chunk.headings.join(" > ")}` : "";
        return `[${index + 1}] ${chunk.filePath}${heading}\n${chunk.content}`;
      })
      .join("\n\n---\n\n");

    return [
      "You are a helpful assistant inside Obsidian.",
      "Use the vault index overview to understand the shape of the user's storage.",
      "Use the note context below when it is relevant.",
      "Cite file paths when using note content.",
      "If the answer is not supported by the notes, say so clearly.",
      "",
      "VAULT INDEX OVERVIEW:",
      this.getVaultOverview(),
      "",
      "NOTE CONTEXT:",
      sources,
    ].join("\n");
  }
}

interface AgentAction {
  tool?: string;
  args?: Record<string, unknown>;
  final?: string;
}

function parseAgentAction(content: string): AgentAction {
  const jsonText = extractJsonObject(content);
  if (!jsonText) {
    return {};
  }

  try {
    const parsed = JSON.parse(jsonText) as AgentAction;
    return {
      tool: typeof parsed.tool === "string" ? parsed.tool : undefined,
      args: isRecord(parsed.args) ? parsed.args : undefined,
      final: typeof parsed.final === "string" ? parsed.final : undefined,
    };
  } catch {
    return {};
  }
}

function extractJsonObject(content: string): string | null {
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(content);
  if (fenced) {
    return fenced[1];
  }

  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  return start >= 0 && end > start ? content.slice(start, end + 1) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeWorkingSetItem(workingSet: Map<string, WorkingSetItem>, item: WorkingSetItem): void {
  const key = `${item.path}:${item.role}`;
  const existing = workingSet.get(key);
  if (!existing) {
    workingSet.set(key, item);
    return;
  }

  if (!existing.detail.includes(item.detail)) {
    workingSet.set(key, { ...existing, detail: `${existing.detail}; ${item.detail}` });
  }
}
