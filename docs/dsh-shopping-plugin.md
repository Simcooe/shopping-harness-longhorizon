# DSH shopping plugin 接入说明

记录 shopping plugin 实际采用的 DSH 加载机制、关键 API 与命令。
全部依据**固定 DSH commit**（SHA 见 `DEPENDENCIES.md`）中的源码与文档，
未使用任何未验证的 API。

## 加载机制（profile + bundle）

依据：`dsh/packages/boot/app-boot/src/profile.ts`、
`dsh/packages/boot/app-boot/README.md`、`dsh/apps/cli/src/plugin.ts`、
`dsh/vendor/include/src/index.ts`。

1. profile 位于 `$DSH_HOME/profiles/<name>`（`DSH_HOME` 默认 `~/.dsh`），
   目录内含 `package.json`（`private`、`dependencies`、
   `dsh.profile.bundles`）与用户 `cordis.patch.yml`；启动器自动写出空根
   `cordis.yml`，不手工编辑。
2. bundle 是 npm 包，`package.json` 声明 `dsh.bundle.patch` 指向随包发布
   的 Cordis patch YAML（顶层数组）。`plugins/shopping` 即一个 bundle。
3. boot 时按 `dsh.profile.bundles` 顺序解析各 bundle 的 patch，层叠顺序：
   **bundle patches → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml`
   → `--patch` overlays**。patch 对目标行的 `config` 是**整体替换**，非合并。
4. patch 条目语法（`vendor/include`）：`insert` 无 id 时向根追加行；
   带 id 的 `insert` 目标是 group；非 insert 条目必须有 id，可携带
   `config`/`disabled` 等 overrides；`name` 是 Cordis Loader 要导入的
   模块 specifier（bare specifier 按安装位置解析）。
5. Cordis 函数插件：命名导出 `name` / `inject` / `apply(ctx)`，
   **禁止 default export**（混用会被 Loader 丢弃命名空间，见
   `dsh/packages/AGENTS.md`）。注册必须走 `ctx.effect()`/`ctx.on()`；
   `ctx.tools.register` 内部已挂 effect，返回 disposer。

## shopping bundle 的挂载链

```
harnesses/base/package.json          dsh.profile.bundles: [..., "@shopping-harness/plugin-shopping"]
plugins/shopping/package.json        dsh.bundle.patch: ./cordis.patch.yml
plugins/shopping/cordis.patch.yml    insert: id=shopping, name=@shopping-harness/plugin-shopping
plugins/shopping/lib/index.js        函数插件入口（name/inject=["tools"]/apply）
apply(ctx)                           loadHarness(SHOPPING_HARNESS_DIR ?? harnesses/base)
                                     ctx.tools.register(tool surface 定义的工具)
