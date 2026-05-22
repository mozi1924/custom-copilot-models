# Tools 列表不稳定

Responses Copilot 检测到当前会话中的 Tools（工具）列表在不同轮次之间可能不稳定。

## 为什么会发生

部分上游 API 或宿主运行时会对单次请求中的工具定义数量设置实际限制。VS Code 的 Language Model API 也允许模型声明单次请求可接收的最大工具数。

当启用实验性设置 `responses-copilot.experimental.stabilizeToolList` 时，扩展会尝试预先激活 VS Code/Copilot 的 `activate_*` 虚拟工具，让传给上游 API 的 `tools` 参数在多轮对话中更完整、更稳定。

如果当前环境中可用工具太多，Copilot 可能会对工具列表进行裁剪、分组或延迟展开。不同轮次得到的 Tools 数组可能不完全一致。

## 影响

大多数上游提供方都会对输入前缀做缓存。Tools 数组是请求前缀的一部分；如果 Tools 数组变化，缓存命中率可能下降。

开启这个实验性设置后，请求中可能包含更多函数工具定义（名称、说明和 JSON Schema），因此 **input tokens** 可能增加。缓存命中的 input tokens 通常单价更低，但仍会计入用量。少于 **64 个已启用工具** 时通常无需开启；工具总量很大时（尤其超过 **128 个**）建议谨慎开启。

## 你可以怎么做

1. 运行 VS Code 命令 `workbench.action.chat.configureTools`，关闭暂时不需要的工具或 MCP 工具。
2. 关闭 `responses-copilot.experimental.stabilizeToolList`。
3. 如果你不介意缓存命中率下降，也可以继续在当前会话发送消息。

如果你有更好的解决方案，欢迎在 [issue #56](https://github.com/Vizards/deepseek-v4-for-copilot/issues/56) 讨论。
