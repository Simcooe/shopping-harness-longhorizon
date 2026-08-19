import json
from pathlib import Path
import unittest

from web_agent_site.engine.config import (
    load_config,
    validate_config,
)


CONFIG = Path(__file__).resolve().parents[1] / "configs" / "environment.json"


class EnvironmentV21ConfigTest(unittest.TestCase):
    def test_repository_config_matches_reward_contract(self):
        config = load_config(CONFIG)
        self.assertEqual(
            config["environment_version"],
            "shopsimulator-environment-v2.1",
        )
        self.assertEqual(config["reward"]["wrong_purchase"], -0.85)
        self.assertEqual(config["reward"]["partial_purchase_base"], -0.30)
        self.assertEqual(config["reward"]["partial_purchase_cap"], 0.25)
        self.assertEqual(
            config["reward_feature_version"],
            "shopping-reward-features-v1",
        )
        self.assertEqual(
            config["termination"]["version"],
            "shopping-termination-v3",
        )

    def test_reward_drift_is_rejected(self):
        config = json.loads(CONFIG.read_text(encoding="utf-8"))
        config["reward"]["wrong_purchase"] = -0.4
        with self.assertRaisesRegex(ValueError, "reward values"):
            validate_config(config)


if __name__ == "__main__":
    unittest.main()
