import { AgentCompletion, ChatIntent, DebugLogEntry, McpToolCallContext, McpToolDefinition, McpToolServer, ObsidianAIAssistantSettings, PendingEdit, SearchResult, WorkingSetItem } from "../core/types";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ModelToolCall[];
}

interface ModelToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ModelAssistantMessage {
  role: "assistant";
  content?: string | null;
  tool_calls?: ModelToolCall[];
}

type DebugLogger = (entry: DebugLogEntry) => void;

export class AIChatClient {
  constructor(
    private readonly getSettings: () => ObsidianAIAssistantSettings,
    private readonly getVaultOverview: () => string,
  ) {}

  async completeWithAgent(
    userMessage: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    mcpServer: McpToolServer,
    intent: ChatIntent,
    logDebug?: DebugLogger,
    context: McpToolCallContext = { intent, pendingEdits: [] },
  ): Promise<AgentCompletion> {
    const messages: ChatMessage[] = [
      { role: "system", content: this.buildAgentSystemPrompt(intent, context.pendingEdits) },
      ...history.slice(-8).map((message) => ({ role: message.role, content: message.content }) satisfies ChatMessage),
      { role: "user", content: userMessage },
    ];
    const toolDefinitions = mcpServer.listTools(context);
    const sources = new Map<string, SearchResult>();
    const pendingEdits: PendingEdit[] = [];
    const workingSet = new Map<string, WorkingSetItem>();

    emitDebug(logDebug, "agent-start", `Started ${intent} request`, {
      intent,
      userMessage,
      historyLength: history.length,
      context,
      tools: toolDefinitions.map((tool) => tool.name),
      messages,
    });

    for (let step = 0; step < 30; step += 1) {
      const assistantMessage = await this.requestCompletion(messages, toolDefinitions, 8000, logDebug, step + 1);
      const toolCalls = assistantMessage.tool_calls ?? [];
      const content = assistantMessage.content?.trim() ?? "";

      if (toolCalls.length === 0) {
        emitDebug(logDebug, "agent-final", "Model returned final answer", {
          step: step + 1,
          answer: content,
          sources: Array.from(sources.values()),
          pendingEdits,
          workingSet: Array.from(workingSet.values()),
        });
        return { answer: content, sources: Array.from(sources.values()), pendingEdits, workingSet: Array.from(workingSet.values()) };
      }

      messages.push({
        role: "assistant",
        content: assistantMessage.content ?? null,
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        const args = parseToolArguments(toolCall.function.arguments);
        emitDebug(logDebug, "tool-call", `Calling ${toolCall.function.name}`, {
          step: step + 1,
          toolCall,
          args,
        });

        const result = await mcpServer.callTool(toolCall.function.name, args, context);
        emitDebug(logDebug, "tool-result", `Tool result from ${toolCall.function.name}`, {
          step: step + 1,
          tool: toolCall.function.name,
          result,
        });

        for (const source of result.sources ?? []) {
          sources.set(source.chunk.id, source);
          mergeWorkingSetItem(workingSet, {
            path: source.chunk.filePath,
            role: "searched",
            detail: `Used by ${toolCall.function.name}`,
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
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(summarizeToolResult(result)),
        });
      }
    }

    messages.push({
      role: "user",
      content:
        pendingEdits.length > 0
          ? "Stop using tools and summarize the pending edits now."
          : "Stop using tools and provide the best final answer now. If you were creating a long note and have not finished it, say it was not completed.",
    });
    const finalMessage = await this.requestCompletion(messages, toolDefinitions, 1800, logDebug, 31);
    const answer = finalMessage.content?.trim() ?? "";
    emitDebug(logDebug, "agent-final", "Agent stopped after step limit", {
      answer,
      sources: Array.from(sources.values()),
      pendingEdits,
      workingSet: Array.from(workingSet.values()),
    });
    return { answer, sources: Array.from(sources.values()), pendingEdits, workingSet: Array.from(workingSet.values()) };
  }

  private async requestCompletion(messages: ChatMessage[], toolDefinitions: McpToolDefinition[], maxTokens: number, logDebug?: DebugLogger, step?: number): Promise<ModelAssistantMessage> {
    const settings = this.getSettings();
    if (this.requiresApiKey(settings) && !settings.apiKey.trim()) {
      emitDebug(logDebug, "model-error", "Request blocked because the API key is not configured", {
        step,
        apiBaseUrl: settings.apiBaseUrl,
        model: settings.model,
      });
      throw new Error("AI provider API key is not configured.");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (settings.apiKey.trim()) {
      headers.Authorization = `Bearer ${settings.apiKey}`;
    }

    const url = `${settings.apiBaseUrl.replace(/\/$/, "")}/v1/chat/completions`;
    const startedAt = Date.now();
    const requestBody = {
      model: settings.model,
      messages,
      tools: toolDefinitions.map(toOpenAiTool),
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: maxTokens,
      stream: false,
    };
    emitDebug(logDebug, "model-request", `Request ${step ?? "?"} to ${settings.model}`, {
      step,
      url,
      body: requestBody,
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      emitDebug(logDebug, "model-error", `Request ${step ?? "?"} failed before a response`, {
        step,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      });
      throw error;
    }

    if (!response.ok) {
      const errorText = await response.text();
      emitDebug(logDebug, "model-error", `Request ${step ?? "?"} failed with ${response.status}`, {
        step,
        status: response.status,
        durationMs: Date.now() - startedAt,
        errorText,
      });
      throw new Error(`AI provider request failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const message = data?.choices?.[0]?.message;
    if (!isAssistantMessage(message)) {
      emitDebug(logDebug, "model-error", `Request ${step ?? "?"} returned an unexpected response`, {
        step,
        durationMs: Date.now() - startedAt,
        response: data,
      });
      throw new Error("AI provider returned an unexpected response.");
    }

    emitDebug(logDebug, "model-response", `Response ${step ?? "?"} from ${settings.model}`, {
      step,
      status: response.status,
      durationMs: Date.now() - startedAt,
      message,
      response: data,
    });

    return message;
  }

  private requiresApiKey(settings: ObsidianAIAssistantSettings): boolean {
    try {
      const url = new URL(settings.apiBaseUrl);
      return !["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname);
    } catch {
      return true;
    }
  }

  private buildAgentSystemPrompt(intent: ChatIntent, pendingEdits: McpToolCallContext["pendingEdits"]): string {
    const customSystemPrompt = this.getSettings().systemPrompt.trim();
    const editPolicy =
      intent === "edit"
        ? [
            "You may propose file creation or edits with available edit tools.",
            "You cannot directly apply newly proposed edits. Proposed edits stay pending until the user reviews or explicitly asks to apply them.",
            "For long new notes, use beginNewNote, then appendNewNote with chunks under 2000 characters each, then finishNewNote.",
            "Use proposeNewNote only for short new notes.",
            "Prefer proposePatch for one normal edit and proposePatchBatch for multiple normal edits. Use proposeEdit only when the user asks to rewrite a full file or the patch would be larger than the original file.",
            "Before proposePatch, proposePatchBatch, or proposeEdit, open each target file unless the exact current content is already available in the conversation.",
            "For proposePatch and proposePatchBatch, every find must be an exact substring from the current file and specific enough to match once.",
            "For proposeEdit, newContent must be the complete replacement content for the file, not a partial patch.",
          ]
        : [
            "You are in Ask mode. Do not propose new pending edits.",
            "If the user asks for file changes, explain what you would change and ask them to switch to Edit mode.",
          ];

    return [
      "You are an AI agent inside Obsidian.",
      intent === "edit" ? "You can inspect the user's vault and propose reviewed file edits with tools before answering." : "You can inspect the user's vault with read-only tools before answering.",
      "Use tools when the answer needs more context than the current conversation.",
      "Cite file paths when using vault content.",
      "If the vault does not contain enough information, say so clearly.",
      "Do not say you will inspect, search, open, create, patch, or edit something later. If that action is needed, call a tool in the same response.",
      "Apply existing pending edits only when the user explicitly asks to apply them.",
      ...editPolicy,
      ...(pendingEdits.length > 0
        ? [
            "",
            "Current pending edits:",
            ...pendingEdits.map((edit, index) => `${index + 1}. id=${edit.id}; kind=${edit.kind}; path=${edit.path}; summary=${edit.summary}`),
          ]
        : []),
      ...(customSystemPrompt ? ["", "Additional user instructions:", customSystemPrompt] : []),
      "",
      "VAULT INDEX OVERVIEW:",
      this.getVaultOverview(),
    ].join("\n");
  }
}

function toOpenAiTool(tool: McpToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function parseToolArguments(rawArguments: string): Record<string, unknown> {
  if (!rawArguments.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function summarizeToolResult(result: {
  content: string;
  sources?: SearchResult[];
  pendingEdit?: PendingEdit;
  pendingEdits?: PendingEdit[];
  workingSetItems?: WorkingSetItem[];
}): Record<string, unknown> {
  return {
    content: result.content,
    sources: result.sources?.map((source) => ({
      path: source.chunk.filePath,
      score: source.score,
      snippet: source.chunk.content.slice(0, 1200),
    })),
    pendingEdit: result.pendingEdit ? summarizePendingEdit(result.pendingEdit) : undefined,
    pendingEdits: result.pendingEdits?.map(summarizePendingEdit),
    workingSetItems: result.workingSetItems,
  };
}

function summarizePendingEdit(edit: PendingEdit): Pick<PendingEdit, "id" | "path" | "kind" | "summary"> {
  return {
    id: edit.id,
    path: edit.path,
    kind: edit.kind,
    summary: edit.summary,
  };
}

function isAssistantMessage(value: unknown): value is ModelAssistantMessage {
  if (!isRecord(value) || value.role !== "assistant") {
    return false;
  }
  return typeof value.content === "string" || value.content === null || typeof value.content === "undefined";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitDebug(logDebug: DebugLogger | undefined, type: DebugLogEntry["type"], summary: string, data: unknown): void {
  if (!logDebug) {
    return;
  }

  logDebug({
    id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    type,
    summary,
    data,
  });
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
