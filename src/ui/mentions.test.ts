import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { addMentionInstructions, getMentionTrigger, parseMentions } from "./mentions";

const paths = new Map([
  ["Current Project", { kind: "note" as const, path: "Projects/Current Project.md" }],
  ["Projects/Current Project", { kind: "note" as const, path: "Projects/Current Project.md" }],
  ["Projects/Current Project.md", { kind: "note" as const, path: "Projects/Current Project.md" }],
  ["Projects", { kind: "folder" as const, path: "Projects" }],
  ["Projects/", { kind: "folder" as const, path: "Projects" }],
]);

test("parseMentions extracts current, wikilink, path, and folder mentions", () => {
  const mentions = parseMentions("Use @current with @[[Current Project#Plan|project]] and @Projects/", (path) => paths.get(path) ?? null);

  deepEqual(mentions, [
    { kind: "current", raw: "@current" },
    { kind: "note", raw: "@[[Current Project#Plan|project]]", path: "Projects/Current Project.md" },
    { kind: "folder", raw: "@Projects/", path: "Projects" },
  ]);
});

test("parseMentions deduplicates mentions by resolved target", () => {
  const mentions = parseMentions("@[[Current Project]] @Projects/Current Project.md @current @current", (path) => paths.get(path) ?? null);

  deepEqual(mentions, [
    { kind: "current", raw: "@current" },
    { kind: "note", raw: "@[[Current Project]]", path: "Projects/Current Project.md" },
  ]);
});

test("addMentionInstructions keeps visible content and adds tool instructions", () => {
  const output = addMentionInstructions("Summarize this.", [
    { kind: "current", raw: "@current" },
    { kind: "note", raw: "@[[Current Project]]", path: "Projects/Current Project.md" },
    { kind: "folder", raw: "@Projects/", path: "Projects" },
  ]);

  equal(
    output,
    [
      "Summarize this.",
      "",
      "Explicit context mentions:",
      "- @current: call openCurrentNote before answering.",
      '- @[[Current Project]]: call openNote for "Projects/Current Project.md" before answering.',
      '- @Projects/: call listFolder for "Projects" and use searchNotes within the active scope when needed.',
      "Use the mentioned context before answering. If a mentioned file or folder cannot be opened, say so clearly.",
    ].join("\n"),
  );
});

test("getMentionTrigger returns the active mention token before the cursor", () => {
  deepEqual(getMentionTrigger("Ask @Proj", "Ask @Proj".length), { from: 4, to: 9, query: "Proj" });
  deepEqual(getMentionTrigger("@", 1), { from: 0, to: 1, query: "" });
  equal(getMentionTrigger("email@example.com", "email@example.com".length), null);
  equal(getMentionTrigger("Use @[[Project]]", "Use @[[Project]]".length), null);
});
