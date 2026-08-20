# plugins/shopping

shopping plugin：本项目自进化（Self-Harness）的载体。插件内部有严格的
**冻结层 / 可进化层**边界，自进化系统只能触碰可进化层。

## 包结构

```
plugins/shopping/
├── package.json            # bundle 包：声明 dsh.bundle.patch（DSH 真实机制）
├── tsconfig.json           # 构建配置（ESM/NodeNext/strict，tsc 输出 lib/）
├── cordis.patch.yml        # bundle patch：挂载 shopping 函数插件行
└── src/
    ├── index.ts            # Cordis 函数插件入口：name/inject/apply（注册工具）
    ├── environment/        # 冻结层：环境接入与 HTTP client（已实现 adapter）
    ├── tools/              # 冻结层：工具 schema、action mapping、DSH 注册（已实现）
    ├── observation/        # 冻结层：观测投影与脱敏（已实现）
    ├── rollout/            # 冻结层：JSONL 轨迹审计与任务来源（已实现）
    └── policy/             # 可进化层：唯一允许 Self-Harness 修改的源码目录
```

构建与测试（本阶段只需可构建、可测试，不要求被 DSH 加载）：

```bash
pnpm --dir plugins/shopping install    # 首次
pnpm --dir plugins/shopping typecheck
pnpm --dir plugins/shopping build      # tsc → lib/
pnpm --dir plugins/shopping test       # mock 单元测试（node:test）
```

## 冻结层（不允许 Self-Harness patch）

- `src/environment/`：ShopSimulator 环境接入与 HTTP client。
  **已实现**（adapter：protocol/client/session），是本插件第一个落地的冻结层。
  - 只从 `SHOPSIM_BASE_URL` 读取地址（默认 `http://127.0.0.1:5700`），
    ShopSimulator 不使用任何 API key。
  - 当前只验证 HTTP 生命周期，不接 DSH、模型或 Self-Harness。
  - 工具调用到环境 action 的映射不属于本层：未来由 `src/tools/` 将模型
    工具调用映射为 `search[...]` / `click[...]` / `finish[...]`。
- `src/tools/`：工具**真实 schema**，以及 search/open/buy 等工具到环境
  action 的映射；不得修改工具真实语义。
- `src/observation/`：观测解析与结构化。
- `src/rollout/`：rollout 执行与轨迹审计逻辑。

项目级冻结层同样适用：DSH 源码、模型 adapter、ShopSimulator 源码、Reward、
环境 API（见根 README）。

## 可进化层（唯一允许 Self-Harness 修改的范围）

- `src/policy/`（本目录内）；
- `harnesses/*/shopping-policy.yml`；
- `harnesses/*/system-prompt.md`；
- 明确声明的 Cordis overlay 配置键。

自进化优化的是**工具使用协议、上下文组织、失败恢复与终止策略**，
不是环境或工具本身。

## policy 层计划中的四类策略（第一版编辑面，均未实现）

| 类别 | 内容 |
|---|---|
| **search** | 购物系统提示与工作流；查询构造、搜索与候选筛选策略 |
| **evidence** | 购买前证据核验；variant/规格与最终价格复查 |
| **recovery** | guard 拒绝处理、重复动作抑制、工具失败恢复 |
| **termination** | 探索预算、循环控制与终止策略 |

## 候选 patch 要求

每个候选 patch 必须可 diff、可回放、可回滚、可审计，且零触碰冻结层
（见根 README）。

## 12 个 model-facing 工具（冻结，见 src/tools/）

| 工具 | 环境 action |
|---|---|
| `search_products({ query })` | `search[query]` |
| `open_product({ asin })` | `click[asin]` |
| `select_option({ value })` | `click[value]` |
| `view_description({})` | `click[Description]` |
| `view_features({})` | `click[Features]` |
| `view_reviews({})` | `click[Reviews]` |
| `view_attributes({})` | `click[Attributes]` |
| `next_page({})` | `click[Next >]` |
| `prev_page({})` | `click[< Prev]` |
| `back_to_search({})` | `click[Back to Search]` |
| `buy_now({})` | `click[Buy Now]` |
| `finish_without_purchase({ reason })` | `finish[no_suitable_product]` |

冻结 action guard（`src/tools/guard.ts`）在调用环境前校验：asin/选项/按钮
必须来自模型上一轮**实际看到**的 actor-visible 观测；搜索不可用时拒绝
search；terminal 后拒绝一切调用；拒绝时不调用 ShopSimulator、不消耗步数，
只向模型返回安全纠正信息并写 actor trace 的 `guard_rejection`。

## 接入状态：已装配进 DSH profile，尚未执行真实模型

- 本包是 DSH 外部 **bundle**（`dsh.bundle.patch` 机制），
  `cordis.patch.yml` 挂载函数插件行；`src/index.ts` 以命名导出
  `name/inject/apply` 提供 Cordis 入口，`apply()` 通过
  `ctx.tools.register` 注册 12 个冻结工具。
- `harnesses/base/` 是引用本包的 **shopping-base profile**（DSH base +
  headless + shopping bundle + 冻结 system prompt）。
- 装配正确性由 `pnpm --dir plugins/shopping check:dsh` 离线校验；
  机制细节与限制见 `docs/dsh-shopping-plugin.md`。
- **尚未**执行真实 Cordis Loader boot、未接任何模型：npm registry 的
  DSH 包版本滞后于固定 SHA，真实 boot 留待版本对齐后执行。
- 下一步才是：填写本地模型 API 配置（环境变量，绝不入库），
  用 `dsh --profile shopping-base "<task>"` 真实运行单条任务。
