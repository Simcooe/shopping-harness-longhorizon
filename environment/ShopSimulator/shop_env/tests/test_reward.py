import unittest

from web_agent_site.engine.comparators import (
    FAIL,
    PASS,
    compare_brand,
    compare_core_functions,
    compare_model,
    compare_numeric_spec,
)
from web_agent_site.engine.reward_features import compile_reward_features
from web_agent_site.engine.reward import (
    DEFAULT_REWARDS,
    evaluate_abstain,
    evaluate_candidate_eligibility,
    evaluate_purchase,
    fixed_termination,
)
from web_agent_site.engine.variant_price import (
    compare_required_options,
    resolve_variant_price,
)


def product(asin="111111111111", *, model="A20", attributes=None):
    return {
        "asin": asin,
        "title": f"石头 {model} 智能洗地机",
        "brand": "石头",
        "shop_name": "石头旗舰店",
        "category": "家电›清洁电器›洗地机",
        "attribute": attributes or ["智能洗地", "热洗"],
        "pricing": [1999],
        "customization_options": {
            "颜色分类": [
                {"value": "白色", "price": 1999},
                {"value": "黑色", "price": 1999},
            ],
            "尺码": [
                {"value": "L", "price": 1899},
                {"value": "XL", "price": 1999},
            ],
        },
    }


INSTRUCTION = {
    "instruction": "购买支持热洗的白色 XL 洗地机，预算2200元",
    "attributes": ["洗地", "热洗"],
    "instruction_options": ["白色", "XL"],
}


def goal(target=None):
    target = target or product()
    return {
        "asin": target["asin"],
        "category": target["category"],
        "price_upper": 2200,
        **compile_reward_features(INSTRUCTION, target),
    }


