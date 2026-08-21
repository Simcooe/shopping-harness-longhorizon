#!/usr/bin/env python3
"""development task 发现/验证工具（无模型，只用 vendored ShopSimulator）。

对每个候选 task_id 执行 reset → release_one，验证其在当前 ShopSimulator
中可领取且可释放。不打印 goal、gold、reward、完整原始 observation；
只输出安全摘要（task_id / instruction 是否存在 / release 是否成功 / 状态）。

用法：
  # 显式候选列表
  python3 scripts/validate_development_tasks.py --task-ids 0,1,2,3

  # 从 benchmark manifest 读取 held_in + held_out（经 node+yaml 解析）
  python3 scripts/validate_development_tasks.py \
      --manifest configs/evaluation/development-v1.yml

  # 发现模式：枚举 [0, limit) 内的有效 task（用于初始集合选择）
  python3 scripts/validate_development_tasks.py --discover --limit 16

环境变量：SHOPSIM_BASE_URL（默认 http://127.0.0.1:5700）。
本脚本只读环境 API，不修改任何环境数据；可被测试直接 import 调用。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASE_URL = "http://127.0.0.1:5700"
API_PATH = "/api/shop_agent"
# instruction 文本只探测存在性；保留前若干个字符用于长度判断，绝不整体输出
MAX_INSTRUCTION_PROBE_CHARS = 64


def post_shop_agent(base_url: str, payload: dict, timeout: float = 30.0) -> dict:
    """POST /api/shop_agent；返回 result 对象。失败抛 RuntimeError。"""
    request = urllib.request.Request(
        f"{base_url}{API_PATH}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as cause:
        raise RuntimeError(f"ShopSimulator 请求失败: {cause}") from cause
    result = body.get("result") if isinstance(body, dict) else None
    if not isinstance(result, dict):
        raise RuntimeError("ShopSimulator 响应缺少 result 对象")
    return result


def validate_task(base_url: str, task_id: int) -> dict:
    """对单个 task_id 执行 reset → release_one，返回脱敏验证摘要。"""
    summary = {
        "task_id": task_id,
        "reset_ok": False,
        "instruction_present": False,
        "release_ok": False,
        "env_idx": None,
        "status": "unknown",
    }
    try:
        result = post_shop_agent(base_url, {"action": "reset", "idx": task_id})
    except RuntimeError as cause:
        summary["status"] = f"reset_error: {cause}"[:200]
        return summary
    if "error" in result:
        # 常见：idx 越界。只保留错误类别，不扩散细节。
        summary["status"] = "reset_rejected"
        return summary

    env_idx = result.get("env_idx")
    summary["reset_ok"] = isinstance(env_idx, int)
    summary["env_idx"] = env_idx if isinstance(env_idx, int) else None
    instruction = result.get("instruction")
    summary["instruction_present"] = isinstance(instruction, str) and len(instruction) > 0
    # 只记录长度信息，绝不记录内容
    summary["instruction_chars"] = len(instruction) if isinstance(instruction, str) else 0

    if isinstance(env_idx, int):
        try:
            release = post_shop_agent(
                base_url, {"action": "release_one", "env_idx": env_idx}
            )
            summary["release_ok"] = "error" not in release
        except RuntimeError:
            summary["release_ok"] = False
    summary["status"] = "valid" if (
        summary["reset_ok"] and summary["instruction_present"] and summary["release_ok"]
    ) else "invalid"
    return summary


def validate_tasks(base_url: str, task_ids: list[int]) -> list[dict]:
    return [validate_task(base_url, task_id) for task_id in task_ids]


def read_manifest_task_ids(manifest_path: Path) -> list[int]:
    """经 node + plugins/shopping 的 yaml 依赖解析 manifest 的 task IDs。"""
    script = """
const { readFileSync } = require("fs");
const { parse } = require(process.argv[2] + "/plugins/shopping/node_modules/yaml");
const manifest = parse(readFileSync(process.argv[1], "utf-8"));
const ids = [...(manifest.held_in_task_ids ?? []), ...(manifest.held_out_task_ids ?? [])];
console.log(JSON.stringify(ids));
"""
    completed = subprocess.run(
        ["node", "-e", script, str(manifest_path), str(REPO_ROOT)],
        capture_output=True, text=True, check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"manifest 解析失败: {completed.stderr.strip()[:200]}")
    ids = json.loads(completed.stdout.strip())
    if not isinstance(ids, list) or not all(isinstance(i, int) for i in ids):
        raise RuntimeError("manifest task IDs 必须是整数列表")
    return ids


def discover_tasks(base_url: str, limit: int) -> list[dict]:
    """枚举 [0, limit)：找到首个 reset 被拒绝的 idx 即停止（goal 列表连续）。"""
    summaries = []
    for task_id in range(limit):
        summary = validate_task(base_url, task_id)
        summaries.append(summary)
        if summary["status"] == "reset_rejected":
            break
    return summaries


def parse_task_ids(raw: str) -> list[int]:
    ids = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        ids.append(int(part))
    return ids


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="验证 development task IDs（无模型）")
    parser.add_argument("--task-ids", help="逗号分隔的候选 task IDs")
    parser.add_argument("--manifest", help="benchmark manifest 路径（读取两个 split）")
    parser.add_argument("--discover", action="store_true", help="枚举 [0, --limit) 的候选")
    parser.add_argument("--limit", type=int, default=16)
    args = parser.parse_args(argv)

    base_url = os.environ.get("SHOPSIM_BASE_URL", DEFAULT_BASE_URL).strip()

    if args.discover:
        summaries = discover_tasks(base_url, args.limit)
    elif args.task_ids:
        summaries = validate_tasks(base_url, parse_task_ids(args.task_ids))
    elif args.manifest:
        ids = read_manifest_task_ids(REPO_ROOT / args.manifest
                                     if not Path(args.manifest).is_absolute()
                                     else Path(args.manifest))
        summaries = validate_tasks(base_url, ids)
    else:
        parser.error("需要 --task-ids / --manifest / --discover 之一")
        return 2

    valid = [s for s in summaries if s["status"] == "valid"]
    report = {
        "base_url": base_url,
        "checked": len(summaries),
        "valid": len(valid),
        "valid_task_ids": [s["task_id"] for s in valid],
        "summaries": summaries,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if len(valid) == len(summaries) else 1


if __name__ == "__main__":
    sys.exit(main())
