export interface DeepSeekRagSettings {
  apiKey: string;
  model: string;
  apiBaseUrl: string;
  chunkSize: number;
  overlapSize: number;
  topK: number;
  realtimeIndexing: boolean;
  includeContextByDefault: boolean;
  agentModeByDefault: boolean;
}

export type IndexedFileStatus = "indexed" | "metadata-only" | "error";

export interface IndexedDocument {
  path: string;
  basename: string;
  extension: string;
  status: IndexedFileStatus;
  chunkCount: number;
  size: number;
  created: number;
  modified: number;
  tags: string[];
  headings: string[];
  links: string[];
  aliases: string[];
  frontmatterKeys: string[];
  error?: string;
}

export interface IndexedChunk {
  id: string;
  filePath: string;
  fileExtension: string;
  content: string;
  startOffset: number;
  endOffset: number;
  headings: string[];
  tags: string[];
  modified: number;
}

export interface SearchResult {
  chunk: IndexedChunk;
  score: number;
}

export interface AgentToolExecution {
  content: string;
  sources?: SearchResult[];
  pendingEdit?: PendingEdit;
}

export interface AgentToolExecutor {
  execute(toolName: string, args: Record<string, unknown>): Promise<AgentToolExecution>;
  applyEdit(edit: PendingEdit): Promise<void>;
}

export interface AgentCompletion {
  answer: string;
  sources: SearchResult[];
  pendingEdits: PendingEdit[];
}

export interface PendingEdit {
  id: string;
  path: string;
  kind: "full" | "patch";
  summary: string;
  originalContent: string;
  newContent: string;
  find?: string;
  replace?: string;
  createdAt: number;
}

export interface IndexCoverage {
  totalFiles: number;
  indexedFiles: number;
  metadataOnlyFiles: number;
  errorFiles: number;
  chunkCount: number;
}

export interface PersistedIndex {
  version: number;
  documents: IndexedDocument[];
  chunks: IndexedChunk[];
  updatedAt: number;
}

export const DEFAULT_SETTINGS: DeepSeekRagSettings = {
  apiKey: "",
  model: "deepseek-chat",
  apiBaseUrl: "https://api.deepseek.com",
  chunkSize: 900,
  overlapSize: 120,
  topK: 6,
  realtimeIndexing: true,
  includeContextByDefault: true,
  agentModeByDefault: false,
};
