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

## 未来的安装与运行步骤（本阶段未执行）

1. 把本目录安装为 `$DSH_HOME/profiles/shopping-base`（`$DSH_HOME` 默认
   `~/.dsh`，可用环境变量 `DSH_HOME` 覆盖）；
2. 在 profile 目录内安装 bundle：
   `dsh plugin --profile shopping-base add <本仓库>/plugins/shopping`
   （相对路径 spec 以调用目录为锚点；安装器会校正 dependencies 与
   `dsh.profile.bundles`）；
3. 单任务运行（需要模型配置，见根 README 下一步）：
   `dsh --profile shopping-base "<task>"`；
4. 无模型配置检查：`dsh --profile shopping-base --dump-config`
   （官方无 boot、不求值 `!!js` 的 config dump 入口）。

## 已知限制（如实记录）

- npm registry 上 DSH 包版本滞后于本仓库固定的 commit：例如
  `@deepseek-ai/dsh-base` registry 为 `0.0.1-rc.1`，而固定 SHA 对应
  `0.1.0-rc.7`。在完成版本对齐（上游发布或本地构建链接）之前，
  上面的安装步骤**尚不能成功执行**；本仓库内以
  `scripts/check_dsh_shopping_plugin.ts`（在 plugins/shopping 内）做
  离线装配校验替代。
- task_id 由外部 runner 注入（`runner.json` 声明），模型不能决定任务。
- 本阶段未运行任何真实 DSH boot、模型或环境。
