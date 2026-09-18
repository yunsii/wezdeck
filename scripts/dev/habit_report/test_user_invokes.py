#!/usr/bin/env python3
"""Smoke tests for user-invoke / .system skill parsing helpers."""

from __future__ import annotations

import unittest

from datetime import datetime, timezone, timedelta

from habit_report.common import (
    iter_claude_command_names,
    iter_claude_forked_skills,
    skill_from_path,
    slash_command_name,
)
from habit_report.session import (
    char_bucket,
    classify_user_feed,
    count_urls,
    empty_session_acc,
    normalize_user_feed_text,
    record_goal_completed,
    record_timing,
    record_user_message,
    summarize_session,
    timing_from_timestamps,
)


class SkillPathTests(unittest.TestCase):
    def test_agents_and_system_paths(self) -> None:
        self.assertEqual(
            skill_from_path("/home/u/.agents/skills/coco-commit/SKILL.md"),
            "coco-commit",
        )
        self.assertEqual(
            skill_from_path("/home/u/.codex/skills/.system/review-agent/SKILL.md"),
            "review-agent",
        )
        self.assertEqual(
            skill_from_path("/home/u/.codex/skills/.system/openai-docs/SKILL.md"),
            "openai-docs",
        )
        self.assertEqual(
            skill_from_path("skills/cmdb/SKILL.md"),
            "cmdb",
        )
        self.assertEqual(
            skill_from_path(
                "/home/u/github/wezterm-config/scripts/dev/adversarial-review/SKILL.md"
            ),
            "adversarial-review",
        )
        self.assertIsNone(
            skill_from_path(
                "/home/u/.claude/plugins/.../plugins/code-review/commands/code-review.md"
            )
        )


class SlashTests(unittest.TestCase):
    def test_prompt_slash(self) -> None:
        self.assertEqual(slash_command_name("/goal 落地文档"), "goal")
        self.assertEqual(slash_command_name("/code-review 审一下"), "code-review")
        self.assertIsNone(slash_command_name("/clear"))
        self.assertIsNone(slash_command_name("/home"))
        self.assertIsNone(slash_command_name("ordinary text"))

    def test_claude_command_name_xml(self) -> None:
        text = (
            "<command-message>goal</command-message>\n"
            "<command-name>/goal</command-name>\n"
            "<command-args>写周报</command-args>"
        )
        self.assertEqual(iter_claude_command_names(text), ["goal"])
        self.assertEqual(iter_claude_command_names("<command-name>/clear</command-name>"), [])

    def test_claude_forked_skill(self) -> None:
        text = (
            '<local-command-stdout>Running</local-command-stdout>\n'
            '<forked-skill-launch>{"agentId":"a1","skillName":"code-review",'
            '"description":"/code-review 评审"}</forked-skill-launch>'
        )
        self.assertEqual(iter_claude_forked_skills(text), ["code-review"])


class SessionTimingTests(unittest.TestCase):
    def test_active_caps_overnight_gap(self) -> None:
        t0 = datetime(2026, 9, 10, 10, 0, tzinfo=timezone.utc)
        t1 = t0 + timedelta(minutes=5)
        t2 = t0 + timedelta(hours=20)  # overnight
        t3 = t2 + timedelta(minutes=3)
        active, wall, segments = timing_from_timestamps([t0, t1, t2, t3])
        self.assertEqual(segments, 2)
        self.assertLess(active, 15 * 60 * 2 + 1)
        self.assertGreater(wall, 19 * 3600)

    def test_char_bucket_and_urls(self) -> None:
        self.assertEqual(char_bucket(50), "lt_200")
        self.assertEqual(char_bucket(5000), "2k_10k")
        self.assertEqual(count_urls("see https://example.com/a and https://x.test/b"), 2)
        self.assertEqual(count_urls("```\nhttps://not-counted.example\n```"), 0)

    def test_goal_elapsed_summary(self) -> None:
        acc = empty_session_acc()
        record_goal_completed(acc, 994229)
        record_goal_completed(acc, 600000)
        t0 = datetime(2026, 9, 10, 10, 0, tzinfo=timezone.utc)
        record_timing(acc, [t0, t0 + timedelta(minutes=8)])
        summary = summarize_session(acc)
        self.assertEqual(summary["goal_completed"], 2)
        self.assertIsNotNone(summary["goal_elapsed_minutes_p50"])
        self.assertGreater(summary["active_minutes_total"], 0)

    def test_normalize_excludes_skill_and_envelope(self) -> None:
        self.assertIsNone(
            normalize_user_feed_text(
                "Base directory for this skill: /home/u/.claude/skills/coco-commit\n\n# /coco-commit\n"
            )
        )
        self.assertIsNone(
            normalize_user_feed_text(
                "<user_info>\nOS Version: linux\n</user_info>\n"
            )
        )
        self.assertIsNone(
            normalize_user_feed_text(
                "<system-reminder>\nAs you answer the user's questions, you can use the following context\n</system-reminder>\n"
            )
        )
        self.assertIsNone(
            normalize_user_feed_text(
                "This session is being continued from a previous conversation that ran out of context. The summary below covers…"
            )
        )
        self.assertIsNone(
            normalize_user_feed_text(
                "<task-notification>\n<task-id>abc</task-id>\n</task-notification>\n"
            )
        )
        got = normalize_user_feed_text(
            "<user_info>\nOS Version: linux\n</user_info>\n"
            "<user_query>\n帮我改一下热键\n</user_query>\n"
        )
        self.assertEqual(got, "帮我改一下热键")
        self.assertEqual(normalize_user_feed_text("普通短指令"), "普通短指令")

    def test_record_user_message_excludes_injection(self) -> None:
        acc = empty_session_acc()
        record_user_message(
            acc,
            "Base directory for this skill: /x/skills/coco-commit\n\n```\nbig\n```\n",
        )
        record_user_message(acc, "短指令")
        self.assertEqual(acc["user_turns"], 1)
        self.assertEqual(acc["user_chars"], len("短指令"))
        self.assertGreater(acc["excluded_feed_chars"], 0)
        self.assertEqual(acc["injected_msgs"]["skill_body"], 1)
        summary = summarize_session(acc)
        self.assertIn("skill_body", summary["injected"])
        self.assertEqual(summary["injected"]["skill_body"]["msgs"], 1)

    def test_classify_kinds(self) -> None:
        self.assertEqual(
            classify_user_feed(
                "<system-reminder>\nAs you answer the user's questions, context\n</system-reminder>"
            )[1],
            "system_reminder.context",
        )
        self.assertEqual(
            classify_user_feed("<task-notification>\nx\n</task-notification>")[1],
            "task_notification",
        )


if __name__ == "__main__":
    unittest.main()
