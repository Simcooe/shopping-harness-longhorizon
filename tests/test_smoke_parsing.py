"""smoke_environment.py 响应解析的单元测试（不启动真实服务）。

运行方式（仓库根目录）：
    python3 -m unittest tests.test_smoke_parsing -v
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "smoke_environment.py"

spec = importlib.util.spec_from_file_location("smoke_environment", SCRIPT)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class TestParseReset(unittest.TestCase):
    def test_valid_reset(self):
        result = smoke.parse_reset_result({
            "env_idx": 3,
            "idx": 0,
            "message": "Task 0 started",
            "instruction": "<hidden goal text>",
            "instruction_simple": "<hidden>",
            "goal_options": {"颜色": ["红"]},
            "environment_version": "shopsimulator-environment-v2.1",
            "observation_state": {"page_type": 0, "has_search_bar": True},
        })
        self.assertTrue(result["ok"])
        self.assertEqual(result["env_idx"], 3)
        self.assertEqual(result["environment_version"],
                         "shopsimulator-environment-v2.1")
        self.assertEqual(result["observation_keys"],
                         ["has_search_bar", "page_type"])
        self.assertIsNone(result["error"])

    def test_reset_missing_env_idx(self):
        result = smoke.parse_reset_result({"instruction": "x"})
        self.assertFalse(result["ok"])
        self.assertIsNone(result["env_idx"])
        self.assertIn("env_idx", result["error"])

    def test_reset_env_idx_not_int(self):
        result = smoke.parse_reset_result({
            "env_idx": "3", "instruction": "x", "instruction_simple": "x",
            "observation_state": {}, "environment_version": "v",
        })
        self.assertFalse(result["ok"])

    def test_reset_error_payload(self):
        result = smoke.parse_reset_result({"error": "boom"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "boom")
        self.assertIsNone(result["env_idx"])


class TestParseInteract(unittest.TestCase):
    def _valid(self):
        return {
            "done": False,
            "reward": 0,
            "instruction": "搜索结果文本" * 20,
            "message": "Continue interaction",
            "env_idx": 3,
            "idx": "slot-0-0",
            "reward_detail": {},
            "purchase": {},
            "goal": {},
            "over": False,
            "observation_state": {"page_type": 1},
        }

    def test_valid_interact(self):
        result = smoke.parse_interact_result(self._valid(), expected_env_idx=3)
        self.assertTrue(result["ok"])
        self.assertIs(result["done"], False)
        self.assertEqual(result["reward"], 0)
        self.assertTrue(result["has_observation_state"])
        self.assertGreater(result["observation_len"], 0)
        self.assertIsNone(result["error"])

    def test_interact_env_idx_mismatch(self):
        result = smoke.parse_interact_result(self._valid(), expected_env_idx=5)
        self.assertFalse(result["ok"])
        self.assertIn("env_idx 不一致", result["error"])

    def test_interact_missing_fields(self):
        result = smoke.parse_interact_result({"done": True}, expected_env_idx=None)
        self.assertFalse(result["ok"])
        for key in ("reward", "instruction", "observation_state", "env_idx"):
            self.assertIn(key, result["error"])

    def test_interact_bad_types(self):
        payload = self._valid()
        payload["done"] = "no"
        payload["reward"] = "high"
        result = smoke.parse_interact_result(payload, expected_env_idx=3)
        self.assertFalse(result["ok"])
        self.assertIn("done", result["error"])
        self.assertIn("reward", result["error"])

    def test_interact_error_payload(self):
        result = smoke.parse_interact_result({"error": "nope"}, expected_env_idx=1)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "nope")


class TestParseRelease(unittest.TestCase):
    def test_release_success(self):
        result = smoke.parse_release_result(
            {"message": "Environment 3 has been released"})
        self.assertTrue(result["ok"])
        self.assertIsNone(result["error"])

    def test_release_already_free(self):
        result = smoke.parse_release_result(
            {"message": "Environment 3 is already free"})
        self.assertTrue(result["ok"])

    def test_release_error(self):
        result = smoke.parse_release_result(
            {"error": "No valid environment index provided"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"],
                         "No valid environment index provided")

    def test_release_unexpected_message(self):
        result = smoke.parse_release_result({"message": "???"})
        self.assertFalse(result["ok"])


class TestReport(unittest.TestCase):
    def test_report_success_and_no_goal_leak(self):
        report = smoke.build_report(
            base_url="http://127.0.0.1:5700",
            task_idx=0,
            probe={"ok": True},
            reset={"ok": True, "env_idx": 0},
            interact={"ok": True, "done": False},
            release={"ok": True},
            released_in_finally=True,
        )
        self.assertTrue(report["success"])
        self.assertFalse(report["final200_clean_used"])
        self.assertEqual(report["endpoint"],
                         "http://127.0.0.1:5700/api/shop_agent")
        # 报告中不允许出现 goal/商品内容字段
        serialized = str(report)
        self.assertNotIn("instruction", serialized)
        self.assertNotIn("goal_options", serialized)

    def test_report_failure_when_step_fails(self):
        report = smoke.build_report(
            base_url="http://127.0.0.1:5700", task_idx=0,
            probe={"ok": True}, reset={"ok": False, "error": "x"},
            interact=None, release=None, released_in_finally=False,
        )
        self.assertFalse(report["success"])

    def test_base_url_from_env(self):
        import os
        old_url, old_port = os.environ.get("SHOPSIM_BASE_URL"), os.environ.get("SHOPSIM_PORT")
        try:
            os.environ["SHOPSIM_BASE_URL"] = "http://127.0.0.1:9999/"
            self.assertEqual(smoke.base_url_from_env(), "http://127.0.0.1:9999")
            del os.environ["SHOPSIM_BASE_URL"]
            os.environ["SHOPSIM_PORT"] = "6001"
            self.assertEqual(smoke.base_url_from_env(), "http://127.0.0.1:6001")
        finally:
            if old_url is None:
                os.environ.pop("SHOPSIM_BASE_URL", None)
            else:
                os.environ["SHOPSIM_BASE_URL"] = old_url
            if old_port is None:
                os.environ.pop("SHOPSIM_PORT", None)
            else:
                os.environ["SHOPSIM_PORT"] = old_port


if __name__ == "__main__":
    unittest.main()
