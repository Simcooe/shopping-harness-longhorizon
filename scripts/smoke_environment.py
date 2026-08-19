#!/usr/bin/env python3
"""ShopSimulator HTTP smoke test：reset -> interact -> release_one。

仅使用标准库；不需要模型、DSH 或任何 API key。

task_id 来源说明（重要）：
  reset 使用的 idx 从 configs/tasks/development.json 读取。该配置是本项目
  自行声明的开发任务集（purpose: development_smoke_only），其 task ID 是
  ShopSimulator 自身 goal 列表的下标（goals 由环境源码 get_goals() 从本仓库
  内嵌的压缩商品语料在进程内生成）。本脚本不读取任何外部仓库数据；
  Final-200 Clean 不在本仓库中，也绝不会被本脚本使用。

报告原则：只输出结构与状态信息（env_idx、done、键是否存在、文本长度等），
不输出隐藏 goal / gold 信息，不输出完整商品数据。
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TASK_CONFIG = REPO_ROOT / "configs" / "tasks" / "development.json"

TASK_CONFIG_SCHEMA_VERSION = 1
TASK_CONFIG_REQUIRED_PURPOSE = "development_smoke_only"

# 一次无害的搜索动作（smoke 用，不为完成任务而设计）
SMOKE_ACTION = "Thought: smoke test probe, search only.\nAction: search[枕头]"

PROBE_ENV_IDX = 10 ** 9  # 越界 slot：服务端只会返回错误信息，不会改动任何租约


def validate_task_config(data) -> dict:
    """校验开发任务配置；任何违规抛出 ValueError。"""
    if not isinstance(data, dict):
        raise ValueError("任务配置必须是 JSON 对象")
    schema_version = data.get("schema_version")
    if schema_version != TASK_CONFIG_SCHEMA_VERSION:
        raise ValueError(
            f"不支持的 schema_version: {schema_version!r}"
            f"（期望 {TASK_CONFIG_SCHEMA_VERSION}）")
    purpose = data.get("purpose")
    if purpose != TASK_CONFIG_REQUIRED_PURPOSE:
        raise ValueError(
            f"任务配置 purpose 必须为 {TASK_CONFIG_REQUIRED_PURPOSE!r}，"
            f"实际为 {purpose!r}")
    task_ids = data.get("task_ids")
    if (not isinstance(task_ids, list) or len(task_ids) == 0
            or not all(isinstance(t, int) and not isinstance(t, bool)
                       and t >= 0 for t in task_ids)):
        raise ValueError(
            f"task_ids 必须是非空的非负整数列表，实际为 {task_ids!r}")
    if data.get("final_benchmark_excluded") is not True:
        raise ValueError(
            "任务配置必须显式声明 final_benchmark_excluded: true")
    return data


def load_task_config(path: Path = DEFAULT_TASK_CONFIG) -> dict:
    """读取并校验开发任务配置。"""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"无法读取任务配置 {path}: {exc}") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"任务配置不是合法 JSON ({path}): {exc}") from exc
    return validate_task_config(data)


def base_url_from_env() -> str:
    url = os.environ.get("SHOPSIM_BASE_URL", "").strip()
    if url:
        return url.rstrip("/")
    port = os.environ.get("SHOPSIM_PORT", "5700").strip() or "5700"
    return f"http://127.0.0.1:{port}"


def post_shop_agent(base_url: str, payload: dict, timeout: float = 120.0) -> dict:
    """POST /api/shop_agent，返回解析后的 JSON body。失败抛出异常。"""
    req = urllib.request.Request(
        f"{base_url}/api/shop_agent",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def unwrap_result(body: dict) -> dict:
    result = body.get("result") if isinstance(body, dict) else None
    if not isinstance(result, dict):
        raise ValueError(f"响应缺少 result 对象: 顶层键={sorted(body) if isinstance(body, dict) else type(body).__name__}")
    return result


# ---------------------------------------------------------------------------
# 纯解析函数（单元测试覆盖，不依赖真实服务）
# ---------------------------------------------------------------------------

def parse_reset_result(result: dict) -> dict:
    """校验 reset 响应：必须有有效 env_idx 与结构化字段。"""
    if "error" in result:
        return {"ok": False, "error": str(result["error"]), "env_idx": None}
    env_idx = result.get("env_idx")
    problems = []
    if not isinstance(env_idx, int):
        problems.append(f"env_idx 不是整数: {env_idx!r}")
    for key in ("instruction", "instruction_simple", "observation_state",
                "environment_version"):
        if key not in result:
            problems.append(f"缺少字段 {key}")
    return {
        "ok": not problems,
        "env_idx": env_idx if isinstance(env_idx, int) else None,
        "error": "; ".join(problems) or None,
        "environment_version": result.get("environment_version"),
        "observation_keys": (
            sorted(result["observation_state"])
            if isinstance(result.get("observation_state"), dict) else None
        ),
    }


def parse_interact_result(result: dict, expected_env_idx: int | None) -> dict:
    """校验 interact 响应：结构化、env_idx 一致、不泄漏 goal 内容。"""
    if "error" in result:
        return {"ok": False, "error": str(result["error"])}
    problems = []
    for key in ("done", "reward", "instruction", "observation_state", "env_idx"):
        if key not in result:
            problems.append(f"缺少字段 {key}")
    if "done" in result and not isinstance(result["done"], bool):
        problems.append("done 不是布尔值")
    if "reward" in result and not isinstance(result["reward"], (int, float)):
        problems.append("reward 不是数值")
    if (expected_env_idx is not None and "env_idx" in result
            and result["env_idx"] != expected_env_idx):
        problems.append(f"env_idx 不一致: {result['env_idx']} != {expected_env_idx}")
    observation = result.get("instruction")
    return {
        "ok": not problems,
        "error": "; ".join(problems) or None,
        "done": result.get("done"),
        "over": result.get("over"),
        "reward": result.get("reward"),
        "observation_len": len(observation) if isinstance(observation, str) else None,
        "has_observation_state": isinstance(result.get("observation_state"), dict),
    }


def parse_release_result(result: dict) -> dict:
    """校验 release_one 响应。"""
    if "error" in result:
        return {"ok": False, "error": str(result["error"]), "message": None}
    message = result.get("message")
    ok = isinstance(message, str) and ("released" in message or "free" in message)
    return {
        "ok": ok,
        "message": message,
        "error": None if ok else f"意外的 release 响应: {message!r}",
    }


def build_report(base_url: str, task_idx: int, task_source: str, probe, reset,
                 interact, release, released_in_finally: bool) -> dict:
    steps = {"probe": probe, "reset": reset, "interact": interact, "release": release}
    return {
        "base_url": base_url,
        "endpoint": f"{base_url}/api/shop_agent",
        "task_idx": task_idx,
        "task_source": task_source,
        "final200_clean_used": False,
        "steps": steps,
        "released_in_finally": released_in_finally,
        "success": all(
            isinstance(step, dict) and step.get("ok")
            for step in (probe, reset, interact, release)
        ),
    }


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def wait_until_reachable(base_url: str, attempts: int = 30, interval: float = 2.0):
    """探测服务可达。用越界 release_one 做探针：不改变任何 slot 租约。"""
    probe_payload = {"action": "release_one", "env_idx": PROBE_ENV_IDX}
    last_error = None
    for _ in range(attempts):
        try:
            body = post_shop_agent(base_url, probe_payload, timeout=5.0)
            result = unwrap_result(body)
            # 越界 env_idx 应返回错误消息（而非异常通道），这证明 API 正常工作
            if isinstance(result, dict):
                return {"ok": True, "error": None, "note": "reachable"}
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
            last_error = str(exc)
        time.sleep(interval)
    return {"ok": False, "error": f"服务不可达: {last_error}", "note": None}


def run(base_url: str, task_idx: int, task_source: str) -> dict:
    probe = wait_until_reachable(
        base_url,
        attempts=int(os.environ.get("SMOKE_PROBE_ATTEMPTS", "30")),
        interval=float(os.environ.get("SMOKE_PROBE_INTERVAL", "2.0")),
    )
    if not probe["ok"]:
        return build_report(base_url, task_idx, task_source, probe, None, None,
                            None, False)

    env_idx = None
    released_in_finally = False
    reset = interact = release = None
    try:
        reset = parse_reset_result(unwrap_result(post_shop_agent(
            base_url, {"action": "reset", "idx": task_idx})))
        if reset["ok"]:
            env_idx = reset["env_idx"]
            interact = parse_interact_result(
                unwrap_result(post_shop_agent(
                    base_url,
                    {"action": "interact", "env_idx": env_idx,
                     "response": SMOKE_ACTION},
                )),
                expected_env_idx=env_idx,
            )
            release = parse_release_result(unwrap_result(post_shop_agent(
                base_url, {"action": "release_one", "env_idx": env_idx})))
    except Exception as exc:  # noqa: BLE001 - smoke 需要把任何异常写进报告
        if reset is None:
            reset = {"ok": False, "error": f"reset 请求异常: {exc}", "env_idx": None}
        elif interact is None:
            interact = {"ok": False, "error": f"interact 请求异常: {exc}"}
        elif release is None:
            release = {"ok": False, "error": f"release 请求异常: {exc}"}
    finally:
        if env_idx is not None:
            try:
                post_shop_agent(
                    base_url, {"action": "release_one", "env_idx": env_idx},
                    timeout=10.0,
                )
                released_in_finally = True
            except Exception:  # noqa: BLE001
                released_in_finally = False

    return build_report(base_url, task_idx, task_source, probe, reset, interact,
                        release, released_in_finally)


def main() -> int:
    # 先加载并校验开发任务配置：即使服务未启动，也必须能正确完成这一步。
    try:
        config = load_task_config()
    except ValueError as exc:
        print(json.dumps({
            "success": False,
            "error": f"开发任务配置校验失败: {exc}",
            "task_config": str(DEFAULT_TASK_CONFIG),
        }, ensure_ascii=False, indent=2))
        return 1
    task_idx = config["task_ids"][0]
    task_source = (f"{DEFAULT_TASK_CONFIG.relative_to(REPO_ROOT)} "
                   f"(purpose={config['purpose']})")
    base_url = base_url_from_env()
    report = run(base_url, task_idx, task_source)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
