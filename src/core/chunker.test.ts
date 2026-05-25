import { equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { SemanticChunker } from "./chunker";

test("SemanticChunker keeps overlap when splitting long text", () => {
  const chunker = new SemanticChunker(10, 3);
  const chunks = chunker.chunkDocument("abcdefghijklmnop", "Note.md", 1);

  equal(chunks.length, 2);
  equal(chunks[0].content, "abcdefghij");
  equal(chunks[1].content, "hijklmnop");
  ok(chunks[1].startOffset < chunks[0].endOffset);
});
