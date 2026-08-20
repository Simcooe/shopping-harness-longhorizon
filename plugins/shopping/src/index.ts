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
 * boot 时序（instruction-before-first-decision，固定 DSH 源码依据）：
 *   - dsh/packages/bundle/headless/src/startup.ts：headless task 文本来自
 *     CLI positional（runner 已把 bootstrap 的 instruction_text 放进 prompt）；
 *   - dsh/packages/bundle/headless/src/index.ts：runner 在插件激活之后才
 *     agents.create 并驱动首个 turn；
 *   因此 apply() 早于第一次模型请求。SHOPPING_BOOTSTRAP 模式下，apply()
 *   在此处接管 bootstrap 会话并记录 actor trace（run_start →
 *   task_instruction），保证 trace 与模型实际可见时序一致。
 *
 * 本入口不加入 policy/self-evolution 逻辑；不决定 task_id。
 */

import { registerShoppingTools, type DshToolRegistryLike } from "./tools/register.ts";
import { ShoppingRuntime } from "./tools/runtime.ts";
import { loadBootstrap } from "./rollout/bootstrap.ts";

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

/** Cordis 激活入口：bootstrap 接管（如有）+ 注册冻结购物工具。 */
export function apply(ctx: ShoppingPluginContext): void {
  const runtime = getShoppingRuntime();
  // bootstrap 模式：接管 runner 在 DSH 启动前 reset 的会话；
  // 接管发生在第一次模型请求之前，且插件此后绝不 reset。
  const bootstrapPath = process.env["SHOPPING_BOOTSTRAP"];
  if (bootstrapPath !== undefined && bootstrapPath.length > 0) {
    runtime.adoptBootstrap(loadBootstrap(bootstrapPath));
  }
  registerShoppingTools(ctx.tools, runtime);
}