```

## shopping-only model tool surface（禁用 DSH base 默认工具）

shopping-base profile 是 **shopping-only 的模型可见工具面**：DSH base 仍然
提供全部运行时基础设施（tools registry、agent loop、headless runner、llm
adapter、session、system prompt、subprocess/sandbox 等），但其 **model-facing
默认工具**（bash、fs 读写、todo、goal、subagent、workflow、ralph、web_search、
exit_plan_mode 等）**不向模型暴露**。

实现方式：`harnesses/base/cordis.patch.yml` 用固定 DSH 支持的
`disabled: true` row override（与 dsh-headless 对 `hmr` 的用法一致）逐项禁用
DSH base 的所有 model-facing tool row。被禁用的 18 个 row 与固定 DSH base
bundle（`dsh/packages/bundle/base/cordis.patch.yml`）的 model-facing tool row
一一对应，清单见 `plugins/shopping/src/harness/profile_tool_surface.ts`
（`DEFAULT_MODEL_FACING_TOOL_ROWS`，含不以 `tool-` 开头的 `plan-mode`）。

禁用只作用于这些 row 的模型工具注册，**不**影响 DSH tools registry 本身、
agent loop、headless runner、llm adapter、session、system prompt、shopping
plugin 或 ShopSimulator adapter。结果是模型请求中的 tool schema 恰好只有：

```
shop_search
shop_click
shop_finish
```

原因：h0 要严格控制工具面，并避免 provider（如 DeepSeek V4 Pro）对无关
默认工具 schema 的兼容性问题（例如 `get_goal` 的空参数 schema 会被拒）。
离线校验：`pnpm --dir plugins/shopping check:dsh`（断言 profile patch 已禁用
全部默认 model-facing tool row，且 h0 注册的工具恰好三个）。

## 工具注册 API

依据：`dsh/packages/core/tools/src/index.ts`（`ToolRuntime`、
`ToolDefinition`、`register(definition): () => void`）、
`dsh/packages/llm/llm/src/types.ts`（`ToolSchema`、`TextBlock`）、
`dsh/docs/cookbook/adding-a-tool.md`、`dsh/packages/todo/tool-todo/`。

- 注册面：`ctx.tools.register(definition)`，definition 形如
  `{name, description, parameters(JSON Schema), output:{schema, render}, execute}`。
  注册表接受原始 JSON Schema 的 ToolDefinition，此时**注册方自行负责
  参数校验**（我们在 execute 入口用冻结的 `validateToolArgs` 完成）。
- `tool/call` 与 `tool/result` 由 agent-loop 自动写入 session log
  （`dsh/packages/core/agent-loop/src/tool-calls.ts`），普通工具无需
  手动 emit；满足 "Model-visible ⟺ logged"。
- 我们的 `register.ts` 用本地结构类型对齐上述形状，而不是 import
  `@deepseek-ai/dsh-tools`：npm registry 版本（如 dsh-tools/dsh-base
  0.0.1-rc.1）落后于固定 commit（0.1.0-rc.7），直接安装会 API 漂移；
  registry 对齐后可无缝换回官方 import。

## 命令

| 目的 | 命令 |
|---|---|
| 离线装配检查（无模型、无 boot） | `pnpm --dir plugins/shopping check:dsh` |
| mock 单元/集成测试 | `pnpm --dir plugins/shopping test:all` |
| adapter live smoke（需先启动环境） | `pnpm --dir plugins/shopping smoke-shopping-adapter --live` |
| （未来）官方无 boot config dump | `dsh --profile shopping-base --dump-config` |
| （未来）安装外部 bundle | `dsh plugin --profile shopping-base add <path>` |
| （未来）单任务运行（需模型配置） | `dsh --profile shopping-base "<task>"` |

## live task 运行路径（scripts/run_live_task.sh）

依据固定 DSH commit 的真实能力（`dsh/CLAUDE.md`：官方 adapter 读取
`DEEPSEEK_API_KEY`，可选 `DEEPSEEK_BASE_URL`）：

1. runner 加载未提交的 `.env`，把 `MODEL_API_KEY/MODEL_BASE_URL` 映射为
   `DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL` 传给 headless DSH；
2. DSH CLI 使用官方发布的 `@deepseek-ai/dsh@0.1.0-rc.7`（npm registry
   现已发布与固定 SHA 一致的 0.1.0-rc.7 系列；早前"registry 滞后"的
   限制已解除），安装在 `.live/cli/`（gitignore）；
3. profile 由 `harnesses/base/` 复制到 `.live/dsh-home/profiles/shopping-base`
   （plugin 依赖改写为绝对 `file:` 路径），`pnpm install` 安装 bundles；
4. **bootstrap 时序（instruction 先于第一次模型决策）**：runner 在启动
   DSH 之前对环境 reset 一次（整个 run 唯一一次），把 actor-safe 的
   `{run_id, task_id, env_idx, instruction_text}` 写入
   `.live/runs/<run_id>/bootstrap.json`（0600，按 run 隔离）；`instruction_text` 以
   `<shopping_task>` 边界注入 DSH 初始 prompt，由
   `scripts/launch_dsh_task.ts` 经 spawn argv 数组传递（无 shell 注入面）；
   plugin 在 apply()（第一次模型请求之前）读取 bootstrap 并接管同一
   `env_idx`，绝不二次 reset（`SHOPPING_BOOTSTRAP` 模式下插件自行 reset
   会被拒绝）。task_id 必须属于 `configs/tasks/development.json`；
   步数上限 `SHOPPING_MAX_STEPS`（live-task 配置默认 5）；
5. cleanup（正常/异常/Ctrl-C）只 `release_one` bootstrap 的 `env_idx`
   （幂等）；绝不使用 `release_all`，避免影响其他并发任务。

## 默认 Harness h0（canonical 表示）

h0 是机器可读的最小默认 Harness，目录 `harnesses/base/`：

- `harness.yml` — 唯一入口：schema_version、harness_id(shopping-h0)、
  parent_harness(null)、version、四个文件引用、editable_surfaces 白名单；
- `tool-surface.yml` — 模型工具的唯一配置来源；h0 恰好三个工具
  （shop_search/shop_click/shop_finish），每个工具有 name/primitive/
  description/parameters/binding；primitive 枚举冻结为 search/click/finish，
  binding 必须恰好绑定 primitive 的唯一参数；
- `system-prompt.md` — 最小购物提示词（无复杂策略）；
- `runtime-policy.yml` — 最小运行时策略（h0 正式 rollout 默认
  max_environment_steps: 35；live smoke 配置仍为 5 步，两者独立）；
- `verification-policy.yml` — 结束/评测边界红线（environment done 才算
  完成、reward 只在 evaluator、actor 不见 reward、finish ≠ 成功、
  evaluator 不回灌同一 rollout）；加载器会拒绝放宽这些红线的 harness。

冻结基础设施（`plugins/shopping/src/harness/surface.ts`）负责加载与校验；
harness 的 YAML/md 内容才是未来 candidate 可修改对象。plugin 在 apply()
时装载 harness（`SHOPPING_HARNESS_DIR` 可覆盖，默认 harnesses/base），
并按 surface 注册工具；tool-surface digest 记入 actor trace 的 run_start。

### 已知限制（如实记录）

- ~~环境任务指令不向模型暴露~~：**已解决（bootstrap 时序）**——runner 在
  DSH 启动前 reset 并把 `instruction_text` 注入初始 prompt；模型第一次
  决策即看到真实任务文本。隐藏字段（goal 结构、gold asin、reward、
  purchase、persona 等）仍严格剔除，bootstrap 只保存 actor-safe 字段。
- `MODEL_NAME` 与 temperature 目前只记录进 run metadata；与 adapter
  模型选择/采样参数的绑定需验证 profile 的 llm 配置行后接入。
- `check:dsh` 仍是离线装配校验；真实 boot 的验证以用户 `.env` 就绪后的
  live 运行为准。
- 模型退出时若未触发 terminal（如达到 DSH 轮次上限），evaluator record
  不会落盘（actor trace 已逐事件落盘）；环境租约由 runner EXIT trap 的
  `release_one`（bootstrap env_idx）兜底。

## Phase 6 双轨迹

- **actor trace**：`trajectories/actor/<run_id>.jsonl`（schema v2）。
  事件：run_start / task_instruction / tool_call / guard_rejection /
  observation / terminal。与模型实际可见内容一致，供未来失败挖掘。
- **evaluator record**：`evaluation/runs/<run_id>.json`。
  环境 reward / reward 类型 / 有效性 / 终止原因 / 步数 / guard 统计 /
  失败标签（wrong_purchase / repeat_loop / max_steps / early_abstain /
  graceful_stop / environment_error / tool_error / gold_purchase /
  valid_alternative_purchase / unknown）。
- **隔离是结构性的**：evaluator 证据只经 `ShopSimulatorHttpClient` 的
  `evaluatorSink` 流入 `EvaluatorCollector`；`register.ts`/tools/observation
  层的类型上不存在 evaluator 数据入口，因此不可能作为同一任务的
  tool result 或 prompt 回灌模型。
