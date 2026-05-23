import { AgentToolExecution, AgentToolExecutor, McpToolCallContext, McpToolDefinition, McpToolServer, PendingEdit } from "../core/types";

type ApplyPendingEdit = (id: string) => Promise<AgentToolExecution>;
type ApplyAllPendingEdits = () => Promise<AgentToolExecution>;

export class ObsidianMcpServer implements McpToolServer {
  constructor(
    private readonly agentTools: AgentToolExecutor,
    private readonly applyPendingEdit: ApplyPendingEdit,
    private readonly applyAllPendingEdits: ApplyAllPendingEdits,
  ) {}

  listTools(context: McpToolCallContext): McpToolDefinition[] {
    return [
      ...READ_ONLY_TOOLS,
      ...(context.pendingEdits.length > 0 ? APPLY_TOOLS : []),
      ...(context.intent === "edit" ? EDIT_TOOLS : []),
    ];
  }

  async callTool(name: string, args: Record<string, unknown>, context: McpToolCallContext): Promise<AgentToolExecution> {
    if (READ_ONLY_TOOL_NAMES.has(name)) {
      return this.agentTools.execute(name, args);
    }

    if (name === "applyPendingEdit") {
      const id = typeof args.id === "string" ? args.id : "";
      if (!context.pendingEdits.some((edit) => edit.id === id)) {
        return { content: `Pending edit not found: ${id || "(missing id)"}.` };
      }
      return this.applyPendingEdit(id);
    }

    if (name === "applyAllPendingEdits") {
      if (context.pendingEdits.length === 0) {
        return { content: "There are no pending edits to apply." };
      }
      return this.applyAllPendingEdits();
    }

    if (context.intent === "edit" && EDIT_TOOL_NAMES.has(name)) {
      return this.agentTools.execute(name, args);
    }

    return { content: `Tool ${name} is not available in ${context.intent === "ask" ? "Ask" : "Edit"} mode.` };
  }
}

export function summarizePendingEdit(edit: PendingEdit): Pick<PendingEdit, "id" | "path" | "kind" | "summary"> {
  return {
    id: edit.id,
    path: edit.path,
    kind: edit.kind,
    summary: edit.summary,
  };
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const READ_ONLY_TOOLS: McpToolDefinition[] = [
  {
    name: "searchNotes",
    description: "Search indexed vault note chunks for relevant content.",
    inputSchema: objectSchema(
      {
        query: { type: "string", description: "Search query." },
        topK: { type: "number", description: "Maximum number of chunks to return." },
      },
      ["query"],
    ),
  },
  {
    name: "getCurrentNote",
    description: "Get the current active note path and metadata.",
    inputSchema: objectSchema({}),
  },
  {
    name: "openCurrentNote",
    description: "Read the current active note.",
    inputSchema: objectSchema({
      maxChars: { type: "number", description: "Maximum characters to return." },
    }),
  },
  {
    name: "openNote",
    description: "Read a specific text note or file from the vault.",
    inputSchema: objectSchema(
      {
        path: { type: "string", description: "Vault-relative file path." },
        maxChars: { type: "number", description: "Maximum characters to return." },
      },
      ["path"],
    ),
  },
  {
    name: "listFolder",
    description: "List files in a vault folder. Use an empty path for the vault root.",
    inputSchema: objectSchema({
      path: { type: "string", description: "Vault-relative folder path." },
    }),
  },
  {
    name: "getLinks",
    description: "Show outgoing links and backlinks for a file.",
    inputSchema: objectSchema(
      {
        path: { type: "string", description: "Vault-relative file path." },
      },
      ["path"],
    ),
  },
  {
    name: "getVaultOverview",
    description: "Show the current vault index overview.",
    inputSchema: objectSchema({}),
  },
];

const APPLY_TOOLS: McpToolDefinition[] = [
  {
    name: "applyPendingEdit",
    description: "Apply one already prepared pending edit. Use only when the user explicitly asks to apply that edit.",
    inputSchema: objectSchema(
      {
        id: { type: "string", description: "Pending edit id." },
      },
      ["id"],
    ),
  },
  {
    name: "applyAllPendingEdits",
    description: "Apply all already prepared pending edits. Use only when the user explicitly asks to apply all pending edits.",
    inputSchema: objectSchema({}),
  },
];

const EDIT_TOOLS: McpToolDefinition[] = [
  {
    name: "beginNewNote",
    description: "Start a pending new note draft for long content.",
    inputSchema: objectSchema(
      {
        path: { type: "string", description: "Vault-relative path for the new markdown note." },
        summary: { type: "string", description: "Short summary of the new note." },
      },
      ["path"],
    ),
  },
  {
    name: "appendNewNote",
    description: "Append one content chunk to a pending new note draft.",
    inputSchema: objectSchema(
      {
        draftId: { type: "string", description: "Draft id returned by beginNewNote." },
        content: { type: "string", description: "Markdown content chunk." },
      },
      ["draftId", "content"],
    ),
  },
  {
    name: "finishNewNote",
    description: "Convert a completed draft into a pending new note for user review.",
    inputSchema: objectSchema(
      {
        draftId: { type: "string", description: "Draft id returned by beginNewNote." },
      },
      ["draftId"],
    ),
  },
  {
    name: "proposeNewNote",
    description: "Prepare a short pending new note for user review.",
    inputSchema: objectSchema(
      {
        path: { type: "string", description: "Vault-relative path for the new markdown note." },
        summary: { type: "string", description: "Short summary of the new note." },
        content: { type: "string", description: "Full markdown note content." },
      },
      ["path", "content"],
    ),
  },
  {
    name: "proposePatch",
    description: "Prepare a small pending patch for user review.",
    inputSchema: objectSchema(
      {
        path: { type: "string", description: "Vault-relative file path." },
        summary: { type: "string", description: "Short summary of the patch." },
        find: { type: "string", description: "Exact existing text to replace." },
        replace: { type: "string", description: "Replacement text." },
      },
      ["path", "find", "replace"],
    ),
  },
  {
    name: "proposePatchBatch",
    description: "Prepare multiple pending patches for user review.",
    inputSchema: objectSchema(
      {
        summary: { type: "string", description: "Short summary of the batch." },
        patches: {
          type: "array",
          items: objectSchema(
            {
              path: { type: "string", description: "Vault-relative file path." },
              summary: { type: "string", description: "Short summary of the patch." },
              find: { type: "string", description: "Exact existing text to replace." },
              replace: { type: "string", description: "Replacement text." },
            },
            ["path", "find", "replace"],
          ),
        },
      },
      ["patches"],
    ),
  },
  {
    name: "proposeEdit",
    description: "Prepare a complete file replacement for user review.",
    inputSchema: objectSchema(
      {
        path: { type: "string", description: "Vault-relative file path." },
        summary: { type: "string", description: "Short summary of the edit." },
        newContent: { type: "string", description: "Complete replacement file content." },
      },
      ["path", "newContent"],
    ),
  },
];

const READ_ONLY_TOOL_NAMES = new Set(READ_ONLY_TOOLS.map((tool) => tool.name));
const EDIT_TOOL_NAMES = new Set(EDIT_TOOLS.map((tool) => tool.name));
