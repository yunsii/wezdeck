"""Session-level habit signals: active time, segments, feed volume, media.

Wall-clock session span is intentionally NOT a primary metric — /goal harness
time and multi-day resume/continue make first→last timestamps misleading.
"""

from __future__ import annotations

import re
from collections import Counter
from datetime import datetime
from typing import Any

# Cap each inter-message gap so overnight AFK does not inflate "active" time.
ACTIVE_GAP_CAP_S = 15 * 60
# Idle longer than this starts a new work segment (resume / next-day continue).
SEGMENT_IDLE_S = 2 * 3600
# User message longer than this counts as a long-paste (after feed normalize).
LONG_PASTE_CHARS = 10_000

_URL_RE = re.compile(r"https?://[^\s<>\"')\]]+", re.IGNORECASE)
_CODE_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
_USER_QUERY_RE = re.compile(
    r"<user_query>\s*(.*?)\s*</user_query>", re.DOTALL | re.IGNORECASE
)
_USER_INFO_RE = re.compile(r"<user_info>.*?</user_info>", re.DOTALL | re.IGNORECASE)


def empty_session_acc() -> dict[str, Any]:
    return {
        "user_turns": 0,
        "user_chars": 0,
        "images": 0,
        "urls": 0,
        "sessions_with_image": 0,
        "sessions_with_url": 0,
        "char_buckets": Counter(),
        "long_paste_msgs": 0,
        "paste_chars": 0,  # fenced ``` blocks inside countable feed
        "typed_chars": 0,  # countable feed minus fenced blocks
        "excluded_feed_msgs": 0,
        "excluded_feed_chars": 0,
        # Protocol / agent injections that arrived on the user channel.
        "injected_msgs": Counter(),
        "injected_chars": Counter(),
        "active_seconds_list": [],
        "wall_seconds_list": [],  # diagnostic only
        "segments_list": [],
        "multi_segment_sessions": 0,
        "sessions_timed": 0,
        "goal_completed": 0,
        "goal_elapsed_ms_list": [],
        "rewrites": Counter({"once": 0, "twice": 0, "thrice_plus": 0}),
        "tool_route": Counter(),
    }


_CONTINUATION_MARKERS = (
    "This session is being continued from a previous conversation",
    "This session is being continued from a previous",
)
# Subagent / fanout harness prompts injected as role=user (not the human).
_HARNESS_ROLE_HEADS = (
    "You are an **adversarial verifier**",
    "You are a devil's advocate",
    "You are the facilitator/judge",
    "You are the Goal Summarizer",
    "You are an **adversarial",
)

# Human-readable labels for weekly report (stable ids → 中文).
INJECT_LABELS: dict[str, str] = {
    "skill_body": "Skill 正文灌入",
    "skill_catalog": "Skill 目录刷屏",
    "system_reminder.skills": "system-reminder·技能列表",
    "system_reminder.context": "system-reminder·上下文",
    "system_reminder.date": "system-reminder·日期变更",
    "system_reminder.background_task": "system-reminder·后台任务",
    "system_reminder.mcp": "system-reminder·MCP",
    "system_reminder.plan": "system-reminder·Plan",
    "system_reminder.monitor": "system-reminder·Monitor",
    "system_reminder.other": "system-reminder·其它",
    "task_notification": "后台 task-notification",
    "compact_continuation": "续写/压缩摘要",
    "harness_role": "子代理/harness 角色提示",
    "user_info_envelope": "user_info 信封",
    "empty": "空消息",
}


def _classify_system_reminder(text: str) -> str:
    body = text.lower()
    if "skills are available" in body or "available skills" in body:
        return "system_reminder.skills"
    if "as you answer the user's questions" in body or "following context" in body:
        return "system_reminder.context"
    if "local date has changed" in body or "today's date" in body:
        return "system_reminder.date"
    if "background task" in body:
        return "system_reminder.background_task"
    if "mcp server" in body:
        return "system_reminder.mcp"
    if "plan mode is active" in body:
        return "system_reminder.plan"
    if "monitor-event" in body or "<monitor" in body:
        return "system_reminder.monitor"
    return "system_reminder.other"


