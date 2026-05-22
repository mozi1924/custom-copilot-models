# Unstable Tools List

Responses Copilot detected that the Tools list in the current chat may be unstable across turns.

## Why This Happens

Some upstream APIs and host runtimes enforce practical limits for tool definitions per request. VS Code's Language Model API also lets a model declare the maximum number of tools it can receive per request.

When the experimental `responses-copilot.experimental.stabilizeToolList` setting is enabled, the extension tries to pre-activate VS Code/Copilot `activate_*` virtual tools before sending the request, so the upstream `tools` parameter is more complete and stable across turns.

If too many tools are available in the current environment, Copilot may trim, group, or defer tool expansion. The resulting Tools array may differ between turns.

## Impact

Most providers use prefix caching for request inputs. The Tools array is part of that prefix; if it changes, cache hit rates can drop.

With this experimental setting enabled, each request may include more function definitions (names, descriptions, and JSON schemas), so **input tokens** can increase. Cache-hit input tokens are often billed at a lower price but still count toward usage. It is usually unnecessary with fewer than **64 enabled tools**. Avoid enabling it with very large tool sets (especially above **128 enabled tools**) unless you explicitly need it.

## What You Can Do

1. Run the VS Code command `workbench.action.chat.configureTools` and disable tools or MCP tools you do not currently need.
2. Turn off `responses-copilot.experimental.stabilizeToolList`.
3. If a lower cache hit rate is acceptable, you can continue sending messages in this chat.

If you have a better solution, please join the discussion in [issue #56](https://github.com/Vizards/deepseek-v4-for-copilot/issues/56).
