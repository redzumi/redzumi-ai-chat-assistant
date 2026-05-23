# Roadmap

## Near Term

- Add provider capability detection for tool calling support. If an OpenAI-compatible endpoint rejects `tools` or `tool_choice`, show a clear message that the selected provider or model does not support agent tools.
- Add a retry policy for transient model request failures: 429, 500, 502, 503, and 504, with small exponential backoff and full `AbortSignal` support.
- Add structured debug traces grouped by turn: user message, model request, model response, tool call, tool result, and final answer.
- Add a redacted debug export mode that removes full note content, system prompt text, large model responses, and other sensitive payloads.

## Reliability

- Add MCP server tests for capability enforcement:
  - read tools are available in Ask and Edit modes;
  - propose-edit tools are available only in Edit mode;
  - apply tools are available only when `Allow apply` is enabled for the current message;
  - invalid tool args are rejected before reaching handlers.
- Add provider adapter tests for the OpenAI-compatible adapter:
  - request shape includes `tools` and `tool_choice`;
  - assistant `tool_calls` parse into provider-neutral tool calls;
  - plain assistant answers parse without tool calls;
  - malformed provider responses fail cleanly.
- Add per-tool duration telemetry in debug logs and the live debug panel.

## Product

- Persist chat sessions across panel close and Obsidian restart, including messages, pending edits, working set, and debug trace metadata.
- Add provider adapters beyond OpenAI-compatible APIs, starting with Anthropic `tool_use` and a graceful fallback for local providers that do not support tools.
- Add user-facing provider compatibility checks in settings so unsupported models are detected before the first chat request.
