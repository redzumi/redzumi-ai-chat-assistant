# Vault Chat Assistant

AI assistant plugin for working with your Obsidian vault.

## What Works

- Chat, Context, and Agent modes in a right-sidebar view.
- OpenAI-compatible chat completions via `/v1/chat/completions`.
- Provider presets for OpenAI, DeepSeek, OpenRouter, LM Studio, Ollama, and custom endpoints.
- Local vault indexing across supported text files, Canvas files, and metadata-only attachments.
- Graph-aware retrieval using note links, backlinks, and neighboring chunks.
- Agent tools for searching, opening notes, inspecting links, and reviewing the current note.
- Reviewed edit proposals with patch previews, Apply/Reject, and batch patch support.
- Realtime re-indexing on vault create, modify, delete, and rename events.

## Build

```bash
npm install
npm run build
```

Then copy the contents of `dist/` into:

```text
<vault>/.obsidian/plugins/obsidian-ai-assistant/
```

Enable the plugin in Obsidian community plugin settings, then configure an OpenAI-compatible provider in the plugin settings.

## Provider Notes

The plugin calls:

```text
<API base URL>/v1/chat/completions
```

Remote providers usually need an API key. Local providers such as LM Studio and Ollama can leave the API key empty when using a localhost base URL.
