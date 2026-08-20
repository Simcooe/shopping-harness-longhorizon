/**
 * shopping plugin 入口：DSH 外部 bundle 的 Cordis 函数插件。
 *
 * 形态依据（固定 DSH commit）：
 *   - docs/cordis-primer：函数插件 = 带可选 inject 与 apply(ctx) 的函数对象；
 *   - packages/AGENTS.md：函数插件必须命名导出 name/inject/apply，
 *     禁止 default export（混用会使 Loader 丢弃函数插件命名空间）；
 *   - 注册即效果：ctx.tools.register 内部已挂 ctx.effect，插件卸载时
 *     自动调用 disposer。
 *
 * bundle 挂载链（见 cordis.patch.yml 与 docs/dsh-shopping-plugin.md）：
 *   profile bundles → 本包 cordis.patch.yml insert 一行
 *   `- id: shopping; name: "@shopping-harness/plugin-shopping"` →
 *   Cordis Loader 按 bare specifier 导入本包 → 命名导出激活 apply()。
 *
 * 本入口不加入 policy/self-evolution 逻辑；不决定 task_id。
 */

import { registerShoppingTools, type DshToolRegistryLike } from "./tools/register.ts";
import { ShoppingRuntime } from "./tools/runtime.ts";

export const name = "shopping";

export const inject = ["tools"] as const;

/** apply 所需的最小上下文（真实 Cordis Context 的工具面）。 */
export interface ShoppingPluginContext {
  tools: DshToolRegistryLike;
}

/** 由 runner/宿主在 boot 前注入的运行时（无则按环境变量构造默认值）。 */
let injectedRuntime: ShoppingRuntime | null = null;

/** 外部 runner 注入运行时（含 client/recorder）；必须在 boot 前调用。 */
export function setShoppingRuntime(runtime: ShoppingRuntime | null): void {
  injectedRuntime = runtime;
}

export function getShoppingRuntime(): ShoppingRuntime {
  if (injectedRuntime === null) {
    // 默认运行时：只读 SHOPSIM_BASE_URL（无 API key），无记录器。
    injectedRuntime = new ShoppingRuntime();
  }
  return injectedRuntime;
}

/** Cordis 激活入口：注册三个冻结购物工具。 */
export function apply(ctx: ShoppingPluginContext): void {
  registerShoppingTools(ctx.tools, getShoppingRuntime());
}