def classify_user_feed(text: str) -> tuple[str | None, str | None]:
    """Return (countable_text, inject_kind).

    countable_text is None when the row is protocol/agent injection on the
    user channel; inject_kind is then a stable id (see INJECT_LABELS).
    """
    if not text or not text.strip():
        return None, "empty"
    stripped = text.strip()
    head = stripped[:500]
    head_l = head.lower()

    if "Base directory for this skill:" in stripped[:800]:
        return None, "skill_body"
    if "skills are available" in head_l and not head_l.startswith("<system-reminder>"):
        return None, "skill_catalog"
    if head_l.startswith("<system-reminder>"):
        return None, _classify_system_reminder(stripped)
    if "<task-notification>" in stripped[:200]:
        return None, "task_notification"
    for marker in _CONTINUATION_MARKERS:
        if marker in stripped[:400]:
            return None, "compact_continuation"
    for marker in _HARNESS_ROLE_HEADS:
        if stripped.startswith(marker):
            return None, "harness_role"

    if "<user_query>" in stripped:
        parts = [p.strip() for p in _USER_QUERY_RE.findall(stripped) if p and p.strip()]
        if not parts:
            return None, "user_info_envelope"
        return classify_user_feed("\n".join(parts))
    if "<user_info>" in stripped:
        return None, "user_info_envelope"

    return stripped, None


def normalize_user_feed_text(text: str) -> str | None:
    """Return countable user feed text, or None if protocol injection/envelope."""
    cleaned, _kind = classify_user_feed(text)
    return cleaned


def char_bucket(n: int) -> str:
    if n < 200:
        return "lt_200"
    if n < 2000:
        return "200_2k"
    if n < 10_000:
        return "2k_10k"
    return "gt_10k"


def count_urls(text: str) -> int:
    """Count http(s) URLs; strip fenced code to cut false positives."""
    if not text:
        return 0
    stripped = _CODE_FENCE_RE.sub(" ", text)
    return len(_URL_RE.findall(stripped))


def timing_from_timestamps(
    timestamps: list[datetime],
    *,
    gap_cap_s: int = ACTIVE_GAP_CAP_S,
    segment_idle_s: int = SEGMENT_IDLE_S,
) -> tuple[float, float, int]:
    """Return (active_seconds, wall_seconds, segment_count)."""
    if len(timestamps) < 2:
        if timestamps:
            return 0.0, 0.0, 1
        return 0.0, 0.0, 0
    ts = sorted(timestamps)
    wall = (ts[-1] - ts[0]).total_seconds()
    active = 0.0
    segments = 1
    for a, b in zip(ts, ts[1:]):
        gap = (b - a).total_seconds()
        if gap < 0:
            continue
        if gap > segment_idle_s:
            segments += 1
        active += min(gap, gap_cap_s)
    return active, wall, segments


def record_user_message(acc: dict[str, Any], text: str, *, images: int = 0) -> None:
    raw = text or ""
    cleaned, inject_kind = classify_user_feed(raw)
    if cleaned is None:
        if images <= 0:
            kind = inject_kind or "empty"
            acc["excluded_feed_msgs"] += 1
            acc["excluded_feed_chars"] += len(raw)
            acc["injected_msgs"][kind] += 1
            acc["injected_chars"][kind] += len(raw)
            return
        cleaned = ""
    acc["user_turns"] += 1
    n = len(cleaned)
    acc["user_chars"] += n
    fence_chars = sum(len(m.group(0)) for m in _CODE_FENCE_RE.finditer(cleaned))
    acc["paste_chars"] += fence_chars
    acc["typed_chars"] += max(0, n - fence_chars)
    acc["char_buckets"][char_bucket(n)] += 1
    if n >= LONG_PASTE_CHARS:
        acc["long_paste_msgs"] += 1
    # URLs from cleaned feed only (not skill dumps / envelopes).
    acc["urls"] += count_urls(cleaned)
    acc["images"] += images


def record_session_flags(
    acc: dict[str, Any], *, had_image: bool, had_url: bool
) -> None:
    if had_image:
        acc["sessions_with_image"] += 1
    if had_url:
        acc["sessions_with_url"] += 1


