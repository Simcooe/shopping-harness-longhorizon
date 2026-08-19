# src/policy — 可进化层

shopping plugin 中**唯一**允许 Self-Harness 修改的源码目录。

自进化优化的是**工具使用协议、上下文组织、失败恢复与终止策略**；
不改变冻结层（environment / tools / observation / rollout）、环境、
Reward 或工具语义。

## 四类未来策略（第一版计划，均未实现）

1. **search**：购物系统提示与工作流；查询构造、搜索与候选筛选策略。
2. **evidence**：购买前证据核验；variant/规格与最终价格复查。
3. **recovery**：guard 拒绝处理、重复动作抑制、工具失败恢复。
4. **termination**：探索预算、循环控制与终止策略。

## 可进化范围的完整定义

除本目录外，Self-Harness 还可修改：

- `harnesses/*/shopping-policy.yml`
- `harnesses/*/system-prompt.md`
- 明确声明的 Cordis overlay 配置键

候选 patch 必须可 diff、可回放、可回滚、可审计（见根 README）。

当前状态：占位，尚未实现。
