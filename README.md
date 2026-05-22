# DeepSeek RAG for Obsidian

Local-first Obsidian plugin scaffold for asking DeepSeek questions against your markdown notes.

## What Works

- Chat view in the right sidebar.
- DeepSeek chat completions via `/v1/chat/completions`.
- Local markdown indexing with heading and tag metadata.
- TF/IDF-style retrieval over indexed chunks.
- Realtime re-indexing on create, modify, delete, and rename events.
- Settings tab for API key, model, API URL, chunking, and re-indexing.

## Build

```bash
npm install
npm run build
```

Then copy the contents of `dist/` into:

```text
<vault>/.obsidian/plugins/deepseek-rag/
```

Enable the plugin in Obsidian community plugin settings, then set your DeepSeek API key.

## Notes

The first implementation intentionally avoids native vector database dependencies. That keeps the plugin easy to install inside Obsidian. The search layer is isolated behind `HybridSearchEngine`, so a future LanceDB or embeddings-backed index can replace the local lexical scorer without rewriting the UI.
