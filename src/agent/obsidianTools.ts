import { App, TFile, TFolder } from "obsidian";
import { AgentToolExecution, PendingEdit } from "../core/types";
import { IndexStore } from "../core/indexStore";
import { GraphSearchEngine } from "../search/graphSearch";

const READABLE_EXTENSIONS = new Set(["md", "txt", "csv", "json", "canvas"]);

export class ObsidianAgentTools {
  constructor(
    private readonly app: App,
    private readonly indexStore: IndexStore,
    private readonly searchEngine: GraphSearchEngine,
    private readonly getTopK: () => number,
  ) {}

  async execute(toolName: string, args: Record<string, unknown>): Promise<AgentToolExecution> {
    switch (toolName) {
      case "searchNotes":
        return this.searchNotes(args);
      case "getCurrentNote":
        return this.getCurrentNote();
      case "openCurrentNote":
        return this.openCurrentNote(args);
      case "openNote":
        return this.openNote(args);
      case "listFolder":
        return this.listFolder(args);
      case "getLinks":
        return this.getLinks(args);
      case "getVaultOverview":
        return { content: this.indexStore.getVaultOverview(40) };
      case "proposeNewNote":
        return this.proposeNewNote(args);
      case "proposeEdit":
        return this.proposeEdit(args);
      case "proposePatch":
        return this.proposePatch(args);
      case "proposePatchBatch":
        return this.proposePatchBatch(args);
      default:
        return {
          content: `Unknown tool: ${toolName}. Available tools: searchNotes, getCurrentNote, openCurrentNote, openNote, listFolder, getLinks, getVaultOverview, proposeNewNote, proposePatch, proposePatchBatch, proposeEdit.`,
        };
    }
  }

  async applyEdit(edit: PendingEdit): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(edit.path);
    if (edit.kind === "create") {
      if (file) {
        throw new Error(`File already exists: ${edit.path}`);
      }
      await this.app.vault.create(edit.path, edit.newContent);
      return;
    }

    if (!(file instanceof TFile)) {
      throw new Error(`File not found: ${edit.path}`);
    }

    const currentContent = await this.app.vault.cachedRead(file);
    if (edit.kind === "patch") {
      if (!edit.find || typeof edit.replace !== "string") {
        throw new Error(`Patch data is incomplete: ${edit.path}`);
      }
      const matchCount = countOccurrences(currentContent, edit.find);
      if (matchCount !== 1) {
        throw new Error(`Patch no longer applies cleanly to ${edit.path}; find text matched ${matchCount} times.`);
      }
      await this.app.vault.modify(file, currentContent.replace(edit.find, edit.replace));
      return;
    }

    if (currentContent !== edit.originalContent) {
      throw new Error(`File changed since the edit was proposed: ${edit.path}`);
    }

