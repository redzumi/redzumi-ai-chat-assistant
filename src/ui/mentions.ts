export type MentionKind = "current" | "note" | "folder";

export interface ChatMention {
  kind: MentionKind;
  raw: string;
  path?: string;
}

export interface MentionTrigger {
  from: number;
  to: number;
  query: string;
}

export interface MentionPathResolution {
  kind: "note" | "folder";
  path: string;
}

export function parseMentions(content: string, resolvePath: (path: string) => MentionPathResolution | null): ChatMention[] {
  const mentions: ChatMention[] = [];
  const seen = new Set<string>();
  const addMention = (mention: ChatMention) => {
    const key = `${mention.kind}:${mention.path ?? mention.raw}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    mentions.push(mention);
  };

  for (const match of content.matchAll(/(^|\s)@current\b/gi)) {
    addMention({ kind: "current", raw: match[0].trim() });
  }

  for (const match of content.matchAll(/@\[\[([^\]]+)\]\]/g)) {
    const rawPath = match[1].split("|")[0].split("#")[0].trim();
    const resolved = resolvePath(rawPath);
    if (resolved) {
      addMention({ kind: resolved.kind, raw: match[0], path: resolved.path });
    }
  }

  for (const match of content.matchAll(/(^|\s)@([^\s@[\]]+)/g)) {
    const raw = match[2].trim().replace(/[),.;:!?]+$/, "");
    if (!raw || raw.toLocaleLowerCase() === "current") {
      continue;
    }
    const resolved = resolvePath(raw);
    if (resolved) {
      addMention({ kind: resolved.kind, raw: `@${raw}`, path: resolved.path });
    }
  }

  return mentions.slice(0, 12);
}

export function addMentionInstructions(content: string, mentions: ChatMention[]): string {
  if (mentions.length === 0) {
    return content;
  }

  const instructions = mentions.map((mention) => {
    if (mention.kind === "current") {
      return "- @current: call openCurrentNote before answering.";
    }
    if (mention.kind === "folder" && mention.path) {
      return `- ${mention.raw}: call listFolder for "${mention.path}" and use searchNotes within the active scope when needed.`;
    }
    if (mention.kind === "note" && mention.path) {
      return `- ${mention.raw}: call openNote for "${mention.path}" before answering.`;
    }
    return `- ${mention.raw}`;
  });

  return [
    content,
    "",
    "Explicit context mentions:",
    ...instructions,
    "Use the mentioned context before answering. If a mentioned file or folder cannot be opened, say so clearly.",
  ].join("\n");
}

export function formatMention(mention: ChatMention): string {
  if (mention.kind === "current") {
    return "@current";
  }
  return `@${mention.path ?? mention.raw.replace(/^@/, "")}`;
}

export function getMentionTrigger(content: string, cursor: number): MentionTrigger | null {
  const beforeCursor = content.slice(0, cursor);
  const match = beforeCursor.match(/(^|\s)@([^\s@[\]]*)$/);
  if (!match) {
    return null;
  }

  const token = match[0];
  const leadingWhitespace = token.startsWith("@") ? 0 : 1;
  const from = cursor - token.length + leadingWhitespace;
  return {
    from,
    to: cursor,
    query: match[2] ?? "",
  };
}