def record_timing(acc: dict[str, Any], timestamps: list[datetime]) -> None:
    active, wall, segments = timing_from_timestamps(timestamps)
    if not timestamps:
        return
    acc["sessions_timed"] += 1
    acc["active_seconds_list"].append(active)
    acc["wall_seconds_list"].append(wall)
    acc["segments_list"].append(segments)
    if segments >= 3:
        acc["multi_segment_sessions"] += 1


def record_rewrites(acc: dict[str, Any], path_counts: Counter[str]) -> None:
    for _path, n in path_counts.items():
        if n <= 1:
            acc["rewrites"]["once"] += 1
        elif n == 2:
            acc["rewrites"]["twice"] += 1
        else:
            acc["rewrites"]["thrice_plus"] += 1


def record_goal_completed(acc: dict[str, Any], elapsed_ms: int | None) -> None:
    acc["goal_completed"] += 1
    if elapsed_ms is not None and elapsed_ms >= 0:
        acc["goal_elapsed_ms_list"].append(int(elapsed_ms))


def _percentile(sorted_vals: list[float], p: float) -> float | None:
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    idx = int(round((len(sorted_vals) - 1) * p))
    idx = max(0, min(len(sorted_vals) - 1, idx))
    return sorted_vals[idx]


def summarize_session(acc: dict[str, Any]) -> dict[str, Any]:
    active_list = [float(x) for x in (acc.get("active_seconds_list") or [])]
    wall_list = [float(x) for x in (acc.get("wall_seconds_list") or [])]
    seg_list = [int(x) for x in (acc.get("segments_list") or [])]
    goal_ms = [int(x) for x in (acc.get("goal_elapsed_ms_list") or [])]
    active_sorted = sorted(active_list)
    wall_sorted = sorted(wall_list)
    goal_sorted = sorted(goal_ms)

    def min_of(secs: float | None) -> float | None:
        if secs is None:
            return None
        return round(secs / 60.0, 1)

    buckets = acc.get("char_buckets") or Counter()
    if isinstance(buckets, Counter):
        buckets_d = dict(buckets)
    else:
        buckets_d = dict(buckets)

    rewrites = acc.get("rewrites") or {}
    if isinstance(rewrites, Counter):
        rewrites_d = dict(rewrites)
    else:
        rewrites_d = dict(rewrites)

    route = acc.get("tool_route") or {}
    if isinstance(route, Counter):
        route_d = dict(route.most_common())
    else:
        route_d = dict(route)

    inj_msgs = acc.get("injected_msgs") or Counter()
    inj_chars = acc.get("injected_chars") or Counter()
    if not isinstance(inj_msgs, Counter):
        inj_msgs = Counter(inj_msgs)
    if not isinstance(inj_chars, Counter):
        inj_chars = Counter(inj_chars)
    injected = {
        kind: {
            "msgs": int(inj_msgs.get(kind, 0)),
            "chars": int(inj_chars.get(kind, 0)),
            "label": INJECT_LABELS.get(kind, kind),
        }
        for kind in sorted(
            set(inj_msgs) | set(inj_chars),
            key=lambda k: -int(inj_chars.get(k, 0)),
        )
        if int(inj_msgs.get(kind, 0)) or int(inj_chars.get(kind, 0))
    }

    return {
        "user_turns": int(acc.get("user_turns") or 0),
        "user_chars": int(acc.get("user_chars") or 0),
        "images": int(acc.get("images") or 0),
        "urls": int(acc.get("urls") or 0),
        "sessions_with_image": int(acc.get("sessions_with_image") or 0),
        "sessions_with_url": int(acc.get("sessions_with_url") or 0),
        "sessions_timed": int(acc.get("sessions_timed") or 0),
        "char_buckets": buckets_d,
        "long_paste_msgs": int(acc.get("long_paste_msgs") or 0),
        "paste_chars": int(acc.get("paste_chars") or 0),
        "typed_chars": int(acc.get("typed_chars") or 0),
        "excluded_feed_msgs": int(acc.get("excluded_feed_msgs") or 0),
        "excluded_feed_chars": int(acc.get("excluded_feed_chars") or 0),
        "injected": injected,
        "active_minutes_total": round(sum(active_list) / 60.0, 1),
        "active_minutes_p50": min_of(_percentile(active_sorted, 0.5)),
        "active_minutes_p90": min_of(_percentile(active_sorted, 0.9)),
        "active_minutes_list": [round(s / 60.0, 1) for s in active_list],
        "wall_minutes_p50_diag": min_of(_percentile(wall_sorted, 0.5)),
        "wall_minutes_p90_diag": min_of(_percentile(wall_sorted, 0.9)),
        "wall_minutes_list_diag": [round(s / 60.0, 1) for s in wall_list],
        "segments_total": sum(seg_list),
        "segments_p50": _percentile(sorted(float(x) for x in seg_list), 0.5),
        "segments_list": seg_list,
        "multi_segment_sessions": int(acc.get("multi_segment_sessions") or 0),
        "goal_completed": int(acc.get("goal_completed") or 0),
        "goal_elapsed_minutes_total": round(sum(goal_ms) / 60000.0, 1)
        if goal_ms
        else 0.0,
        "goal_elapsed_minutes_p50": round(
            (_percentile(goal_sorted, 0.5) or 0) / 60000.0, 1
        )
        if goal_ms
        else None,
        "goal_elapsed_minutes_list": [round(ms / 60000.0, 1) for ms in goal_sorted],
        "rewrites": rewrites_d,
        "tool_route": route_d,
        "notes": [
            "active_minutes = sum of inter-message gaps capped at 15m; "
            "segments split on >2h idle (resume/multi-day continue)",
            "wall_minutes_*_diag is first→last span (misleading with resume/goal) — not for BLUF",
            "goal_elapsed_* from goal_updated.elapsed_ms on goal_completed only",
            "user_chars = human feed (typed+paste); typed_chars omits ``` fences; "
            "injected.* = protocol/agent rows on the user channel (per kind); "
            "compare by_provider.session.injected across agents",
        ],
    }



