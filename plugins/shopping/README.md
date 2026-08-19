# plugins/shopping

shopping plugin：本项目自进化（Self-Harness）的载体。插件内部有严格的
**冻结层 / 可进化层**边界，自进化系统只能触碰可进化层。

## 包结构

```
plugins/shopping/
├── package.json            # private 包；按 DSH bundle 机制声明 dsh.bundle.patch
├── cordis.patch.yml        # 空 Cordis patch 占位（未声明任何 overlay 键）
└── src/
    ├── index.ts            # 空入口占位：不注册工具、不调用环境
    ├── environment/        # 冻结层：环境接入与 HTTP client
    ├── tools/              # 冻结层：工具真实 schema 与 action mapping
    ├── observation/        # 冻结层：观测解析与结构化
    ├── rollout/            # 冻结层：rollout 执行与轨迹审计
    └── policy/             # 可进化层：唯一允许 Self-Harness 修改的源码目录
```

注：`tsconfig.json` 暂未创建（DSH 实际加载方式不直接消费 TS 源码）。

## 冻结层（不允许 Self-Harness patch）

- `src/environment/`：ShopSimulator 环境接入、HTTP client。
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

## 接入状态：尚未接入 DSH profile

DSH 的外部扩展机制是 **profile bundle**（依据：
`dsh/packages/boot/app-boot/src/profile.ts`、`dsh/apps/cli/src/plugin.ts`、
`dsh/packages/bundle/README.zh.md`）：bundle 是 npm 包，其 `package.json`
声明 `dsh.bundle.patch` 指向随包发布的 Cordis patch YAML；profile 在自身
`package.json` 的 `dsh.profile.bundles` 中列出 bundle，树外包通过
`dsh plugin --profile <name> add <package>` 安装。

本包现状（诚实声明，不伪造可运行配置）：

- `package.json` 按真实 bundle 机制声明了 `dsh.bundle.patch`，但
  `cordis.patch.yml` 是**空数组占位**，未声明任何 overlay 配置键；
- **不存在**引用本包的 DSH profile（没有 `dsh.profile.bundles` 接入）；
- 未执行过 `dsh plugin add`，未安装任何依赖，无 lockfile；
- `src/index.ts` 只有空导出（与 `@deepseek-ai/dsh-base` 的入口形态一致），
  不注册工具、不调用环境；
- 暂不提供 `tsconfig.json`：DSH 加载的是构建产物与 patch YAML，不直接
  消费 TS 源码；待真正实现与构建管线落地时再引入；
- DSH 处于 developer preview（固定 SHA，见 `DEPENDENCIES.md`），接入方式
  可能随上游变化。