class RewardV3Test(unittest.TestCase):
    def test_reward_order_prevents_panic_buying(self):
        self.assertGreater(
            DEFAULT_REWARDS["graceful_stop"],
            DEFAULT_REWARDS["partial_purchase_base"],
        )
        self.assertGreater(
            DEFAULT_REWARDS["early_abstain"],
            DEFAULT_REWARDS["max_steps"],
        )
        self.assertGreater(
            DEFAULT_REWARDS["max_steps"],
            DEFAULT_REWARDS["repeat_loop"],
        )
        self.assertGreater(
            DEFAULT_REWARDS["repeat_loop"],
            DEFAULT_REWARDS["wrong_purchase"],
        )

    def test_gold_and_full_alternative_have_a_large_jump(self):
        selected = {"颜色分类": "白色", "尺码": "XL"}
        gold = evaluate_purchase(product(), goal(), selected_options=selected)
        alternative = evaluate_purchase(
            product("222222222222"),
            goal(),
            selected_options=selected,
        )
        self.assertEqual(gold.reward_type, "gold_purchase")
        self.assertEqual(gold.reward, 1.0)
        self.assertEqual(
            alternative.reward_type,
            "valid_alternative_purchase",
        )
        self.assertEqual(alternative.reward, 0.55)
        self.assertAlmostEqual(gold.reward - alternative.reward, 0.45)
        self.assertTrue(alternative.to_dict()["purchase_success"])

    def test_missing_contract_does_not_invalidate_reward(self):
        task_goal = goal()
        self.assertNotIn("hard_constraints", task_goal)
        result = evaluate_purchase(
            product(),
            task_goal,
            selected_options={"颜色分类": "白色", "尺码": "XL"},
        )
        self.assertEqual(result.reward_type, "gold_purchase")
        self.assertTrue(result.reward_valid)
        self.assertFalse(result.to_dict()["sampling_invalid"])

    def test_lightweight_features_detect_explicit_brand_and_model(self):
        target = product()
        features = compile_reward_features(
            {
                "instruction": "购买石头 A20 洗地机",
                "attributes": [],
                "instruction_options": [],
            },
            target,
        )
        self.assertEqual(features["expected_brand"], ["石头"])
        self.assertEqual(features["expected_model"], ["a20"])

    def test_wrong_option_gets_continuous_partial_reward(self):
        result = evaluate_purchase(
            product(),
            goal(),
            selected_options={"颜色分类": "白色", "尺码": "L"},
        )
        self.assertEqual(
            result.reward_type,
            "partial_alternative_purchase",
        )
        self.assertGreater(result.reward, DEFAULT_REWARDS["graceful_stop"])
        self.assertLessEqual(result.reward, 0.25)

    def test_nearly_unmatched_purchase_is_worse_than_graceful_stop(self):
        unrelated = product(
            "222222222222",
            attributes=["普通清洁"],
        )
        unrelated["title"] = "同类普通清洁设备"
        result = evaluate_purchase(
            unrelated,
            goal(),
            selected_options={"颜色分类": "黑色", "尺码": "L"},
        )
        self.assertEqual(
            result.reward_type,
            "partial_alternative_purchase",
        )
        self.assertEqual(result.weighted_score, 0.0)
        self.assertEqual(result.reward, -0.30)
        self.assertLess(result.reward, DEFAULT_REWARDS["graceful_stop"])

    def test_cross_category_or_over_budget_is_wrong_purchase(self):
        cross_category = product()
        cross_category["category"] = "数码›电脑›笔记本电脑"
        selected = {"颜色分类": "白色", "尺码": "XL"}
        wrong_category = evaluate_purchase(
            cross_category,
            goal(),
            selected_options=selected,
        )
        over_budget_goal = goal()
        over_budget_goal["price_upper"] = 1900
        over_budget = evaluate_purchase(
            product(),
            over_budget_goal,
            selected_options=selected,
        )
        self.assertEqual(wrong_category.reward_type, "wrong_purchase")
        self.assertEqual(over_budget.reward_type, "wrong_purchase")
        self.assertEqual(over_budget.reward, -0.85)

    def test_missing_user_budget_does_not_invent_an_upper_bound(self):
        no_budget_goal = goal()
        no_budget_goal["price_upper"] = None
        result = evaluate_purchase(
            product(),
            no_budget_goal,
            selected_options={"颜色分类": "白色", "尺码": "XL"},
            price=99999,
        )
        self.assertEqual(result.reward_type, "gold_purchase")
        self.assertEqual(result.hard_gates["budget"]["status"], "pass")
        self.assertEqual(
            result.hard_gates["budget"]["comparator"],
            "budget_not_declared_v1",
        )

    def test_option_comparison_uses_key_and_exact_value(self):
        target_goal = goal()
        candidate = product("222222222222")
        candidate["customization_options"]["尺码"] = [
            {"value": "XXL", "price": 1999}
        ]
        gate = compare_required_options(
            candidate,
            target_goal["required_options_by_key"],
            {"颜色": "白色", "鞋码": "XXL"},
        )
        self.assertEqual(gate["status"], FAIL)

    def test_unresolved_option_axis_uses_exact_value_fallback(self):
        task_goal = goal()
        task_goal["required_options_by_key"] = {}
        task_goal["unresolved_option_requirements"] = [
            {"value": "白色", "reason": "axis_not_found", "axes": []}
        ]
        result = evaluate_purchase(
            product(),
            task_goal,
            selected_options={"任意规格轴": "白色"},
            price=1999,
        )
        self.assertEqual(result.reward_type, "gold_purchase")

    def test_unique_effective_price_axis_is_used(self):
        resolution = resolve_variant_price(
            product(),
            {"颜色分类": "白色", "尺码": "XL"},
        )
        self.assertEqual(resolution["status"], PASS)
        self.assertEqual(
            resolution["method"],
            "unique_effective_price_axis",
        )
        self.assertEqual(resolution["price"], 1999)

    def test_multiple_effective_price_axes_are_unverifiable_when_budget_matters(self):
        candidate = product()
        candidate["customization_options"]["颜色分类"][1]["price"] = 2099
        result = evaluate_purchase(
            candidate,
            goal(),
            selected_options={"颜色分类": "白色", "尺码": "XL"},
        )
        self.assertEqual(result.reward_type, "reward_unverifiable")
        self.assertTrue(result.to_dict()["sampling_invalid"])

    def test_candidate_eligibility_uses_score_and_coverage(self):
        result = evaluate_candidate_eligibility(product(), goal())
        self.assertTrue(result["known_acceptable"])
        self.assertTrue(result["known_valid"])
        self.assertEqual(result["status"], PASS)
        self.assertGreaterEqual(result["match_score"], 0.7)

    def test_candidate_eligibility_does_not_require_agent_option_selection(self):
        no_option_instruction = {
            "instruction": "购买支持热洗的洗地机，预算2200元",
            "attributes": ["洗地", "热洗"],
            "instruction_options": [],
        }
        target = product()
        task_goal = {
            "asin": target["asin"],
            "category": target["category"],
            "price_upper": 2200,
            **compile_reward_features(no_option_instruction, target),
        }
        result = evaluate_candidate_eligibility(target, task_goal)
        self.assertTrue(result["known_acceptable"])
        self.assertEqual(result["price_resolution"]["status"], PASS)
        self.assertTrue(result["option_resolution"]["inferred_options"])

    def test_abstain_requires_evidence_and_no_acceptable_candidate(self):
        early = evaluate_abstain(
            effective_result_sets=2,
            opened_candidates=1,
            known_acceptable_candidates=0,
        )
        graceful = evaluate_abstain(
            effective_result_sets=2,
            opened_candidates=2,
            known_acceptable_candidates=0,
        )
        blocked = evaluate_abstain(
            effective_result_sets=2,
            opened_candidates=2,
            known_acceptable_candidates=1,
        )
        self.assertEqual(early.reward_type, "early_abstain")
        self.assertEqual(graceful.reward_type, "graceful_stop")
        self.assertEqual(blocked.reward_type, "early_abstain")

    def test_field_comparators_resist_common_substring_attacks(self):
        self.assertEqual(
            compare_model(["A20"], product(model="A200"))["status"],
            FAIL,
        )
        compatible = product()
        compatible["brand"] = "Generic"
        compatible["title"] = "Compatible with Apple 洗地机"
        self.assertEqual(
            compare_brand(["Apple"], compatible)["status"],
            FAIL,
        )
        negated = product(attributes=["不支持防水"])
        self.assertEqual(
            compare_core_functions(["防水"], negated)["status"],
            FAIL,
        )

    def test_numeric_comparator_normalizes_units(self):
        gate = compare_numeric_spec(
            {"value": 2, "unit": "L", "operator": "eq"},
            "容量为2000ml",
        )
        self.assertEqual(gate["status"], PASS)

    def test_loop_and_max_step_values_are_frozen(self):
        self.assertEqual(fixed_termination("max_steps").reward, -0.5)
        self.assertEqual(fixed_termination("repeat_loop").reward, -0.65)


if __name__ == "__main__":
    unittest.main()
