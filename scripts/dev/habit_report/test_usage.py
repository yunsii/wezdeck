#!/usr/bin/env python3
"""Unit tests for token/cost usage normalization."""

from __future__ import annotations

import unittest

from habit_report.usage import (
    add_claude_cost_state,
    add_codex_last_usage,
    add_grok_usage_blob,
    empty_usage_acc,
    grok_ticks_to_usd,
    merge_usage_summaries,
    summarize_usage,
)


class UsageNormalizeTests(unittest.TestCase):
    def test_claude_cost_state_no_double_cost(self) -> None:
        acc = empty_usage_acc()
        add_claude_cost_state(
            acc,
            {
                "type": "cost-state",
                "totalCostUSD": 2.5,
                "hasUnknownModelCost": False,
                "modelUsage": {
                    "claude-opus-5": {
                        "inputTokens": 10,
                        "outputTokens": 20,
                        "thinkingTokens": 5,
                        "cacheReadInputTokens": 100,
                        "cacheCreationInputTokens": 30,
                        "costUSD": 2.5,
                    }
                },
            },
        )
        s = summarize_usage(acc)
        self.assertEqual(s["sessions_with_usage"], 1)
        self.assertEqual(s["output_tokens"], 20)
        self.assertEqual(s["reasoning_tokens"], 5)
        self.assertEqual(s["cache_read_tokens"], 100)
        self.assertAlmostEqual(s["cost_usd"] or 0.0, 2.5, places=4)
        self.assertIn("claude-opus-5", s["by_model"])
        self.assertAlmostEqual(s["by_model"]["claude-opus-5"]["cost_usd"] or 0.0, 2.5)
        self.assertEqual(s["by_model"]["claude-opus-5"]["output_tokens"], 20)

    def test_grok_ticks_scale(self) -> None:
        self.assertAlmostEqual(grok_ticks_to_usd(1_000_000_000), 1.0, places=6)
        acc = empty_usage_acc()
        add_grok_usage_blob(
            acc,
            {
                "inputTokens": 100,
                "cachedReadTokens": 50,
                "cacheCreationTokens": 0,
                "outputTokens": 10,
                "reasoningTokens": 2,
                "totalTokens": 162,
                "modelCalls": 1,
                "costUsdTicks": 2_000_000_000,
                "primaryModelId": "grok-4.5-build",
            },
        )
        acc["sessions_with_usage"] += 1
        s = summarize_usage(acc)
        self.assertAlmostEqual(s["cost_usd"] or 0.0, 2.0, places=4)
        self.assertEqual(s["total_tokens"], 162)
        self.assertEqual(s["by_model"]["grok-4.5-build"]["total_tokens"], 162)
        self.assertAlmostEqual(s["by_model"]["grok-4.5-build"]["cost_usd"] or 0.0, 2.0)

    def test_codex_delta_and_merge(self) -> None:
        a = empty_usage_acc()
        add_codex_last_usage(
            a,
            {
                "input_tokens": 10,
                "cached_input_tokens": 5,
                "cache_write_input_tokens": 1,
                "output_tokens": 3,
                "reasoning_output_tokens": 2,
                "total_tokens": 21,
            },
        )
        a["sessions_with_usage"] += 1
        b = empty_usage_acc()
        add_codex_last_usage(
            b,
            {
                "input_tokens": 1,
                "cached_input_tokens": 0,
                "cache_write_input_tokens": 0,
                "output_tokens": 1,
                "reasoning_output_tokens": 0,
                "total_tokens": 2,
            },
        )
        b["sessions_with_usage"] += 1
        merged = merge_usage_summaries([summarize_usage(a), summarize_usage(b)])
        self.assertEqual(merged["sessions_with_usage"], 2)
        self.assertEqual(merged["output_tokens"], 4)
        self.assertIsNone(merged["cost_usd"])


if __name__ == "__main__":
    unittest.main()
