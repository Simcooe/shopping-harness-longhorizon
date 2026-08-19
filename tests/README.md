# tests

纯本地测试（不启动真实服务、环境或模型）。

已有：

- `test_smoke_parsing.py`：smoke 脚本对 reset/interact/release 响应的解析、
  报告构建与 goal 泄漏防护（16 个用例）。
- `test_development_tasks.py`：开发任务配置的加载、schema 校验、
  空 task_ids 拒绝与红线检查。

运行（仓库根目录）：

```bash
python3 -m unittest discover -s tests -p "test_*.py" -v
```

计划（后续实现）：

- 编辑面约束测试：候选 patch 不得触及声明编辑面之外的文件。
- patch 四性质检查：可 diff、可回放、可回滚、可审计。
- 冻结依赖完整性检查：DSH SHA 与 ShopSimulator source commit 与
  `DEPENDENCIES.md` 一致。