    await this.app.vault.modify(file, edit.newContent);
  }

  private proposeNewNote(args: Record<string, unknown>): AgentToolExecution {
    const path = getStringArg(args, "path");
    const content = getStringArg(args, "content");
    const summary = getStringArg(args, "summary") ?? "Create note";
    if (!path) {
      return { content: "Missing required argument: path." };
    }
    if (typeof content !== "string") {
      return { content: "Missing required argument: content." };
    }
    const notePath = normalizeNewNotePath(path);
    if (!READABLE_EXTENSIONS.has(pathExtension(notePath))) {
      return { content: `Cannot create metadata-only file as a text note: ${notePath}` };
    }
    if (this.app.vault.getAbstractFileByPath(notePath)) {
      return { content: `Cannot create note because a file or folder already exists at: ${notePath}` };
    }

    const pendingEdit: PendingEdit = {
      id: `${notePath}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      path: notePath,
      kind: "create",
      summary,
      originalContent: "",
      newContent: content,
      createdAt: Date.now(),
    };

    return {
      pendingEdit,
      workingSetItems: [{ path: notePath, role: "edited", detail: summary }],
      content: [
        `Prepared a pending new note for ${notePath}.`,
        `Summary: ${summary}`,
        "The note has not been created. The user must review and apply it.",
      ].join("\n"),
    };
  }

  private searchNotes(args: Record<string, unknown>): AgentToolExecution {
    const query = getStringArg(args, "query");
    const topK = getNumberArg(args, "topK") ?? this.getTopK();
    if (!query) {
      return { content: "Missing required argument: query." };
    }

    const sources = this.searchEngine.search(query, Math.max(1, Math.min(20, topK)));
    if (sources.length === 0) {
      return { content: `No indexed chunks matched query: ${query}` };
    }

    return {
      sources,
      workingSetItems: unique(sources.map((result) => result.chunk.filePath)).map((path) => ({
        path,
        role: "searched",
        detail: `Matched query: ${query}`,
      })),
      content: sources
        .map((result, index) => {
          const chunk = result.chunk;
          const heading = chunk.headings.length ? `\nSection: ${chunk.headings.join(" > ")}` : "";
          return `[${index + 1}] ${chunk.filePath}${heading}\nScore: ${result.score.toFixed(3)}\n${clip(chunk.content, 1200)}`;
        })
        .join("\n\n---\n\n"),
    };
  }

  private getCurrentNote(): AgentToolExecution {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      return { content: "No active note is available." };
    }

    return {
      workingSetItems: [{ path: file.path, role: "current", detail: "Current active note" }],
      content: [`Current note: ${file.path}`, `Extension: .${file.extension}`, `Size: ${file.stat.size} bytes`].join("\n"),
    };
  }

  private openCurrentNote(args: Record<string, unknown>): Promise<AgentToolExecution> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      return Promise.resolve({ content: "No active note is available." });
    }

    return this.openNote({ ...args, path: file.path });
  }

  private async openNote(args: Record<string, unknown>): Promise<AgentToolExecution> {
    const path = getStringArg(args, "path");
    const maxChars = getNumberArg(args, "maxChars") ?? 6000;
    if (!path) {
      return { content: "Missing required argument: path." };
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return { content: `File not found: ${path}` };
    }

    const document = this.indexStore.getAllDocuments().find((item) => item.path === file.path);
    const metadata = document
      ? [
          `Path: ${document.path}`,
          `Extension: .${document.extension}`,
          `Status: ${document.status}`,
          document.tags.length ? `Tags: ${document.tags.join(", ")}` : "",
          document.aliases.length ? `Aliases: ${document.aliases.join(", ")}` : "",
          document.links.length ? `Links: ${document.links.join(", ")}` : "",
          document.headings.length ? `Headings: ${document.headings.join(" > ")}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : `Path: ${file.path}\nExtension: .${file.extension}`;

    if (!READABLE_EXTENSIONS.has(file.extension)) {
      return { content: `${metadata}\n\nThis file is tracked as metadata-only and is not readable as text.` };
    }

    const content = await this.app.vault.cachedRead(file);
    return {
      workingSetItems: [{ path: file.path, role: "opened", detail: "Opened file content" }],
      content: `${metadata}\n\nCONTENT:\n${clip(content, Math.max(1000, Math.min(20000, maxChars)))}`,
    };
  }

  private listFolder(args: Record<string, unknown>): AgentToolExecution {
    const path = getStringArg(args, "path") ?? "";
    const folder = path ? this.app.vault.getAbstractFileByPath(path) : this.app.vault.getRoot();
    if (!(folder instanceof TFolder)) {
      return { content: `Folder not found: ${path}` };
    }

    const children = folder.children
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 120)
      .map((child) => {
        if (child instanceof TFolder) {
          return `- [folder] ${child.path}`;
        }
        if (child instanceof TFile) {
          return `- [file] ${child.path} (${child.stat.size} bytes)`;
        }
        return `- ${child.path}`;
      });

    return {
      workingSetItems: [{ path: folder.path || "/", role: "listed", detail: "Listed folder" }],
      content: children.length ? children.join("\n") : `Folder is empty: ${folder.path || "/"}`,
    };
  }

  private getLinks(args: Record<string, unknown>): AgentToolExecution {
    const path = getStringArg(args, "path");
    if (!path) {
      return { content: "Missing required argument: path." };
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return { content: `File not found: ${path}` };
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const outgoing = [
      ...(cache?.links ?? []).map((link) => link.link),
      ...(cache?.embeds ?? []).map((embed) => embed.link),
    ];
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    const backlinks = Object.entries(resolvedLinks)
      .filter(([, targets]) => Object.prototype.hasOwnProperty.call(targets, file.path))
      .map(([sourcePath]) => sourcePath);

    return {
      workingSetItems: [{ path: file.path, role: "linked", detail: "Inspected links and backlinks" }],
      content: [
        `Links for ${file.path}`,
        "",
        "Outgoing:",
        unique(outgoing).map((link) => `- ${link}`).join("\n") || "None",
        "",
        "Backlinks:",
        unique(backlinks).map((link) => `- ${link}`).join("\n") || "None",
      ].join("\n"),
    };
  }

  private async proposeEdit(args: Record<string, unknown>): Promise<AgentToolExecution> {
    const path = getStringArg(args, "path");
    const newContent = getStringArg(args, "newContent");
    const summary = getStringArg(args, "summary") ?? "Proposed edit";
    if (!path) {
      return { content: "Missing required argument: path." };
    }
    if (typeof newContent !== "string") {
      return { content: "Missing required argument: newContent." };
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return { content: `File not found: ${path}` };
    }
    if (!READABLE_EXTENSIONS.has(file.extension)) {
      return { content: `Cannot propose text edits for metadata-only file: ${path}` };
    }

    const originalContent = await this.app.vault.cachedRead(file);
    const pendingEdit: PendingEdit = {
      id: `${file.path}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      path: file.path,
      kind: "full",
      summary,
      originalContent,
      newContent,
      createdAt: Date.now(),
    };

    return {
      pendingEdit,
      workingSetItems: [{ path: file.path, role: "edited", detail: summary }],
      content: [
        `Prepared a pending edit for ${file.path}.`,
        `Summary: ${summary}`,
        "The edit has not been applied. The user must review and apply it.",
      ].join("\n"),
    };
  }

  private async proposePatch(args: Record<string, unknown>): Promise<AgentToolExecution> {
    const path = getStringArg(args, "path");
    const find = getStringArg(args, "find");
    const replace = getStringArg(args, "replace");
    const summary = getStringArg(args, "summary") ?? "Proposed patch";
    if (!path) {
      return { content: "Missing required argument: path." };
    }
    if (typeof find !== "string" || find.length === 0) {
      return { content: "Missing required argument: find." };
    }
    if (typeof replace !== "string") {
      return { content: "Missing required argument: replace." };
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return { content: `File not found: ${path}` };
    }
    if (!READABLE_EXTENSIONS.has(file.extension)) {
      return { content: `Cannot propose text patches for metadata-only file: ${path}` };
    }

    const originalContent = await this.app.vault.cachedRead(file);
    const error = validatePatch(originalContent, find, file.path);
    if (error) {
      return {
        content: error,
      };
    }

    const pendingEdit = createPatchEdit(file.path, summary, originalContent, find, replace);

    return {
      pendingEdit,
      workingSetItems: [{ path: file.path, role: "edited", detail: summary }],
      content: [
        `Prepared a pending patch for ${file.path}.`,
        `Summary: ${summary}`,
        "The patch has not been applied. The user must review and apply it.",
      ].join("\n"),
    };
  }

  private async proposePatchBatch(args: Record<string, unknown>): Promise<AgentToolExecution> {
    const summary = getStringArg(args, "summary") ?? "Proposed patch batch";
    const patches = Array.isArray(args.patches) ? args.patches : [];
    if (patches.length === 0) {
      return { content: "Missing required argument: patches." };
    }
    if (patches.length > 20) {
      return { content: "Patch batch rejected: at most 20 patches are allowed at once." };
    }

    const currentByPath = new Map<string, string>();
    const stagedByPath = new Map<string, string>();
    const pendingInputs: Array<{ path: string; summary: string; originalContent: string; find: string; replace: string }> = [];

    for (let index = 0; index < patches.length; index += 1) {
      const patch = patches[index];
      if (!isRecord(patch)) {
        return { content: `Patch batch rejected: patch ${index + 1} must be an object.` };
      }

      const path = getStringArg(patch, "path");
      const find = getStringArg(patch, "find");
      const replace = getStringArg(patch, "replace");
      const patchSummary = getStringArg(patch, "summary") ?? summary;
      if (!path || typeof find !== "string" || find.length === 0 || typeof replace !== "string") {
        return { content: `Patch batch rejected: patch ${index + 1} requires path, find, and replace.` };
      }

      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        return { content: `Patch batch rejected: file not found: ${path}` };
      }
      if (!READABLE_EXTENSIONS.has(file.extension)) {
        return { content: `Patch batch rejected: cannot patch metadata-only file: ${path}` };
      }

      const originalContent = currentByPath.get(file.path) ?? (await this.app.vault.cachedRead(file));
      currentByPath.set(file.path, originalContent);
      const stagedContent = stagedByPath.get(file.path) ?? originalContent;
      const error = validatePatch(stagedContent, find, file.path, index + 1);
      if (error) {
        return { content: error };
      }

      stagedByPath.set(file.path, stagedContent.replace(find, replace));
      pendingInputs.push({ path: file.path, summary: patchSummary, originalContent, find, replace });
    }

    const pendingEdits = pendingInputs.map((patch) => createPatchEdit(patch.path, patch.summary, patch.originalContent, patch.find, patch.replace));
    return {
      pendingEdits,
      workingSetItems: unique(pendingEdits.map((edit) => edit.path)).map((path) => ({
        path,
        role: "edited",
        detail: summary,
      })),
      content: [
        `Prepared ${pendingEdits.length} pending patches.`,
        `Summary: ${summary}`,
        "The patches have not been applied. The user must review and apply them.",
      ].join("\n"),
    };
  }
}

function getStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pathExtension(path: string): string {
  const lastPart = path.split("/").pop() ?? "";
  const dotIndex = lastPart.lastIndexOf(".");
  return dotIndex >= 0 ? lastPart.slice(dotIndex + 1).toLowerCase() : "md";
}

function normalizeNewNotePath(path: string): string {
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "").trim();
  const lastPart = normalized.split("/").pop() ?? "";
  return lastPart.includes(".") ? normalized : `${normalized}.md`;
}

function clip(content: string, maxChars: number): string {
  return content.length <= maxChars ? content : `${content.slice(0, maxChars)}\n\n[truncated]`;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function createPatchEdit(path: string, summary: string, originalContent: string, find: string, replace: string): PendingEdit {
  return {
    id: `${path}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    path,
    kind: "patch",
    summary,
    originalContent,
    newContent: originalContent.replace(find, replace),
    find,
    replace,
    createdAt: Date.now(),
  };
}

function validatePatch(content: string, find: string, path: string, index?: number): string | null {
  const matchCount = countOccurrences(content, find);
  if (matchCount === 1) {
    return null;
  }

  const prefix = index ? `Patch batch rejected at patch ${index} for ${path}.` : `Patch rejected for ${path}.`;
  return [
    prefix,
    `The find text matched ${matchCount} times; it must match exactly once.`,
    "Open the file and propose a more specific find block.",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (index <= content.length) {
    const found = content.indexOf(needle, index);
    if (found === -1) {
      break;
    }
    count += 1;
    index = found + needle.length;
  }
  return count;
}
