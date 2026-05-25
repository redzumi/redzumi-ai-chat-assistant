import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { IndexStore } from "./indexStore";
import { IndexedChunk, IndexedDocument } from "./types";

test("IndexStore.deleteFolder removes documents and chunks under an exact folder path", () => {
  const store = new IndexStore();
  store.replaceFile(document("Projects/A.md"), [chunk("Projects/A.md", "alpha")]);
  store.replaceFile(document("Projects/Nested/B.md"), [chunk("Projects/Nested/B.md", "beta")]);
  store.replaceFile(document("Projects-Archive/C.md"), [chunk("Projects-Archive/C.md", "gamma")]);
  store.replaceFile(document("Other/D.md"), [chunk("Other/D.md", "delta")]);

  store.deleteFolder("Projects");

  deepEqual(
    store.getAllDocuments().map((item) => item.path).sort(),
    ["Other/D.md", "Projects-Archive/C.md"],
  );
  deepEqual(
    store.getAllChunks().map((item) => item.filePath).sort(),
    ["Other/D.md", "Projects-Archive/C.md"],
  );
  equal(store.getCoverage().chunkCount, 2);
});

function document(path: string): IndexedDocument {
  const basename = path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? path;
  const extension = path.split(".").pop() ?? "md";
  return {
    path,
    basename,
    extension,
    status: "indexed",
    chunkCount: 1,
    size: 10,
    created: 1,
    modified: 1,
    tags: [],
    headings: [],
    links: [],
    aliases: [],
    frontmatterKeys: [],
  };
}

function chunk(filePath: string, content: string): IndexedChunk {
  return {
    id: `${filePath}:0:${content.length}`,
    filePath,
    fileExtension: "md",
    content,
    startOffset: 0,
    endOffset: content.length,
    headings: [],
    tags: [],
    modified: 1,
  };
}
