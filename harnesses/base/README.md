# harnesses/base — 默认 Harness h0（shopping-h0）+ shopping-base profile

本目录承载两件事：

1. **默认 Harness h0 的 canonical 表示**（机器可读，唯一入口 `harness.yml`）：
   - `harness.yml`：schema_version / harness_id(shopping-h0) /
     parent_harness(null) / version / 四个文件引用 / editable_surfaces；
   - `tool-surface.yml`：模型工具的唯一配置来源。h0 恰好三个 primitive
     工具：`shop_search` / `shop_click` / `shop_finish`（冻结映射
     `search[...]` / `click[...]` / `finish[...]`）；
   - `system-prompt.md`：最小购物提示词（不含复杂策略——那是未来
     Self-Harness 可演化的内容）；
   - `runtime-policy.yml`：h0 正式 rollout 默认 35 步（与 live smoke 的
     5 步配置相互独立）；
   - `verification-policy.yml`：结束/评测边界红线，加载器拒绝放宽。
2. **shopping-base DSH profile**（`package.json` + `cordis.patch.yml`）：
   DSH base + headless + shopping bundle + 冻结 system prompt persona。

## 冻结面 vs 可编辑面

- **冻结**：DSH、ShopSimulator、plugin 的 environment/harness/tools/
  observation/rollout 源码、primitive action grammar、HTTP adapter、
  actor/evaluator 双轨迹隔离、task source、reward、模型权重与连接。
- **可编辑**（未来 candidate 的修改对象）：本目录的四个 harness 内容文件
  （system-prompt.md / tool-surface.yml / runtime-policy.yml /
  verification-policy.yml）与明确声明的 Cordis overlay 键。
  plugin 的 tool-surface resolver/validator 是冻结基础设施，不属于
  candidate 编辑面。

当前只实现 h0：不实现 candidate 自动加载或自动修改。
