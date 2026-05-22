## Stabilize Tool List (Experimental)

First, open VS Code's Tools configuration and check how many tools are enabled for chat.

[Configure Tools](command:workbench.action.chat.configureTools)

- 64 or fewer enabled tools: there is usually no need to turn this on unless the tool list still changes across turns.
- More than 128 enabled tools: not recommended. Copilot provider tool contracts become harder to keep stable at this scale. Disable rarely used tools first, then consider enabling this setting.
- Between 64 and 128 enabled tools: consider this setting only if the tools list changes between turns and cache hits are poor.

This setting may improve cache hits by making the Responses API `tools` parameter more complete and stable across turns. It may also increase input tokens because more function definitions can be included in each request.

[Open Responses setting](command:workbench.action.openSettings?%5B%22%40id%3Aresponses-copilot.experimental.stabilizeToolList%22%5D)
