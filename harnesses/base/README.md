# harnesses/base — shopping-base 基线 harness

冻结基线：**DSH base + headless 能力 + 外部 shopping plugin + 固定购物
system prompt**。本目录是 DSH 实际可识别的 profile 结构（依据固定 DSH
commit 的 `packages/boot/app-boot/src/profile.ts`）。

## 目录内容

| 文件 | 角色 |
|---|---|
| `package.json` | profile manifest：`private`、`dependencies`、`dsh.profile.bundles` |
| `cordis.patch.yml` | profile 层 patch：设置冻结的购物 system prompt（persona） |
| `system-prompt.md` | system prompt 的人类可读原文（与 patch 中 persona 一致） |
| `runner.json` | 任务 runner 配置：task_id 只能从 `configs/tasks/development.json` 由外部注入 |

## bundle 层叠顺序（固定 DSH commit 语义）

```
@deepseek-ai/dsh-base 的 patch
→ @deepseek-ai/dsh-headless 的 patch
→ @shopping-harness/plugin-shopping 的 patch（insert shopping 插件行）
→ 本目录 cordis.patch.yml（persona）
→ $DSH_HOME/cordis.patch.yml → --patch overlays（未来）
```

## 未来的安装与运行步骤（由 scripts/run_live_task.sh 自动执行）

1. 把本目录安装为 `$DSH_HOME/profiles/shopping-base`（runner 使用
   `.live/dsh-home`，不触碰 `~/.dsh`）；plugin 依赖改写为绝对 `file:` 路径；
2. 在 profile 目录内 `pnpm install` 安装 bundles（`@deepseek-ai/dsh-base@0.1.0-rc.7`、
   `@deepseek-ai/dsh-headless@0.1.0-rc.7` 已在 npm registry 发布，与固定
   SHA 版本一致；早前的 registry 滞后限制已解除）；
3. 单任务运行（需要模型配置）：`dsh --profile shopping-base "<task>"`，
   由 `bash scripts/run_live_task.sh --task-id <id> --live` 驱动；
4. 无模型配置检查：`dsh --profile shopping-base --dump-config`
   （官方无 boot、不求值 `!!js` 的 config dump 入口）。

## 已知限制（如实记录）

- 真实 boot 尚未在本仓库执行过：需要用户填写 `.env` 并显式 `--live`
  授权；本仓库不代为调用模型。
- task_id 由外部 runner 注入（`runner.json` 声明），模型不能决定任务。
- 环境任务指令向模型暴露的通道是下一增量（见 docs/dsh-shopping-plugin.md）。
