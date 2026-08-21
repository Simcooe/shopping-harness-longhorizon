"""validate_development_tasks.py 的离线测试（mock ShopSimulator，无模型）。"""

import importlib.util
import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "scripts" / "validate_development_tasks.py"

spec = importlib.util.spec_from_file_location("validate_development_tasks", SCRIPT_PATH)
vdt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vdt)

SECRET = "SECRET-GOAL-gold-asin-xyz"


class MockShopSimHandler(BaseHTTPRequestHandler):
    """mock：reset 返回含隐藏字段的响应；越界 idx 返回 error。"""

    max_valid_idx = 3
    fail_release = False
    events = []

    def log_message(self, *args):  # 静默
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(length))
        type(self).events.append(payload)
        action = payload.get("action")
        if action == "reset":
            idx = payload.get("idx")
            if isinstance(idx, int) and 0 <= idx <= type(self).max_valid_idx:
                result = {
                    "env_idx": 100 + idx,
                    "instruction": f"任务指令-task{idx}",
                    "instruction_simple": SECRET,
                    "goal_options": {"颜色": [SECRET]},
                    "observation_state": {"page_type": "search_home"},
                }
            else:
                result = {"error": f"invalid idx {idx}"}
        elif action == "release_one":
            if type(self).fail_release:
                result = {"error": "mock release failed"}
            else:
                result = {"message": f"Environment {payload.get('env_idx')} has been released"}
        else:
            result = {"error": "unexpected"}
        body = json.dumps({"result": result}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class MockServerTestCase(unittest.TestCase):
    def setUp(self):
        MockShopSimHandler.events = []
        MockShopSimHandler.max_valid_idx = 3
        MockShopSimHandler.fail_release = False
        self.server = HTTPServer(("127.0.0.1", 0), MockShopSimHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self._old_env = os.environ.get("SHOPSIM_BASE_URL")
        os.environ["SHOPSIM_BASE_URL"] = self.base_url

    def tearDown(self):
        if self._old_env is None:
            os.environ.pop("SHOPSIM_BASE_URL", None)
        else:
            os.environ["SHOPSIM_BASE_URL"] = self._old_env
        self.server.shutdown()
        self.server.server_close()

    def test_valid_task_reset_release_and_no_leak(self):
        summary = vdt.validate_task(self.base_url, 1)
        self.assertEqual(summary["status"], "valid")
        self.assertTrue(summary["reset_ok"])
        self.assertTrue(summary["instruction_present"])
        self.assertTrue(summary["release_ok"])
        self.assertEqual(summary["env_idx"], 101)
        # 摘要不得包含 goal/gold/reward/指令内容
        serialized = json.dumps(summary, ensure_ascii=False)
        self.assertNotIn(SECRET, serialized)
        self.assertNotIn("任务指令-task1", serialized)
        self.assertNotIn("goal_options", serialized)
        # 恰好一次 reset + 一次 release_one，绝无 release_all
        actions = [event["action"] for event in MockShopSimHandler.events]
        self.assertEqual(actions, ["reset", "release_one"])

    def test_out_of_range_task_rejected(self):
        summary = vdt.validate_task(self.base_url, 99)
        self.assertEqual(summary["status"], "reset_rejected")
        self.assertFalse(summary["reset_ok"])
        # 未成功 reset 时不得发送 release
        actions = [event["action"] for event in MockShopSimHandler.events]
        self.assertNotIn("release_one", actions)

    def test_release_failure_marked_invalid(self):
        MockShopSimHandler.fail_release = True
        summary = vdt.validate_task(self.base_url, 0)
        self.assertEqual(summary["status"], "invalid")
        self.assertFalse(summary["release_ok"])

    def test_discover_stops_at_first_rejection(self):
        MockShopSimHandler.max_valid_idx = 2
        summaries = vdt.discover_tasks(self.base_url, limit=8)
        statuses = [s["status"] for s in summaries]
        self.assertEqual(statuses, ["valid", "valid", "valid", "reset_rejected"])

    def test_main_task_ids_exit_zero_all_valid(self):
        exit_code = vdt.main(["--task-ids", "0,2"])
        self.assertEqual(exit_code, 0)

    def test_main_task_ids_exit_nonzero_when_invalid(self):
        exit_code = vdt.main(["--task-ids", "0,99"])
        self.assertEqual(exit_code, 1)

    def test_main_requires_a_mode(self):
        with self.assertRaises(SystemExit):
            vdt.main([])


if __name__ == "__main__":
    unittest.main()
