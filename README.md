# Responses Copilot

`responses-copilot` lets OpenAI-compatible models appear directly in the VS Code Copilot Chat model picker, using the **Responses API** end-to-end.

## What It Does

- Uses `POST /v1/responses` only (no `chat/completions` fallback).
- Streams text and tool calls from Responses events.
- Maps VS Code system messages to the Responses `instructions` field.
- Sends image attachments as native `input_image` parts (no local vision proxy model).
- Pulls model list from upstream `GET /v1/models` with TTL cache + manual refresh.
- Keeps Copilot native experience: agent flow, tools, instructions, MCP, and skills.

## Current Architecture

- Provider: `vscode.lm.registerLanguageModelChatProvider('responses-copilot', ...)`
- Upstream default base URL: `https://api.openai.com/v1`
- Protocol mode: **Responses-only**
- API key storage: VS Code `SecretStorage` (OS keychain-backed)

## Settings

| Setting | Default | Description |
|---|---|---|
| `responses-copilot.baseUrl` | `https://api.openai.com/v1` | Upstream API base URL |
| `responses-copilot.maxOutputTokens` | `0` | Max output tokens (`0` = unlimited / omit field) |
| `responses-copilot.modelMaxInputTokensDefault` | `272000` | Global fallback max input tokens for models without built-in or per-model overrides |
| `responses-copilot.modelMaxOutputTokensDefault` | `128000` | Global fallback max output tokens for models without built-in or per-model overrides |
| `responses-copilot.modelTokenOverrides` | `{}` | Per-model token overrides (highest priority) |
| `responses-copilot.forceOverrideModelTokenSettings` | `false` | Force global token defaults for all models (except explicit per-model overrides) |
| `responses-copilot.omitMaxOutputTokensInModelMetadata` | `true` | Temporary Copilot workaround: omit `maxOutputTokens` in model metadata so context behavior does not use summed input+output window |
| `responses-copilot.modelListTtlMinutes` | `30` | `/models` cache TTL |
| `responses-copilot.reasoningEffortDefault` | `medium` | Default reasoning effort (`none/minimal/low/medium/high/xhigh`) |
| `responses-copilot.streamingTransport` | `websocketPreferred` | Streaming transport (`websocketPreferred` -> `httpOnly` fallback, `httpOnly`, `websocketOnly`) |
| `responses-copilot.experimental.stabilizeToolList` | `false` | Pre-activate host `activate_*` virtual tools to stabilize tool list across turns |
| `responses-copilot.debugMode` | `minimal` | `minimal`, `metadata`, `verbose` |

Built-in token presets (auto-detected by model id):

- `gpt-5*`: input `272000`, output `128000`
- `deepseek-v4-*`: input `1000000`, output `384000`

`responses-copilot.modelTokenOverrides` supports:

- exact model id key (for example `gpt-5`)
- prefix wildcard key ending with `*` (for example `gpt-5-mini*`, `deepseek-v4-*`)

Example:

```json
{
	"gpt-5": { "maxInputTokens": 272000, "maxOutputTokens": 128000 },
	"gpt-5-mini*": { "maxOutputTokens": 64000 },
	"deepseek-v4-*": { "maxInputTokens": 1000000, "maxOutputTokens": 384000 }
}
```

Token setting precedence:

1. `responses-copilot.modelTokenOverrides` (per-model)
2. `responses-copilot.forceOverrideModelTokenSettings=true` -> use global defaults for all models
3. built-in presets by model id
4. global defaults (`modelMaxInputTokensDefault` / `modelMaxOutputTokensDefault`)

## Commands

- `Responses Copilot: Set API Key`
- `Responses Copilot: Clear API Key`
- `Responses Copilot: Refresh Models`
- `Responses Copilot: Open Settings`
- `Responses Copilot: Show Logs`
- `Responses Copilot: Open Request Dumps Folder`

## Compatibility Notes

- Requires VS Code `^1.116.0`
- Depends on Copilot Chat provider APIs
- If upstream does not support `/responses`, requests fail fast with explicit error

## Upstream Origin

This project is a Copilot API refactor derived from the upstream extension:

- Upstream repository: https://github.com/Vizards/deepseek-v4-for-copilot

Specifically, this codebase evolved from **DeepSeek V4 for Copilot Chat** by reverse-engineering/adapting Copilot-side integration behaviors and migrating the transport/protocol to generic Responses API semantics.

<!-- marketplace-readme:remove-start -->

## Development

```bash
npm install
npm run compile
npm run lint
```

## License

[MIT](LICENSE)

<!-- marketplace-readme:remove-end -->
