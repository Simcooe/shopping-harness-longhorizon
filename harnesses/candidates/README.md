# harnesses/candidates

候选 harness patch 的存放区。

硬性要求（缺一即拒绝）：

- **可 diff**：标准 diff 表达，仅触及 `plugins/shopping/` 声明的编辑面。
- **可回放**：附固定 seed / 任务子集与回放方式。
- **可回滚**：可干净撤销，不影响 base。
- **可审计**：附失败证据来源（轨迹引用）、生成记录与 gate 结果。

禁止使用 Final-200 Clean 参与候选生成或选择。

当前状态：占位，尚未实现。
