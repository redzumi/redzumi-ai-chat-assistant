import { IndexedChunk } from "./types";

interface Section {
  headingStack: string[];
  startOffset: number;
  content: string;
}

export class SemanticChunker {
  constructor(
    private readonly maxChars: number,
    private readonly overlapChars: number,
  ) {}

  chunkDocument(content: string, filePath: string, modified: number, fileExtension = "md"): IndexedChunk[] {
    const tags = this.extractTags(content);
    const sections = this.extractSections(content);
    const chunks: IndexedChunk[] = [];

    for (const section of sections) {
      const normalized = section.content.trim();
      if (!normalized) {
        continue;
      }

      for (const piece of this.splitSection(normalized, section.startOffset)) {
        chunks.push({
          id: `${filePath}:${piece.startOffset}:${piece.endOffset}`,
          filePath,
          fileExtension,
          content: piece.content,
          startOffset: piece.startOffset,
          endOffset: piece.endOffset,
          headings: section.headingStack,
          tags,
          modified,
        });
      }
    }

    return chunks;
  }

  private extractSections(content: string): Section[] {
    const lines = content.split(/\n/);
    const sections: Section[] = [];
    let offset = 0;
    let current: Section = { headingStack: [], startOffset: 0, content: "" };
    const headingStack: string[] = [];

    for (const line of lines) {
      const rawLine = `${line}\n`;
      const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);

      if (headingMatch) {
        if (current.content.trim()) {
          sections.push(current);
        }

        const level = headingMatch[1].length;
        headingStack.length = level - 1;
        headingStack[level - 1] = headingMatch[2].trim();
        current = {
          headingStack: headingStack.filter(Boolean),
          startOffset: offset,
          content: rawLine,
        };
      } else {
        current.content += rawLine;
      }

      offset += rawLine.length;
    }

    if (current.content.trim()) {
      sections.push(current);
    }

    return sections.length ? sections : [{ headingStack: [], startOffset: 0, content }];
  }

  private splitSection(content: string, sectionOffset: number): Array<{ content: string; startOffset: number; endOffset: number }> {
    const paragraphs = content.split(/\n{2,}/).filter((paragraph) => paragraph.trim().length > 0);
    const chunks: Array<{ content: string; startOffset: number; endOffset: number }> = [];
    let buffer = "";
    let bufferStart = 0;
    let localCursor = 0;

    for (const paragraph of paragraphs) {
      const paragraphStart = content.indexOf(paragraph, localCursor);
      localCursor = paragraphStart + paragraph.length;
      const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;

      if (candidate.length <= this.maxChars || !buffer) {
        if (!buffer) {
          bufferStart = paragraphStart;
        }
        buffer = candidate;
        continue;
      }

      chunks.push(...this.createPieces(buffer, sectionOffset + bufferStart));
      buffer = this.withOverlap(buffer, paragraph);
      bufferStart = Math.max(0, paragraphStart - Math.min(this.overlapChars, buffer.length));
    }

    if (buffer.trim()) {
      if (buffer.length <= this.maxChars) {
        chunks.push(this.createPiece(buffer, sectionOffset + bufferStart));
      } else {
        chunks.push(...this.splitLongText(buffer, sectionOffset + bufferStart));
      }
    }

    return chunks;
  }

  private splitLongText(text: string, absoluteStart: number): Array<{ content: string; startOffset: number; endOffset: number }> {
    const chunks: Array<{ content: string; startOffset: number; endOffset: number }> = [];
    let cursor = 0;

    while (cursor < text.length) {
      const end = Math.min(text.length, cursor + this.maxChars);
      const slice = text.slice(cursor, end).trim();
      if (slice) {
        chunks.push({
          content: slice,
          startOffset: absoluteStart + cursor,
          endOffset: absoluteStart + end,
        });
      }
      if (end === text.length) {
        break;
      }
      cursor = this.overlapChars > 0 ? Math.max(cursor + 1, end - this.overlapChars) : end;
    }

    return chunks;
  }

  private createPiece(content: string, absoluteStart: number): { content: string; startOffset: number; endOffset: number } {
    const trimmed = content.trim();
    const leadingWhitespace = content.length - content.trimStart().length;
    return {
      content: trimmed,
      startOffset: absoluteStart + leadingWhitespace,
      endOffset: absoluteStart + leadingWhitespace + trimmed.length,
    };
  }

  private createPieces(content: string, absoluteStart: number): Array<{ content: string; startOffset: number; endOffset: number }> {
    return content.length <= this.maxChars ? [this.createPiece(content, absoluteStart)] : this.splitLongText(content, absoluteStart);
  }

  private withOverlap(previous: string, next: string): string {
    if (this.overlapChars <= 0) {
      return next;
    }

    const overlap = previous.slice(Math.max(0, previous.length - this.overlapChars)).trim();
    return overlap ? `${overlap}\n\n${next}` : next;
  }

  private extractTags(content: string): string[] {
    return Array.from(new Set(Array.from(content.matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu), (match) => match[2])));
  }
}
