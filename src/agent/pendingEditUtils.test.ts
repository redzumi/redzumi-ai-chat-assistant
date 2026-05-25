import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { createSequentialPatchEdits, validatePatch } from "./pendingEditUtils";

test("createSequentialPatchEdits previews later patches against staged same-file content", () => {
  const edits = createSequentialPatchEdits([
    {
      path: "Notes/A.md",
      summary: "Rename alpha to beta",
      originalContent: "alpha\n",
      find: "alpha",
      replace: "beta",
    },
    {
      path: "Notes/A.md",
      summary: "Rename beta to gamma",
      originalContent: "alpha\n",
      find: "beta",
      replace: "gamma",
    },
  ]);

  equal(edits.length, 2);
  deepEqual(
    edits.map((edit) => ({
      path: edit.path,
      kind: edit.kind,
      summary: edit.summary,
      originalContent: edit.originalContent,
      newContent: edit.newContent,
      find: edit.find,
      replace: edit.replace,
    })),
    [
      {
        path: "Notes/A.md",
        kind: "patch",
        summary: "Rename alpha to beta",
        originalContent: "alpha\n",
        newContent: "beta\n",
        find: "alpha",
        replace: "beta",
      },
      {
        path: "Notes/A.md",
        kind: "patch",
        summary: "Rename beta to gamma",
        originalContent: "beta\n",
        newContent: "gamma\n",
        find: "beta",
        replace: "gamma",
      },
    ],
  );
});

test("validatePatch reports ambiguous and missing find blocks", () => {
  equal(validatePatch("alpha beta", "alpha", "Notes/A.md"), null);
  equal(
    validatePatch("alpha alpha", "alpha", "Notes/A.md"),
    [
      "Patch rejected for Notes/A.md.",
      "The find text matched 2 times; it must match exactly once.",
      "Open the file and propose a more specific find block.",
    ].join("\n"),
  );
  equal(
    validatePatch("alpha", "beta", "Notes/A.md", 2),
    [
      "Patch batch rejected at patch 2 for Notes/A.md.",
      "The find text matched 0 times; it must match exactly once.",
      "Open the file and propose a more specific find block.",
    ].join("\n"),
  );
});
