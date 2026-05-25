import { PendingEdit } from "../core/types";

export interface SequentialPatchInput {
  path: string;
  summary: string;
  originalContent: string;
  find: string;
  replace: string;
}

export function createPatchEdit(path: string, summary: string, originalContent: string, find: string, replace: string): PendingEdit {
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

export function createSequentialPatchEdits(patches: SequentialPatchInput[]): PendingEdit[] {
  const stagedByPath = new Map<string, string>();

  return patches.map((patch) => {
    const stagedContent = stagedByPath.get(patch.path) ?? patch.originalContent;
    stagedByPath.set(patch.path, stagedContent.replace(patch.find, patch.replace));
    return createPatchEdit(patch.path, patch.summary, stagedContent, patch.find, patch.replace);
  });
}

export function validatePatch(content: string, find: string, path: string, index?: number): string | null {
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

export function countOccurrences(content: string, needle: string): number {
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
