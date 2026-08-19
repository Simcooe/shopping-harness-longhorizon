# trajectories

Rollout 轨迹与失败证据的存放区（后续实现）。

计划：

- 冻结 Agent 在 ShopSimulator 上执行购物任务的完整轨迹记录。
- 失败轨迹的结构化证据提取（failure evidence），作为候选 patch 的唯一输入来源。
- 任务子集仅使用 held-in / held-out 划分；**禁止使用 Final-200 Clean**。

当前状态：占位，尚无轨迹数据。
