/**
 * bootstrap 生命周期离线测试：驱动真实 scripts（helper/launcher/cleanup/
 * run_live_task.sh），全部使用 mock ShopSimulator 与 fake DSH；
 * 不启动真实模型、不读取真实 API key。
 *
 * 覆盖：
 *   L1  正常退出：cleanup 执行、只 release_one 当前 env_idx、文件删除
 *   L2  非零退出：退出码保留、cleanup 仍执行
 *   L3  只向 launcher PID 发信号：launcher 转发给 fake DSH 并等待其退出
 *   L4  只向 bash runner PID 发信号：runner→launcher→fake DSH 逐级转发，
 *       cleanup 严格发生在 fake DSH 退出之后（SIGTERM=143 / SIGINT=130）
 *   L5  helper 写失败时自动 release；release 也失败 → recovery record
 *   L6  cleanup 不可达：非零、文件保留、可重试
 *   L7  cleanup 幂等；bootstrap 不可读（目录/无权限）不误判为"已清理"
 *   L8  不同 run 真正并发（Promise.all）：路径/env_idx/instruction 不错配
 *   L9  run_id 路径穿越在 reset 之前拒绝
 *   L10 目标已存在：拒绝覆盖、新 env_idx 释放、原文件不变
 *   L11 同一目标真正并发写（Promise.all + reset barrier）：恰好一个胜出
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type AddressInfo, type ServerResponse } from "node:http";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// mock ShopSimulator（带时间戳、可注入 release 失败、reset barrier）
// ---------------------------------------------------------------------------

interface MockShopSim {
  url: string;
  events: Array<Record<string, unknown>>;
  flags: { failRelease: boolean };
  setResetBarrier: (count: number) => void;
  close: () => Promise<void>;
}

function startMockShopSim(): Promise<MockShopSim> {
  const events: Array<Record<string, unknown>> = [];
  const flags = { failRelease: false };
  let nextEnv = 7;
  let barrierTarget = 0;
  let barrierSeen = 0;
  const pendingResets: Array<{ envIdx: number; res: ServerResponse }> = [];

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
        case "reset": {
          const envIdx = nextEnv++;
          const result = {
            env_idx: envIdx,
            instruction: `任务指令-task${String(payload["idx"])}`,
            environment_version: "shopsimulator-environment-v2.1",
            message: "ok",
            observation_state: { page_type: "search_home", search_available: true, actions: [] },
          };
          if (barrierTarget > 0 && barrierSeen < barrierTarget) {
            barrierSeen += 1;
            if (barrierSeen < barrierTarget) {
              pendingResets.push({ envIdx, res });
              return; // 扣留响应，直到 barrier 达成
            }
            for (const pending of pendingResets) {
              respond({ ...result, env_idx: pending.envIdx }, pending.res);
            }
            pendingResets.length = 0;
          }
          respond(result, res);
          return;
        }
        case "interact":
          respond({
            env_idx: payload["env_idx"], done: false, over: false,
            observation_state: { page_type: "search_results", search_available: true, actions: [], products: [] },
          }, res);
          return;
        case "release_one":
          if (flags.failRelease) {
            respond({ error: "mock release failed" }, res);
          } else {
            respond({ message: `Environment ${String(payload["env_idx"])} has been released` }, res);
          }
          return;
        default:
          respond({ error: `unexpected ${String(payload["action"])}` }, res);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        events,
        flags,
        setResetBarrier: (count) => { barrierTarget = count; barrierSeen = 0; },
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// fake DSH 与脚本驱动
// ---------------------------------------------------------------------------

function makeFakeDsh(dir: string): string {
  const path = join(dir, "fake-dsh.js");
  writeFileSync(path, `#!/usr/bin/env node
const fs = require("fs");
const marker = process.env.FAKE_DSH_MARKER;
fs.writeFileSync(marker, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }));
const code = parseInt(process.env.FAKE_DSH_EXIT ?? "0", 10);
const sleepMs = parseInt(process.env.FAKE_DSH_SLEEP_MS ?? "0", 10);
if (sleepMs > 0) {
  const mark = (sig) => {
    fs.appendFileSync(marker, "\\n" + JSON.stringify({ signal: sig, exitTime: Date.now() }));
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", () => mark("SIGINT"));
  process.on("SIGTERM", () => mark("SIGTERM"));
  fs.writeFileSync(marker + ".ready", "1");
  setTimeout(() => process.exit(code), sleepMs);
} else {
  process.exit(code);
}
`, "utf-8");
  chmodSync(path, 0o700);
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

interface ScriptResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** 异步运行脚本：不阻塞测试事件循环（mock server 与测试同进程）。 */
function runScript(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 90_000,
): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`脚本超时（${timeoutMs}ms）: ${command} ${args.join(" ")}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
  });
}

/** 可发信号的异步 spawn：返回 child 句柄与结果 promise。 */
function spawnScript(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
): { child: ReturnType<typeof spawn>; result: Promise<ScriptResult> } {
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const result = new Promise<ScriptResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("exit", (code) => resolve({ status: code, stdout, stderr }));
  });
  return { child, result };
}

function runRunner(options: {
  envFile: string;
  fakeDsh: string;
  liveDir: string;
  shopsimUrl: string;
  fakeExit?: number;
  marker: string;
}): Promise<ScriptResult> {
  return runScript("bash", ["scripts/run_live_task.sh", "--task-id", "0", "--live"], {
    SHOPPING_ENV_FILE: options.envFile,
    SHOPPING_DSH_BIN: options.fakeDsh,
    SHOPPING_LIVE_DIR: options.liveDir,
    SHOPSIM_BASE_URL: options.shopsimUrl,
    FAKE_DSH_EXIT: String(options.fakeExit ?? 0),
    FAKE_DSH_MARKER: options.marker,
  });
}

function bootstrapFiles(liveDir: string): string[] {
  const runsDir = join(liveDir, "runs");
  if (!existsSync(runsDir)) {
    return [];
  }
  return readdirSync(runsDir).map((entry) => join(runsDir, entry, "bootstrap.json"));
}

function realReleases(sim: MockShopSim): Array<Record<string, unknown>> {
  return sim.events.filter(
    (event) => event["action"] === "release_one" && event["env_idx"] !== 1000000000,
  );
}

async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待文件超时: ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function readMarkerSignals(marker: string): Array<{ signal: string; exitTime: number }> {
  const lines = readFileSync(marker, "utf-8").split("\n").filter((line) => line.startsWith("{"));
  return lines.slice(1).map((line) => JSON.parse(line) as { signal: string; exitTime: number });
}

function firstMarkerPayload(marker: string): { argv: string[]; pid: number } {
  return JSON.parse(readFileSync(marker, "utf-8").split("\n")[0]) as { argv: string[]; pid: number };
}

// ---------------------------------------------------------------------------
// L1/L2. 完整 runner：正常与非零退出
// ---------------------------------------------------------------------------

test("L1. 正常退出（环境未 terminal）：cleanup 执行、只 release 当前 env_idx、文件删除", async () => {
  const sim = await startMockShopSim();
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  try {
    const marker = join(dir, "dsh-marker.json");
    const result = await runRunner({
      envFile: makeEnvFile(dir, sim.url),
      fakeDsh: makeFakeDsh(dir),
      liveDir: join(dir, "live"),
      shopsimUrl: sim.url,
      fakeExit: 0,
      marker,
    });
    assert.equal(result.status, 0, result.stderr);

    const resets = sim.events.filter((event) => event["action"] === "reset");
    const releases = realReleases(sim);
    assert.equal(resets.length, 1);
    assert.equal(releases.length, 1);
    assert.equal(releases[0]?.["env_idx"], 7);
    assert.ok(!sim.events.some((event) => event["action"] === "release_all"));
    assert.deepEqual(bootstrapFiles(join(dir, "live")), []);

    const dshCall = firstMarkerPayload(marker);
    assert.equal(dshCall.argv.length, 3);
    assert.ok(dshCall.argv[2].includes("<shopping_task>"));
    assert.ok(dshCall.argv[2].includes("任务指令-task0"));
  } finally {
    await sim.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("L2. DSH 非零退出：cleanup 仍执行、保留原始退出码、文件删除", async () => {
  const sim = await startMockShopSim();
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  try {
    const result = await runRunner({
      envFile: makeEnvFile(dir, sim.url),
      fakeDsh: makeFakeDsh(dir),
      liveDir: join(dir, "live"),
      shopsimUrl: sim.url,
      fakeExit: 3,
      marker: join(dir, "m.json"),
    });
    assert.equal(result.status, 3);
    const releases = realReleases(sim);
    assert.equal(releases.length, 1);
    assert.equal(releases[0]?.["env_idx"], 7);
    assert.deepEqual(bootstrapFiles(join(dir, "live")), []);
  } finally {
    await sim.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// L3. 只 kill launcher PID：launcher 必须转发信号并等待 child
// ---------------------------------------------------------------------------

test("L3. 只向 launcher PID 发 SIGTERM/SIGINT：转发给 fake DSH、无孤儿、按惯例退出", async () => {
  for (const [signal, expectedExit, markerTag] of [
    ["SIGTERM", 143, "SIGTERM"],
    ["SIGINT", 130, "SIGINT"],
  ] as Array<[NodeJS.Signals, number, string]>) {
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
    try {
      const marker = join(dir, "dsh-marker.json");
      const bootstrapPath = join(dir, "bootstrap.json");
      writeFileSync(bootstrapPath, JSON.stringify({
        schema_version: 1, run_id: "run-l3", task_id: 0, env_idx: 7,
        instruction_text: "任务",
      }), "utf-8");

      const { child, result } = spawnScript("node", [
        "scripts/launch_dsh_task.ts", "--dsh-bin", makeFakeDsh(dir),
      ], {
        SHOPPING_BOOTSTRAP: bootstrapPath,
        FAKE_DSH_SLEEP_MS: "30000",
        FAKE_DSH_MARKER: marker,
      });
      assert.ok(child.pid !== undefined);

      await waitForFile(marker);
      await waitForFile(marker + ".ready");
      const dshPid = firstMarkerPayload(marker).pid;

      // 只向 launcher PID 发信号（不发进程组；fake DSH 只能经 launcher 转发收到）
      process.kill(child.pid!, signal);
      const launcherResult = await result;
      assert.equal(launcherResult.status, expectedExit, `launcher ${signal} 退出码`);

      const signals = readMarkerSignals(marker);
      assert.equal(signals.length, 1);
      assert.equal(signals[0]?.["signal"], markerTag);
      assert.throws(() => process.kill(dshPid, 0), undefined, "fake DSH 不应残留");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// L4. 只 kill bash runner PID：逐级转发，cleanup 严格在 fake DSH 退出之后
// ---------------------------------------------------------------------------

test("L4. 只向 runner PID 发信号：逐级转发、cleanup 在 child 退出后、退出码 143/130", async () => {
  for (const [signal, expectedExit, markerTag] of [
    ["SIGTERM", 143, "SIGTERM"],
    ["SIGINT", 130, "SIGINT"],
  ] as Array<[NodeJS.Signals, number, string]>) {
    const sim = await startMockShopSim();
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
    try {
      const marker = join(dir, "dsh-marker.json");
      const { child, result } = spawnScript("bash", [
        "scripts/run_live_task.sh", "--task-id", "0", "--live",
      ], {
        SHOPPING_ENV_FILE: makeEnvFile(dir, sim.url),
        SHOPPING_DSH_BIN: makeFakeDsh(dir),
        SHOPPING_LIVE_DIR: join(dir, "live"),
        SHOPSIM_BASE_URL: sim.url,
        FAKE_DSH_SLEEP_MS: "30000",
        FAKE_DSH_MARKER: marker,
      });
      assert.ok(child.pid !== undefined);

      await waitForFile(marker);
      await waitForFile(marker + ".ready");
      const dshPid = firstMarkerPayload(marker).pid;

      // 只向 bash runner PID 发信号（不发进程组）
      process.kill(child.pid!, signal);
      const runnerResult = await result;
      assert.equal(runnerResult.status, expectedExit, `runner ${signal} 退出码`);

      const signals = readMarkerSignals(marker);
      assert.equal(signals.length, 1);
      assert.equal(signals[0]?.["signal"], markerTag);
      assert.throws(() => process.kill(dshPid, 0), undefined, "fake DSH 不应残留");

      // cleanup 严格发生在 fake DSH 退出之后，且只释放一次
      const releases = realReleases(sim);
      assert.equal(releases.length, 1);
      assert.equal(releases[0]?.["env_idx"], 7);
      assert.ok(
        (releases[0]?.["time"] as number) >= (signals[0]?.["exitTime"] as number),
        "cleanup 必须发生在 fake DSH 退出之后",
      );
      assert.ok(!sim.events.some((event) => event["action"] === "release_all"));
      assert.deepEqual(bootstrapFiles(join(dir, "live")), []);
    } finally {
      await sim.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// L5. helper 写失败：自动 release；release 也失败 → recovery record
// ---------------------------------------------------------------------------

test("L5a. helper 写失败且 release 成功：释放 env_idx，无 recovery record", async () => {
  const sim = await startMockShopSim();
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  try {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x", "utf-8");
    const badOutput = join(blocker, "bootstrap.json");

    const result = await runScript("node", [
      "scripts/bootstrap_live_session.ts",
      "--task-id", "0", "--run-id", "run-l5a", "--output", badOutput,
    ], { SHOPSIM_BASE_URL: sim.url, SHOPPING_LIVE_DIR: join(dir, "live") }, 30_000);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("已释放"));
    const releases = realReleases(sim);
    assert.equal(releases.length, 1);
    assert.equal(releases[0]?.["env_idx"], 7);
    assert.ok(!existsSync(badOutput));
  } finally {
    await sim.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("L5b. helper 写失败且 release 也失败：不声称已释放，写 recovery record，恢复后可清理", async () => {
  const sim = await startMockShopSim();
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  const liveDir = join(dir, "live");
  try {
    sim.flags.failRelease = true;
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x", "utf-8");
    const badOutput = join(blocker, "bootstrap.json");

    const result = await runScript("node", [
      "scripts/bootstrap_live_session.ts",
      "--task-id", "0", "--run-id", "run-l5b", "--output", badOutput,
    ], { SHOPSIM_BASE_URL: sim.url, SHOPPING_LIVE_DIR: liveDir }, 30_000);
    assert.notEqual(result.status, 0);
    // 绝不输出错误的"已释放"
    assert.ok(!result.stderr.includes("已释放"), `stderr 不应声称已释放: ${result.stderr}`);
    assert.ok(result.stderr.includes("尚未确认释放"));

    // recovery record：0600、仅 actor-safe 字段、可被 cleanup 读取
    const recoveryDir = join(liveDir, "recovery");
    const recoveryFiles = readdirSync(recoveryDir);
    assert.equal(recoveryFiles.length, 1, `recovery 目录内容: ${JSON.stringify(recoveryFiles)}`);
    const recoveryPath = join(recoveryDir, recoveryFiles[0]!);
    assert.equal(recoveryFiles[0], "run-l5b-env-7.json");
    assert.equal(statSync(recoveryPath).mode & 0o777, 0o600);
    const recovery = JSON.parse(readFileSync(recoveryPath, "utf-8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(recovery).sort(), [
      "env_idx", "instruction_text", "run_id", "schema_version", "task_id",
    ]);
    assert.equal(recovery["env_idx"], 7);

    // ShopSimulator 恢复后：用 cleanup 读取 recovery record 完成释放并删除
    sim.flags.failRelease = false;
    const cleanupResult = await runScript("node", ["scripts/cleanup_live_session.ts"], {
      SHOPPING_BOOTSTRAP: recoveryPath, SHOPSIM_BASE_URL: sim.url,
    }, 30_000);
    assert.equal(cleanupResult.status, 0, cleanupResult.stderr);
    assert.ok(!existsSync(recoveryPath));
    // env_idx=7 共两次 release 请求：helper 的一次（失败）+ cleanup 的一次（成功）
    const releases = realReleases(sim).filter((event) => event["env_idx"] === 7);
    assert.equal(releases.length, 2);
  } finally {
    await sim.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// L6/L7. cleanup：不可达保留文件；幂等；不可读文件不误判
// ---------------------------------------------------------------------------

test("L6. cleanup 时 ShopSimulator 不可达：非零退出、文件保留、可重试", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  try {
    const bootstrapPath = join(dir, "live", "runs", "run-l6", "bootstrap.json");
    mkdirSync(join(dir, "live", "runs", "run-l6"), { recursive: true });
    writeFileSync(bootstrapPath, JSON.stringify({
      schema_version: 1, run_id: "run-l6", task_id: 0, env_idx: 7,
      instruction_text: "任务",
    }), "utf-8");

    const env = {
      SHOPPING_BOOTSTRAP: bootstrapPath,
      SHOPSIM_BASE_URL: "http://127.0.0.1:59999",
    };
    const first = await runScript("node", ["scripts/cleanup_live_session.ts"], env, 30_000);
    assert.notEqual(first.status, 0);
    assert.ok(existsSync(bootstrapPath));
    assert.match(first.stderr, /重试/);

    const second = await runScript("node", ["scripts/cleanup_live_session.ts"], env, 30_000);
    assert.notEqual(second.status, 0);
    assert.ok(existsSync(bootstrapPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("L7a. cleanup 幂等：文件不存在成功退出；缺变量/非法内容明确失败", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  try {
    const missing = join(dir, "no-such-bootstrap.json");
    const result = await runScript("node", ["scripts/cleanup_live_session.ts"], {
      SHOPPING_BOOTSTRAP: missing,
    }, 30_000);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /视为已清理/);

    const noEnv = await runScript("node", ["scripts/cleanup_live_session.ts"], {
      SHOPPING_BOOTSTRAP: "",
    }, 30_000);
    assert.notEqual(noEnv.status, 0);

    const badPath = join(dir, "bad.json");
    writeFileSync(badPath, "{not json", "utf-8");
    const bad = await runScript("node", ["scripts/cleanup_live_session.ts"], {
      SHOPPING_BOOTSTRAP: badPath,
    }, 30_000);
    assert.notEqual(bad.status, 0);
    assert.ok(existsSync(badPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("L7b. bootstrap 路径为目录或不可读：不误判为已清理、不发送 release_one", async () => {
  const sim = await startMockShopSim();
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  try {
    // 情形 1：路径指向目录（EISDIR）
    const dirPath = join(dir, "bootstrap-dir");
    mkdirSync(dirPath, { recursive: true });
    const r1 = await runScript("node", ["scripts/cleanup_live_session.ts"], {
      SHOPPING_BOOTSTRAP: dirPath, SHOPSIM_BASE_URL: sim.url,
    }, 30_000);
    assert.notEqual(r1.status, 0);
    assert.ok(!r1.stderr.includes("视为已清理"));
    assert.ok(!r1.stderr.includes("released"));
    assert.ok(existsSync(dirPath));

    // 情形 2：文件存在但不可读（EACCES）
    const unreadable = join(dir, "unreadable.json");
    writeFileSync(unreadable, "{}", "utf-8");
    chmodSync(unreadable, 0o000);
    const r2 = await runScript("node", ["scripts/cleanup_live_session.ts"], {
      SHOPPING_BOOTSTRAP: unreadable, SHOPSIM_BASE_URL: sim.url,
    }, 30_000);
    assert.notEqual(r2.status, 0);
    assert.ok(!r2.stderr.includes("视为已清理"));
    assert.ok(existsSync(unreadable));

    // 两种情形都没有发送 release_one
    assert.equal(realReleases(sim).length, 0);
  } finally {
    await sim.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// L8. 不同 run 真正并发（Promise.all 同时启动）
// ---------------------------------------------------------------------------

test("L8. 不同 run 真正并发：路径/env_idx/instruction 不错配，各自释放自己的 env_idx", async () => {
  const sim = await startMockShopSim();
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  const liveDir = join(dir, "live");
  try {
    const [r1, r2] = await Promise.all([
      runScript("node", ["scripts/bootstrap_live_session.ts", "--task-id", "0", "--run-id", "run-alpha"],
        { SHOPSIM_BASE_URL: sim.url, SHOPPING_LIVE_DIR: liveDir }, 30_000),
      runScript("node", ["scripts/bootstrap_live_session.ts", "--task-id", "0", "--run-id", "run-beta"],
        { SHOPSIM_BASE_URL: sim.url, SHOPPING_LIVE_DIR: liveDir }, 30_000),
    ]);
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(r2.status, 0, r2.stderr);

    const h1 = JSON.parse(r1.stdout) as { bootstrapPath: string; envIdx: number };
    const h2 = JSON.parse(r2.stdout) as { bootstrapPath: string; envIdx: number };
    assert.notEqual(h1.bootstrapPath, h2.bootstrapPath);
    assert.notEqual(h1.envIdx, h2.envIdx);
    assert.ok(h1.bootstrapPath.includes("/runs/run-alpha/"));
    assert.ok(h2.bootstrapPath.includes("/runs/run-beta/"));

    const b1 = JSON.parse(readFileSync(h1.bootstrapPath, "utf-8")) as Record<string, unknown>;
    const b2 = JSON.parse(readFileSync(h2.bootstrapPath, "utf-8")) as Record<string, unknown>;
    assert.equal(b1["run_id"], "run-alpha");
    assert.equal(b2["run_id"], "run-beta");
    assert.equal(b1["env_idx"], h1.envIdx);
    assert.equal(b2["env_idx"], h2.envIdx);

    const [c1, c2] = await Promise.all([
      runScript("node", ["scripts/cleanup_live_session.ts"],
        { SHOPPING_BOOTSTRAP: h1.bootstrapPath, SHOPSIM_BASE_URL: sim.url }, 30_000),
      runScript("node", ["scripts/cleanup_live_session.ts"],
        { SHOPPING_BOOTSTRAP: h2.bootstrapPath, SHOPSIM_BASE_URL: sim.url }, 30_000),
    ]);
    assert.equal(c1.status, 0, c1.stderr);
    assert.equal(c2.status, 0, c2.stderr);
    assert.deepEqual(
      realReleases(sim).map((event) => event["env_idx"]).sort((a, b) => Number(a) - Number(b)),
      [h1.envIdx, h2.envIdx].sort((a, b) => a - b),
    );
    assert.ok(!sim.events.some((event) => event["action"] === "release_all"));
  } finally {
    await sim.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// L9. 路径穿越（helper 侧，reset 之前拒绝）
// ---------------------------------------------------------------------------

test("L9. run_id 路径穿越在 reset 之前被拒绝", async () => {
  const sim = await startMockShopSim();
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  try {
    for (const badRunId of ["../x", "a/b"]) {
      const result = await runScript("node", [
        "scripts/bootstrap_live_session.ts",
        "--task-id", "0", "--run-id", badRunId,
      ], { SHOPSIM_BASE_URL: sim.url, SHOPPING_LIVE_DIR: join(dir, "live") }, 30_000);
      assert.notEqual(result.status, 0, `run_id=${badRunId}`);
    }
    assert.ok(!sim.events.some((event) => event["action"] === "reset"));
  } finally {
    await sim.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// L10. 目标文件已存在（串行）：拒绝覆盖、新 env_idx 释放、原文件不变
// ---------------------------------------------------------------------------

test("L10. bootstrap 目标已存在：拒绝覆盖，新 env_idx 被释放，原文件不变", async () => {
  const sim = await startMockShopSim();
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  try {
    const existing = join(dir, "bootstrap.json");
    const originalContent = JSON.stringify({
      schema_version: 1, run_id: "run-old", task_id: 0, env_idx: 3,
      instruction_text: "旧任务",
    });
    writeFileSync(existing, originalContent, "utf-8");

    const result = await runScript("node", [
      "scripts/bootstrap_live_session.ts",
      "--task-id", "0", "--run-id", "run-l10", "--output", existing,
    ], { SHOPSIM_BASE_URL: sim.url, SHOPPING_LIVE_DIR: join(dir, "live") }, 30_000);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /拒绝覆盖|已存在/);
    assert.equal(readFileSync(existing, "utf-8"), originalContent);
    const releases = realReleases(sim);
    assert.equal(releases.length, 1);
    assert.equal(releases[0]?.["env_idx"], 7);
  } finally {
    await sim.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// L11. 同一目标真正并发写（Promise.all + reset barrier）：恰好一个胜出
// ---------------------------------------------------------------------------

test("L11. 同一目标并发写：恰好一个 handoff 成功，失败者释放 env_idx，目标不被覆盖", async () => {
  const sim = await startMockShopSim();
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  try {
    // barrier：两个 reset 都到达后才一起应答，制造真正的写竞争窗口
    sim.setResetBarrier(2);
    const sharedOutput = join(dir, "shared", "bootstrap.json");

    const [a, b] = await Promise.all([
      runScript("node", ["scripts/bootstrap_live_session.ts", "--task-id", "0", "--run-id", "run-race-a", "--output", sharedOutput],
        { SHOPSIM_BASE_URL: sim.url, SHOPPING_LIVE_DIR: join(dir, "live") }, 30_000),
      runScript("node", ["scripts/bootstrap_live_session.ts", "--task-id", "0", "--run-id", "run-race-b", "--output", sharedOutput],
        { SHOPSIM_BASE_URL: sim.url, SHOPPING_LIVE_DIR: join(dir, "live") }, 30_000),
    ]);

    const outcomes = [a, b];
    const winners = outcomes.filter((outcome) => outcome.status === 0);
    const losers = outcomes.filter((outcome) => outcome.status !== 0);
    // 恰好一个胜出
    assert.equal(winners.length, 1, `outcomes: ${outcomes.map((outcome) => `${outcome.status}:${outcome.stderr.slice(0, 160)}`).join(" | ")}`);
    assert.equal(losers.length, 1);

    // 目标内容属于胜者，绝不被覆盖
    const winnerHandoff = JSON.parse(winners[0]!.stdout) as { envIdx: number };
    const finalContent = JSON.parse(readFileSync(sharedOutput, "utf-8")) as Record<string, unknown>;
    assert.equal(finalContent["env_idx"], winnerHandoff.envIdx);

    // 失败者领取的 env_idx 被释放
    const loserEnvIdx = winnerHandoff.envIdx === 7 ? 8 : 7;
    const releases = realReleases(sim);
    assert.equal(releases.length, 1);
    assert.equal(releases[0]?.["env_idx"], loserEnvIdx);
    assert.ok(losers[0]!.stderr.includes("已释放") || losers[0]!.stderr.includes("尚未确认释放"));

    // 无临时文件残留、无 release_all
    const leftovers = readdirSync(join(dir, "shared")).filter((name) => name.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
    assert.ok(!sim.events.some((event) => event["action"] === "release_all"));
  } finally {
    await sim.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
