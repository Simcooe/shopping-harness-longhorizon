import unittest

from web_agent_site.engine.termination import EvidenceProgressTracker


class TerminationV3Test(unittest.TestCase):
    def test_result_set_requires_three_new_asins_and_new_fingerprint(self):
        tracker = EvidenceProgressTracker(exact_repeat_limit=99, no_progress_limit=99)
        first = tracker.record("search", "one", ["1", "2"])
        second = tracker.record("search", "two", ["1", "2", "3", "4", "5"])
        repeated = tracker.record("search", "three", ["1", "2", "3", "4", "5"])
        self.assertEqual(first["effective_result_sets"], 0)
        self.assertEqual(second["effective_result_sets"], 1)
        self.assertEqual(repeated["effective_result_sets"], 1)

    def test_product_credit_budget_does_not_hide_new_runtime_progress(self):
        tracker = EvidenceProgressTracker(
            exact_repeat_limit=99,
            no_progress_limit=99,
            product_open_progress_budget=2,
        )
        first = tracker.record("click", "111111111111", ["111111111111"])
        second = tracker.record("click", "222222222222", ["222222222222"])
        third = tracker.record("click", "333333333333", ["333333333333"])
        self.assertTrue(first["evidence_added"])
        self.assertTrue(second["evidence_added"])
        self.assertFalse(
            any(item.startswith("product:") for item in third["evidence_added"])
        )
        self.assertIn("product:333333333333", third["runtime_progress_added"])
        self.assertEqual(third["no_progress_steps"], 0)
        self.assertEqual(third["evidence_counts"]["product"], 2)
        self.assertEqual(third["runtime_evidence_counts"]["product"], 3)

    def test_result_credit_budget_does_not_hide_new_pages(self):
        tracker = EvidenceProgressTracker(
            exact_repeat_limit=99,
            no_progress_limit=4,
            result_set_progress_budget=1,
        )
        first = tracker.record("search", "one", ["1", "2", "3"])
        tracker.record("click", "back to search", [])
        second = tracker.record("search", "two", ["4", "5", "6"])

        self.assertTrue(first["credited_evidence_added"])
        self.assertFalse(second["credited_evidence_added"])
        self.assertTrue(second["runtime_progress_added"])
        self.assertEqual(second["effective_result_sets"], 1)
        self.assertEqual(second["runtime_evidence_counts"]["result_set"], 2)
        self.assertEqual(second["no_progress_steps"], 0)
        self.assertIsNone(second["termination_reason"])

    def test_next_prev_ping_pong_does_not_refresh_seen_result_pages(self):
        tracker = EvidenceProgressTracker(
            exact_repeat_limit=99,
            no_progress_limit=4,
            result_set_progress_budget=1,
        )
        page_one = ["1", "2", "3"]
        page_two = ["4", "5", "6"]
        tracker.record("search", "query", page_one)
        tracker.record("click", "next >", page_two)
        for action, page in (
            ("< prev", page_one),
            ("next >", page_two),
            ("< prev", page_one),
        ):
            result = tracker.record("click", action, page)
            self.assertFalse(result["runtime_progress_added"])
            self.assertIsNone(result["termination_reason"])
        result = tracker.record("click", "next >", page_two)
        self.assertEqual(result["termination_reason"], "repeat_loop")

    def test_one_or_two_new_asins_do_not_refresh_runtime_progress(self):
        tracker = EvidenceProgressTracker(
            exact_repeat_limit=99,
            no_progress_limit=4,
        )
        tracker.record("search", "seed", ["1", "2", "3"])
        tracker.record("click", "back to search", [])
        one = tracker.record("search", "one-new", ["1", "2", "3", "4"])
        two = tracker.record("search", "two-new", ["1", "2", "3", "5", "6"])
        final = tracker.record("click", "back to search", [])

        self.assertFalse(one["runtime_progress_added"])
        self.assertFalse(two["runtime_progress_added"])
        self.assertEqual(final["termination_reason"], "repeat_loop")

    def test_subpage_and_option_are_unique_evidence(self):
        tracker = EvidenceProgressTracker(exact_repeat_limit=99, no_progress_limit=99)
        tracker.record("click", "111111111111", ["111111111111"])
        first = tracker.record(
            "click",
            "Features",
            ["111111111111"],
            page_type="information_subpage",
        )
        repeated = tracker.record(
            "click",
            "Features",
            ["111111111111"],
            page_type="information_subpage",
        )
        option = tracker.record(
            "click",
            "白色",
            ["111111111111"],
            page_type="product_detail",
            selected_options={"颜色分类": "白色"},
        )
        self.assertTrue(any(item.startswith("subpage:") for item in first["evidence_added"]))
        self.assertFalse(
            any(item.startswith("subpage:") for item in repeated["evidence_added"])
        )
        self.assertTrue(any(item.startswith("option:") for item in option["evidence_added"]))

    def test_subpage_credit_budget_does_not_hide_new_runtime_subpage(self):
        tracker = EvidenceProgressTracker(
            exact_repeat_limit=99,
            no_progress_limit=99,
            subpage_progress_budget=1,
        )
        tracker.record("click", "111111111111", ["111111111111"])
        tracker.record(
            "click",
            "Description",
            ["111111111111"],
            page_type="information_subpage",
        )
        second = tracker.record(
            "click",
            "Features",
            ["111111111111"],
            page_type="information_subpage",
        )

        self.assertFalse(second["credited_evidence_added"])
        self.assertIn(
            "subpage:111111111111:features",
            second["runtime_progress_added"],
        )
        self.assertEqual(second["no_progress_steps"], 0)
        self.assertEqual(second["evidence_counts"]["subpage"], 1)
        self.assertEqual(second["runtime_evidence_counts"]["subpage"], 2)

    def test_reopening_same_product_and_option_still_terminates(self):
        tracker = EvidenceProgressTracker(
            exact_repeat_limit=99,
            no_progress_limit=4,
        )
        asin = "111111111111"
        tracker.record("click", asin, [asin])
        tracker.record(
            "click",
            "白色",
            [asin],
            selected_options={"颜色分类": "白色"},
        )
        for action, kwargs in (
            ("back to search", {}),
            ("search", {}),
            (asin, {}),
            ("白色", {"selected_options": {"颜色分类": "白色"}}),
        ):
            result = tracker.record(
                "search" if action == "search" else "click",
                action,
                [asin] if action != "back to search" else [],
                **kwargs,
            )
        self.assertEqual(result["termination_reason"], "repeat_loop")

    def test_four_actions_without_new_evidence_terminate(self):
        tracker = EvidenceProgressTracker(
            exact_repeat_limit=99,
            no_progress_limit=4,
        )
        tracker.record("search", "one", ["1", "2", "3"])
        for index in range(3):
            result = tracker.record("click", f"invalid-{index}", [])
            self.assertIsNone(result["termination_reason"])
        result = tracker.record("click", "invalid-final", [])
        self.assertEqual(result["termination_reason"], "repeat_loop")

    def test_eleven_digit_catalog_id_adds_product_evidence(self):
        tracker = EvidenceProgressTracker(exact_repeat_limit=99, no_progress_limit=99)
        result = tracker.record("click", "35842622441", ["35842622441"])
        self.assertIn("product:35842622441", result["evidence_added"])
        self.assertEqual(result["opened_candidate_count"], 1)


if __name__ == "__main__":
    unittest.main()
