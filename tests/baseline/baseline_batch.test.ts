/**
 * h0 baseline 批量 evaluator 的离线生命周期测试：
 * 真实 orchestrator + 真实 run_live_task.sh + mock ShopSimulator + fake DSH。
 * 不调用真实模型、不读取真实 API key。
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type AddressInfo, type ServerResponse } from "node:http";
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SECRET = "SECRET-GOAL-gold-asin-xyz";

interface MockShopSim {
  url: string;
  events: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

function startMockShopSim(): Promise<MockShopSim> {
  const events: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      const payload = JSON.parse(body) as Record<string, unknown>;
      events.push({ ...payload, time: Date.now() });
      const respond = (result: Record<string, unknown>, response: ServerResponse) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ result }));
      };
      switch (payload["action"]) {
        case "reset":
          respond({
            env_idx: 7,
            instruction: `任务指令-task${String(payload["idx"])}（勿泄漏 ${SECRET}）`,
            goal_options: { 颜色: [SECRET] },
            environment_version: "shopsimulator-environment-v2.1",
            message: "ok",
            observation_state: { page_type: "search_home", search_available: true, actions: [] },
          }, res);
          return;
        case "interact":
          respond({
            env_idx: payload["env_idx"], done: false, over: false,
            observation_state: { page_type: "search_results", search_available: true, actions: [], products: [] },
          }, res);
          return;
        case "release_one":
          respond({ message: `Environment ${String(payload["env_idx"])} has been released` }, res);
          return;
        default:
          respond({ error: "unexpected" }, res);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        events,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

/** fake DSH：按 prompt 中的任务号决定退出码（task1 → exit 3，其余 0）。
 *  失败时把 API key 值写入 stderr（模拟真实 DSH 崩溃时的泄漏），供
 *  验证 baseline orchestrator 的 stderr 脱敏不打印密钥。 */
function makeFakeDsh(dir: string): string {
  const path = join(dir, "fake-dsh.js");
  writeFileSync(path, `#!/usr/bin/env node
const prompt = process.argv[4] ?? "";
const match = prompt.match(/任务指令-task(\\d+)/);
const taskNum = match ? parseInt(match[1], 10) : -1;
process.stderr.write("[fake-dsh] task " + taskNum + " failed key=" + (process.env.DEEPSEEK_API_KEY ?? "") + "\\n");
process.exit(taskNum === 1 ? 3 : 0);
`, "utf-8");
  chmodSync(path, 0o700);
  return path;
}

/** 临时 benchmark manifest：held-in [0,1]（task1 被 fake DSH 弄失败），held-out [2]。 */
function makeManifest(dir: string): string {
  const path = join(dir, "manifest.yml");
  writeFileSync(path, `schema_version: 1
benchmark_id: shopping-development-test
purpose: harness_development_only
harness_id: shopping-h0
harness_version: "0.1.0"
task_source: configs/tasks/development.json
held_in_task_ids: [0, 1]
held_out_task_ids: [2]
final_benchmark_excluded: true
split_selection_rationale: test split
max_environment_steps: 35
evaluation:
  repeats: 1
`, "utf-8");
  return path;
}

function makeEnvFile(dir: string, shopsimUrl: string): string {
  const path = join(dir, "test.env");
  writeFileSync(path, [
    `SHOPSIM_BASE_URL=${shopsimUrl}`,
    "MODEL_BASE_URL=https://model.example.invalid/v1",
    "MODEL_API_KEY=dummy-test-key-not-real",
    "MODEL_NAME=test-model",
    "",
  ].join("\n"), "utf-8");
  return path;
}

function runOrchestrator(args: string[], env: Record<string, string | undefined>): Promise<{
  status: number | null; stdout: string; stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn("node", ["scripts/baseline_orchestrator.ts", ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("exit", (code) => resolve({ status: code, stdout, stderr }));
  });
}

