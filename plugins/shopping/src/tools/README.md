# src/tools — 冻结层

工具的**真实 schema** 与 search / open / buy 等工具到 ShopSimulator
环境 action（`search[...]` / `click[...]`）的映射。

**冻结层，不允许 Self-Harness patch。**

- 不得修改工具真实语义。
- 不得修改工具到环境 action 的映射。
- 自进化只能在 policy 层改变"如何调用这些工具"，不能改变工具本身。
- 候选 patch 触碰本目录即视为违规。

当前状态：占位，尚未实现。
