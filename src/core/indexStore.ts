import { IndexCoverage, IndexedChunk, IndexedDocument, PersistedIndex } from "./types";

const INDEX_VERSION = 3;

export class IndexStore {
  private documents: IndexedDocument[] = [];
  private chunks: IndexedChunk[] = [];

  load(index: PersistedIndex | undefined): IndexedChunk[] {
    this.documents = index?.version === INDEX_VERSION ? index.documents : [];
    this.chunks = index?.version === INDEX_VERSION ? index.chunks : [];
    return this.getAllChunks();
  }

  getAllDocuments(): IndexedDocument[] {
    return [...this.documents];
  }

  getAllChunks(): IndexedChunk[] {
    return [...this.chunks];
  }

  replaceFile(document: IndexedDocument, chunks: IndexedChunk[]): void {
    this.documents = this.documents.filter((stored) => stored.path !== document.path).concat(document);
    this.chunks = this.chunks.filter((chunk) => chunk.filePath !== document.path).concat(chunks);
  }

  replaceMetadataOnly(document: IndexedDocument): void {
    this.replaceFile(document, []);
  }

  deleteFile(filePath: string): void {
    this.documents = this.documents.filter((document) => document.path !== filePath);
    this.chunks = this.chunks.filter((chunk) => chunk.filePath !== filePath);
  }

  deleteFolder(folderPath: string): void {
    const normalized = folderPath.replace(/\/+$/, "");
    if (!normalized) {
      this.clear();
      return;
    }
    this.documents = this.documents.filter((document) => !isPathInFolder(document.path, normalized));
    this.chunks = this.chunks.filter((chunk) => !isPathInFolder(chunk.filePath, normalized));
  }

  getCoverage(): IndexCoverage {
    return {
      totalFiles: this.documents.length,
      indexedFiles: this.documents.filter((document) => document.status === "indexed").length,
      metadataOnlyFiles: this.documents.filter((document) => document.status === "metadata-only").length,
      errorFiles: this.documents.filter((document) => document.status === "error").length,
      chunkCount: this.chunks.length,
    };
  }

  getVaultOverview(maxDocuments = 20): string {
    const coverage = this.getCoverage();
    const topDocuments = this.documents
      .filter((document) => document.status === "indexed")
      .sort((a, b) => b.chunkCount - a.chunkCount || b.modified - a.modified)
      .slice(0, maxDocuments)
      .map((document) => {
        const tags = document.tags.length ? ` tags: ${document.tags.slice(0, 8).join(", ")}` : "";
        const aliases = document.aliases.length ? ` aliases: ${document.aliases.slice(0, 4).join(", ")}` : "";
        const links = document.links.length ? ` links: ${document.links.slice(0, 5).join(", ")}` : "";
        const headings = document.headings.length ? ` headings: ${document.headings.slice(0, 5).join(" > ")}` : "";
        return `- ${document.path} (${document.chunkCount} chunks; .${document.extension})${tags}${aliases}${links}${headings}`;
      });

    return [
      `Vault index: ${coverage.totalFiles} files tracked, ${coverage.indexedFiles} indexed, ${coverage.metadataOnlyFiles} metadata-only, ${coverage.errorFiles} errors, ${coverage.chunkCount} chunks.`,
      topDocuments.length ? "Largest indexed documents:" : "",
      ...topDocuments,
    ]
      .filter(Boolean)
      .join("\n");
  }

  clear(): void {
    this.documents = [];
    this.chunks = [];
  }

  toPersistedIndex(): PersistedIndex {
    return {
      version: INDEX_VERSION,
      documents: this.getAllDocuments(),
      chunks: this.getAllChunks(),
      updatedAt: Date.now(),
    };
  }
}

function isPathInFolder(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(`${folderPath}/`);
}