def merge_session_summaries(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Merge per-provider summarized session dicts (already summarized)."""
    if not rows:
        return summarize_session(empty_session_acc())
    # Re-accumulate from provider summaries where possible; lists may be present.
    acc = empty_session_acc()
    for row in rows:
        if not row:
            continue
        acc["user_turns"] += int(row.get("user_turns") or 0)
        acc["user_chars"] += int(row.get("user_chars") or 0)
        acc["images"] += int(row.get("images") or 0)
        acc["urls"] += int(row.get("urls") or 0)
        acc["sessions_with_image"] += int(row.get("sessions_with_image") or 0)
        acc["sessions_with_url"] += int(row.get("sessions_with_url") or 0)
        acc["sessions_timed"] += int(row.get("sessions_timed") or 0)
        acc["long_paste_msgs"] += int(row.get("long_paste_msgs") or 0)
        acc["paste_chars"] += int(row.get("paste_chars") or 0)
        acc["typed_chars"] += int(row.get("typed_chars") or 0)
        acc["excluded_feed_msgs"] += int(row.get("excluded_feed_msgs") or 0)
        acc["excluded_feed_chars"] += int(row.get("excluded_feed_chars") or 0)
        acc["multi_segment_sessions"] += int(row.get("multi_segment_sessions") or 0)
        acc["goal_completed"] += int(row.get("goal_completed") or 0)
        for k, v in (row.get("char_buckets") or {}).items():
            acc["char_buckets"][k] += int(v)
        for k, v in (row.get("rewrites") or {}).items():
            acc["rewrites"][k] += int(v)
        for kind, meta in (row.get("injected") or {}).items():
            if not isinstance(meta, dict):
                continue
            acc["injected_msgs"][kind] += int(meta.get("msgs") or 0)
            acc["injected_chars"][kind] += int(meta.get("chars") or 0)
        for k, v in (row.get("tool_route") or {}).items():
            acc["tool_route"][k] += int(v)
        # Reconstruct approximate lists from totals is lossy for percentiles.
        # Prefer provider-exported raw lists when present.
        for val in row.get("active_minutes_list") or []:
            acc["active_seconds_list"].append(float(val) * 60.0)
        for val in row.get("wall_minutes_list_diag") or []:
            acc["wall_seconds_list"].append(float(val) * 60.0)
        for val in row.get("segments_list") or []:
            acc["segments_list"].append(int(val))
        for val in row.get("goal_elapsed_minutes_list") or []:
            acc["goal_elapsed_ms_list"].append(int(float(val) * 60000))
    return summarize_session(acc)
