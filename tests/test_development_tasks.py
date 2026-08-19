"""开发任务配置（configs/tasks/development.json）的加载与校验测试。

不启动任何服务。运行方式（仓库根目录）：
    python3 -m unittest tests.test_development_tasks -v
"""

from __future__ import annotations

import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "smoke_environment.py"
CONFIG_PATH = REPO_ROOT / "configs" / "tasks" / "development.json"

spec = importlib.util.spec_from_file_location("smoke_environment", SCRIPT)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def valid_config():
    return {
        "schema_version": 1,
        "purpose": "development_smoke_only",
        "task_ids": [0],
        "selection_rationale": "test",
        "final_benchmark_excluded": True,
        "notes": "test",
    }


class TestValidateTaskConfig(unittest.TestCase):
    def test_valid(self):
        config = smoke.validate_task_config(valid_config())
        self.assertEqual(config["task_ids"], [0])

    def test_not_a_dict(self):
        with self.assertRaises(ValueError):
            smoke.validate_task_config([1, 2])

    def test_bad_schema_version(self):
        for bad in (None, 2, "1"):
            config = valid_config()
            config["schema_version"] = bad
            with self.assertRaises(ValueError):
                smoke.validate_task_config(config)

    def test_bad_purpose(self):
        for bad in (None, "evaluation", "final_benchmark"):
            config = valid_config()
            config["purpose"] = bad
            with self.assertRaisesRegex(ValueError, "purpose"):
                smoke.validate_task_config(config)

    def test_empty_task_ids_rejected(self):
        config = valid_config()
        config["task_ids"] = []
        with self.assertRaisesRegex(ValueError, "task_ids"):
            smoke.validate_task_config(config)

    def test_missing_task_ids_rejected(self):
        config = valid_config()
        del config["task_ids"]
        with self.assertRaisesRegex(ValueError, "task_ids"):
            smoke.validate_task_config(config)

    def test_non_int_task_ids_rejected(self):
        for bad in (["0"], [1.5], [-1], [True], [None]):
            config = valid_config()
            config["task_ids"] = bad
            with self.assertRaisesRegex(ValueError, "task_ids"):
                smoke.validate_task_config(config)

    def test_final_benchmark_excluded_must_be_true(self):
        for bad in (None, False, "true"):
            config = valid_config()
            config["final_benchmark_excluded"] = bad
            with self.assertRaisesRegex(
                    ValueError, "final_benchmark_excluded"):
                smoke.validate_task_config(config)


class TestLoadTaskConfig(unittest.TestCase):
    def test_repo_config_loads(self):
        config = smoke.load_task_config(CONFIG_PATH)
        self.assertEqual(config["purpose"], "development_smoke_only")
        self.assertEqual(config["schema_version"], 1)
        self.assertTrue(config["final_benchmark_excluded"])
        self.assertTrue(len(config["task_ids"]) >= 1)

    def test_missing_file_rejected(self):
        with self.assertRaisesRegex(ValueError, "无法读取任务配置"):
            smoke.load_task_config(REPO_ROOT / "configs" / "tasks" / "nope.json")

    def test_invalid_json_rejected(self):
        with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False, encoding="utf-8") as handle:
            handle.write("{not json")
            path = Path(handle.name)
        try:
            with self.assertRaisesRegex(ValueError, "不是合法 JSON"):
                smoke.load_task_config(path)
        finally:
            path.unlink()

    def test_invalid_schema_file_rejected(self):
        config = valid_config()
        config["task_ids"] = []
        with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False, encoding="utf-8") as handle:
            json.dump(config, handle)
            path = Path(handle.name)
        try:
            with self.assertRaisesRegex(ValueError, "task_ids"):
                smoke.load_task_config(path)
        finally:
            path.unlink()


class TestRepoConfigContentGuards(unittest.TestCase):
    """仓库中提交的配置本身的红线检查。"""

    def setUp(self):
        self.config = smoke.load_task_config(CONFIG_PATH)

    def test_task_ids_are_environment_goal_indices(self):
        # task ID 必须是环境 goal 列表下标形态（非负整数），
        # 而不是外部 benchmark 的字符串 ID
        for task_id in self.config["task_ids"]:
            self.assertIsInstance(task_id, int)
            self.assertGreaterEqual(task_id, 0)

    def test_purpose_locked_to_development(self):
        self.assertEqual(self.config["purpose"], "development_smoke_only")

    def test_final_benchmark_excluded(self):
        self.assertIs(self.config["final_benchmark_excluded"], True)

    def test_selection_rationale_present(self):
        self.assertTrue(self.config.get("selection_rationale"))


if __name__ == "__main__":
    unittest.main()
