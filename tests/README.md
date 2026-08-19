# tests

脚手架与约束检查的测试（后续实现）。

计划包含：

- 编辑面约束测试：候选 patch 不得触及声明编辑面之外的文件。
- patch 四性质检查：可 diff、可回放、可回滚、可审计。
- 冻结依赖完整性检查：DSH SHA 与 ShopSimulator 路径与 `DEPENDENCIES.md` 一致。

当前状态：占位，尚无测试。