test("batch runner 未传 --live：直接退出、不调用模型", () => {
  const result = spawnSync("bash", ["scripts/run_h0_baseline_eval.sh", "--all"], {
    cwd: REPO_ROOT, encoding: "utf-8", timeout: 30_000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /--live/);
});

test("batch 生命周期：独立 run_id、单次 reset/release、失败不阻断、结果分离", async () => {
  const sim = await startMockShopSim();
  const dir = mkdtempSync(join(tmpdir(), "baseline-"));
  const baselineRunId = `baseline-test-${process.pid}`;
  const baselineDir = join(REPO_ROOT, "evaluation", "baselines", baselineRunId);
  try {
    const result = await runOrchestrator(
      ["--split", "all", "--manifest", makeManifest(dir), "--baseline-run-id", baselineRunId],
      {
        SHOPPING_ENV_FILE: makeEnvFile(dir, sim.url),
        SHOPPING_DSH_BIN: makeFakeDsh(dir),
        SHOPPING_LIVE_DIR: join(dir, "live"),
        SHOPSIM_BASE_URL: sim.url,
        MODEL_API_KEY: "dummy-test-key-not-real",
        SHOPPING_BASELINE_EVAL_CONFIG: join(REPO_ROOT, "configs", "evaluation", "h0-baseline-v1.yml"),
      },
    );
    assert.equal(result.status, 0, result.stderr);

    // 结果目录：manifest / held-in / held-out / summary 齐备
    for (const file of ["manifest.json", "held-in.json", "held-out.json", "summary.json"]) {
      assert.ok(existsSync(join(baselineDir, file)), `缺少 ${file}`);
    }
    const baselineManifest = JSON.parse(readFileSync(join(baselineDir, "manifest.json"), "utf-8")) as Record<string, unknown>;
    const summary = JSON.parse(readFileSync(join(baselineDir, "summary.json"), "utf-8")) as Record<string, unknown>;
    const heldIn = JSON.parse(readFileSync(join(baselineDir, "held-in.json"), "utf-8")) as Record<string, unknown>;
    const heldOut = JSON.parse(readFileSync(join(baselineDir, "held-out.json"), "utf-8")) as Record<string, unknown>;

    // 每 task 独立 run_id；task→run 映射完整
    const taskRunMap = baselineManifest["task_run_map"] as Array<Record<string, unknown>>;
    assert.equal(taskRunMap.length, 3);
    const runIds = taskRunMap.map((entry) => entry["run_id"]);
    assert.ok(runIds.every((runId) => typeof runId === "string" && runId !== null));
    assert.equal(new Set(runIds).size, 3);

    // 每 task 恰好一次 reset / 一次 release_one；绝无 release_all
    const resets = sim.events.filter((event) => event["action"] === "reset");
    const releases = sim.events.filter(
      (event) => event["action"] === "release_one" && event["env_idx"] !== 1000000000,
    );
    assert.equal(resets.length, 3);
    assert.equal(releases.length, 3);
    assert.ok(!sim.events.some((event) => event["action"] === "release_all"));

    // 状态分类：task1 runner 失败但其余继续；无 evaluator record → missing
    const heldInOutcomes = heldIn["outcomes"] as Array<Record<string, unknown>>;
    assert.equal(heldInOutcomes.length, 2);
    const byTask = new Map(heldInOutcomes.map((outcome) => [outcome["task_id"], outcome]));
    assert.equal(byTask.get(0)?.["status"], "missing_evaluator_record");
    assert.equal(byTask.get(1)?.["status"], "runner_failure");
    assert.equal(byTask.get(1)?.["runner_exit"], 3);
    const heldOutOutcomes = heldOut["outcomes"] as Array<Record<string, unknown>>;
    assert.equal(heldOutOutcomes.length, 1);
    assert.equal(heldOutOutcomes[0]?.["status"], "missing_evaluator_record");
    // held-out 文件带隔离声明
    assert.match(String(heldOut["usage_note"]), /绝不提供给 proposer/);

    // 汇总统计与 35 步记录
    const counts = summary["status_counts"] as Record<string, number>;
    assert.equal(counts["runner_failure"], 1);
    assert.equal(counts["missing_evaluator_record"], 2);
    assert.equal(summary["max_environment_steps"], 35);
    assert.equal(summary["harness_id"], "shopping-h0");
    assert.ok(String(summary["tool_surface_digest"]).startsWith("sha256:"));

    // 脱敏：所有结果文件不含秘密/目标内容
    for (const file of ["manifest.json", "held-in.json", "held-out.json", "summary.json"]) {
      const text = readFileSync(join(baselineDir, file), "utf-8");
      assert.ok(!text.includes(SECRET), `${file} 泄漏敏感内容`);
      assert.ok(!text.includes("dummy-test-key-not-real"), `${file} 泄漏 API key`);
      assert.ok(!text.includes("任务指令-task"), `${file} 泄漏任务文本`);
    }

    // 失败可观察性：runner 失败时，终端显示脱敏后的 stderr 摘要，不打印 API key
    assert.match(result.stderr, /\[baseline_orchestrator\] task 1 失败/);
    assert.match(result.stderr, /\[fake-dsh\] task 1 failed key=/);
    assert.ok(!result.stderr.includes("dummy-test-key-not-real"), "orchestrator stderr 泄漏 API key");
  } finally {
    await sim.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(baselineDir, { recursive: true, force: true });
    // 清理本测试产生的轨迹与 bootstrap 产物（按 run_id）
    if (existsSync(baselineDir)) {
      rmSync(baselineDir, { recursive: true, force: true });
    }
  }
});

test("h0 正式配置 35 步、smoke 配置仍 5 步", () => {
  const baselineConfig = readFileSync(
    join(REPO_ROOT, "configs", "evaluation", "h0-baseline-v1.yml"), "utf-8",
  );
  assert.match(baselineConfig, /max_environment_steps:\s*35/);
  const smokeConfig = readFileSync(
    join(REPO_ROOT, "configs", "live-task.example.yml"), "utf-8",
  );
  assert.match(smokeConfig, /max_environment_steps:\s*5/);
});
