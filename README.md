# Vault Chat Agent

AI assistant plugin for working with your Obsidian vault.

## What Works

- One agentic chat with Ask and Edit intents.
- OpenAI-compatible chat completions via `/v1/chat/completions`.
- Search scopes for whole-vault, current-note, and current-folder chat.
- Provider presets for OpenAI, DeepSeek, OpenRouter, LM Studio, Ollama, and custom endpoints.
- Model browsing from OpenAI-compatible `/v1/models` endpoints.
- Local vault indexing across supported text files, Canvas files, and metadata-only attachments.
- Graph-aware retrieval using note links, backlinks, and neighboring chunks.
- Related Notes sidebar based on the active note or selected text.
- Read-only agent tools for searching, opening notes, inspecting links, and reviewing the current note, with clickable source references.
- Text commands for summarizing selections, extracting action items, and proposing polished rewrites.
- Saved prompts with Ask/Edit intent, runnable from the command palette against the current selection or note.
- Reviewed edit proposals with patch previews, Apply/Reject, and batch patch support.
- Optional stripping of `<think>`, `<reasoning>`, and `<thought>` blocks from assistant output.
- Realtime re-indexing on vault create, modify, delete, and rename events.

## Build

```bash
npm install
npm run build
```

Then copy the contents of `dist/` into:

```text
<vault>/.obsidian/plugins/vault-chat-agent/
```

Enable the plugin in Obsidian community plugin settings, then configure an OpenAI-compatible provider in the plugin settings.

## Provider Notes

The plugin calls:

```text
<API base URL>/v1/chat/completions
```

Remote providers usually need an API key. Local providers such as LM Studio and Ollama can leave the API key empty when using a localhost base URL.
