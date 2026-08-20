# tests

纯本地测试（不启动真实服务、环境或模型）。

已有：

- `test_smoke_parsing.py`：Python smoke 脚本对 reset/interact/release 响应的
  解析、报告构建与 goal 泄漏防护（16 个用例）。
- `test_development_tasks.py`：开发任务配置的加载、schema 校验、
  空 task_ids 拒绝与红线检查。
- `environment/client.test.ts`、`environment/session.test.ts`：shopping
  plugin environment adapter 的 mock HTTP 测试（node:test，29 个用例），
  覆盖默认/自定义 base URL、reset/interact/release、服务端 error、
  malformed body、网络与 HTTP 失败、terminal 后拒绝 interact、
  异常路径 finally release、goal/observation 泄漏防护。

运行（仓库根目录）：

```bash
# Python 测试
python3 -m unittest discover -s tests -p "test_*.py" -v
# TypeScript adapter 测试
pnpm --dir plugins/shopping test
```

计划（后续实现）：

- 编辑面约束测试：候选 patch 不得触及声明编辑面之外的文件。
- patch 四性质检查：可 diff、可回放、可回滚、可审计。
- 冻结依赖完整性检查：DSH SHA 与 ShopSimulator source commit 与
  `DEPENDENCIES.md` 一致。
