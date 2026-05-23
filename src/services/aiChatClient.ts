import { AgentCompletion, AgentToolExecutor, ChatIntent, ObsidianAIAssistantSettings, PendingEdit, SearchResult, WorkingSetItem } from "../core/types";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class AIChatClient {
  constructor(
    private readonly getSettings: () => ObsidianAIAssistantSettings,
    private readonly getVaultOverview: () => string,
  ) {}

  async completeWithAgent(userMessage: string, history: ChatMessage[], tools: AgentToolExecutor, intent: ChatIntent): Promise<AgentCompletion> {
    const messages: ChatMessage[] = [
      { role: "system", content: this.buildAgentSystemPrompt(intent) },
      ...history.slice(-8),
      { role: "user", content: userMessage },
    ];
    const sources = new Map<string, SearchResult>();
    const pendingEdits: PendingEdit[] = [];
    const workingSet = new Map<string, WorkingSetItem>();

    for (let step = 0; step < 5; step += 1) {
      const content = await this.requestCompletion(messages, 8000);
      const action = parseAgentAction(content);

      if (action.final) {
        return { answer: action.final.trim(), sources: Array.from(sources.values()), pendingEdits, workingSet: Array.from(workingSet.values()) };
      }

      if (!action.tool) {
        if (action.malformedJson || action.unsupportedJson) {
          messages.push({ role: "assistant", content });
          messages.push({
            role: "user",
            content: [
              "Your previous response was not a valid action.",
              action.malformedJson ? "It looked like malformed or truncated JSON." : "It was valid JSON, but it did not contain a supported tool or final field.",
              "Return exactly one supported JSON object.",
              intent === "edit"
                ? "For creating a new note, use {\"tool\":\"proposeNewNote\",\"args\":{\"path\":\"folder/name.md\",\"summary\":\"...\",\"content\":\"...\"}}."
                : "In Ask mode, answer with {\"final\":\"...\"} and do not prepare edits.",
            ].join("\n"),
          });
          continue;
        }
        return { answer: content.trim(), sources: Array.from(sources.values()), pendingEdits, workingSet: Array.from(workingSet.values()) };
      }

      messages.push({ role: "assistant", content });
      if (!isToolAllowed(action.tool, intent)) {
        messages.push({
          role: "user",
          content: [
            `Tool ${action.tool} is not available in ${intent === "ask" ? "Ask" : "Edit"} mode.`,
            intent === "ask" ? "Answer without preparing edits. If file changes are needed, tell the user to switch to Edit." : "Use one of the available tools.",
          ].join("\n"),
        });
        continue;
      }

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

  private buildAgentSystemPrompt(intent: ChatIntent): string {
    const editTools =
      intent === "edit"
        ? [
            "- proposeNewNote: args {\"path\":\"folder/name.md\",\"summary\":\"...\",\"content\":\"full note content\"}. Prepare a pending new note for user review.",
            "- proposePatch: args {\"path\":\"...\",\"summary\":\"...\",\"find\":\"exact existing text\",\"replace\":\"replacement text\"}. Prepare a small pending patch for user review.",
            "- proposePatchBatch: args {\"summary\":\"...\",\"patches\":[{\"path\":\"...\",\"summary\":\"...\",\"find\":\"exact existing text\",\"replace\":\"replacement text\"}]}. Prepare multiple pending patches for user review.",
            "- proposeEdit: args {\"path\":\"...\",\"summary\":\"...\",\"newContent\":\"full replacement file content\"}. Prepare a pending edit for user review.",
          ]
        : [];
    const editPolicy =
      intent === "edit"
        ? [
            "You may propose file creation or edits only with proposeNewNote, proposePatch, proposePatchBatch, or proposeEdit.",
            "Use proposeNewNote when the user asks to create a new note or file.",
            "Prefer proposePatch for one normal edit and proposePatchBatch for multiple normal edits. Use proposeEdit only when the user asks to rewrite a full file or the patch would be larger than the original file.",
            "Before proposePatch, proposePatchBatch, or proposeEdit, open each target file unless the exact current content is already available in the conversation.",
            "For proposePatch and proposePatchBatch, every find must be an exact substring from the current file and specific enough to match once.",
            "For proposeEdit, newContent must be the complete replacement content for the file, not a partial patch.",
          ]
        : [
            "You are in Ask mode. Do not propose pending edits and do not call edit tools.",
            "If the user asks for file changes, explain what you would change and ask them to switch to Edit mode.",
          ];

    return [
      "You are an AI agent inside Obsidian.",
      intent === "edit" ? "You can inspect the user's vault and propose file edits with tools before answering." : "You can inspect the user's vault with read-only tools before answering.",
      intent === "edit" ? "You cannot directly apply edits. All edits are pending until the user reviews and applies them." : "You cannot prepare or apply edits in Ask mode.",
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
      ...editTools,
      "",
      ...editPolicy,
      "",
      "Respond with exactly one JSON object and no markdown.",
      "To call a tool: {\"tool\":\"searchNotes\",\"args\":{\"query\":\"project plan\",\"topK\":6},\"reason\":\"...\"}",
      intent === "edit" ? "To create a note: {\"tool\":\"proposeNewNote\",\"args\":{\"path\":\"folder/name.md\",\"summary\":\"Create note\",\"content\":\"# Title\\n...\"},\"reason\":\"...\"}" : "",
      "To answer finally: {\"final\":\"Your answer with cited file paths and mention any pending edits.\"}",
      "",
      "VAULT INDEX OVERVIEW:",
      this.getVaultOverview(),
    ].join("\n");
  }

}

const READ_ONLY_TOOLS = new Set(["searchNotes", "getCurrentNote", "openCurrentNote", "openNote", "listFolder", "getLinks", "getVaultOverview"]);
const EDIT_TOOLS = new Set(["proposeNewNote", "proposePatch", "proposePatchBatch", "proposeEdit"]);

function isToolAllowed(toolName: string, intent: ChatIntent): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) {
    return true;
  }
  return intent === "edit" && EDIT_TOOLS.has(toolName);
}

interface AgentAction {
  tool?: string;
  args?: Record<string, unknown>;
  final?: string;
  malformedJson?: boolean;
  unsupportedJson?: boolean;
}

function parseAgentAction(content: string): AgentAction {
  const jsonText = extractJsonObject(content);
  if (!jsonText) {
    return looksLikeJson(content) ? { malformedJson: true } : {};
  }

  try {
    const parsed = JSON.parse(jsonText) as AgentAction;
    const action = {
      tool: typeof parsed.tool === "string" ? parsed.tool : undefined,
      args: isRecord(parsed.args) ? parsed.args : undefined,
      final: typeof parsed.final === "string" ? parsed.final : undefined,
    };
    return action.tool || action.final ? action : { unsupportedJson: true };
  } catch {
    return { malformedJson: true };
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

function looksLikeJson(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("```json") || trimmed.startsWith("```");
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
