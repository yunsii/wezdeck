"""Per-provider token / cost usage for habit reports.

Sources (authoritative session aggregates — do not reinvent from prompts):
  Claude: last type=cost-state in ~/.claude/projects/**/<session>.jsonl
  Grok:   usage.json session block, or turns[] filtered by endedAt
  Codex:  event_msg last_token_usage deltas (sum in window)

Normalized token fields are additive across sessions. cost_usd is only set when
the provider emits a native dollar figure (Claude) or a known tick scale (Grok).

`by_model` holds the same token/cost skeleton per model id (Claude/Grok native
modelUsage; Codex from nearest turn_context.model when present).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


# Grok persists cost as fixed-point ticks. Local samples match USD ≈ ticks/1e9
# against session scale; confirm against /usage UI before treating as billing.
GROK_COST_USD_TICKS_PER_DOLLAR = 1_000_000_000

_TOKEN_KEYS = (
    "input_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "output_tokens",
    "reasoning_tokens",
    "total_tokens",
)


def parse_claude_start_time(value: Any) -> datetime | None:
    """Claude cost-state startTime is usually epoch milliseconds."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        x = float(value)
        if x > 1e12:
            x /= 1000.0
        try:
            return datetime.fromtimestamp(x, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def empty_model_acc() -> dict[str, Any]:
    return {
        "model_calls": 0,
        "input_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "output_tokens": 0,
        "reasoning_tokens": 0,
        "total_tokens": 0,
        "cost_usd": 0.0,
        "cost_usd_known": False,
    }


def empty_usage_acc() -> dict[str, Any]:
    return {
        "sessions_with_usage": 0,
        "model_calls": 0,
        "input_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "output_tokens": 0,
        "reasoning_tokens": 0,
        "total_tokens": 0,
        "cost_usd": 0.0,
        "cost_usd_known": False,
        "cost_unknown_sessions": 0,
        "by_model": {},  # model_id -> empty_model_acc()
        "attribution": "",
        "notes": [],
    }


def _i(v: Any) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _f(v: Any) -> float:
    try:
        return float(v or 0.0)
    except (TypeError, ValueError):
        return 0.0


def grok_ticks_to_usd(ticks: Any) -> float:
    return _i(ticks) / float(GROK_COST_USD_TICKS_PER_DOLLAR)


def _bump_model(
    acc: dict[str, Any],
    model: str,
    *,
    input_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
    output_tokens: int = 0,
    reasoning_tokens: int = 0,
    total_tokens: int = 0,
    model_calls: int = 0,
    cost_usd: float | None = None,
) -> None:
    by_model: dict[str, Any] = acc.setdefault("by_model", {})
    slot = by_model.get(model)
    if not isinstance(slot, dict):
        slot = empty_model_acc()
        by_model[model] = slot
    slot["input_tokens"] = _i(slot.get("input_tokens")) + _i(input_tokens)
    slot["cache_read_tokens"] = _i(slot.get("cache_read_tokens")) + _i(cache_read_tokens)
    slot["cache_write_tokens"] = _i(slot.get("cache_write_tokens")) + _i(
        cache_write_tokens
    )
    slot["output_tokens"] = _i(slot.get("output_tokens")) + _i(output_tokens)
    slot["reasoning_tokens"] = _i(slot.get("reasoning_tokens")) + _i(reasoning_tokens)
    slot["total_tokens"] = _i(slot.get("total_tokens")) + _i(total_tokens)
    slot["model_calls"] = _i(slot.get("model_calls")) + _i(model_calls)
    if cost_usd is not None:
        slot["cost_usd"] = _f(slot.get("cost_usd")) + _f(cost_usd)
        slot["cost_usd_known"] = True


def add_usage_delta(
    acc: dict[str, Any],
    *,
    input_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
    output_tokens: int = 0,
    reasoning_tokens: int = 0,
    total_tokens: int | None = None,
    model_calls: int = 0,
    cost_usd: float | None = None,
    model: str | None = None,
    count_session: bool = False,
) -> None:
    if count_session:
        acc["sessions_with_usage"] += 1
    acc["input_tokens"] += _i(input_tokens)
    acc["cache_read_tokens"] += _i(cache_read_tokens)
    acc["cache_write_tokens"] += _i(cache_write_tokens)
    acc["output_tokens"] += _i(output_tokens)
    acc["reasoning_tokens"] += _i(reasoning_tokens)
    if total_tokens is None:
        total_tokens = (
            _i(input_tokens)
            + _i(cache_read_tokens)
            + _i(cache_write_tokens)
            + _i(output_tokens)
            + _i(reasoning_tokens)
        )
    total_tokens = _i(total_tokens)
    acc["total_tokens"] += total_tokens
    acc["model_calls"] += _i(model_calls)
    if cost_usd is not None:
        acc["cost_usd"] = _f(acc.get("cost_usd")) + _f(cost_usd)
        acc["cost_usd_known"] = True
    if model:
        _bump_model(
            acc,
            str(model),
            input_tokens=_i(input_tokens),
            cache_read_tokens=_i(cache_read_tokens),
            cache_write_tokens=_i(cache_write_tokens),
            output_tokens=_i(output_tokens),
            reasoning_tokens=_i(reasoning_tokens),
            total_tokens=total_tokens,
            model_calls=_i(model_calls),
            cost_usd=cost_usd,
        )


def add_claude_cost_state(acc: dict[str, Any], row: dict[str, Any]) -> None:
    """Attribute one session from its last cost-state row."""
    mu = row.get("modelUsage") if isinstance(row.get("modelUsage"), dict) else {}
    model_cost = 0.0
    if mu:
        for model, blob in mu.items():
            if not isinstance(blob, dict):
                continue
            thinking = _i(blob.get("thinkingTokens"))
            piece_cost = (
                _f(blob.get("costUSD")) if blob.get("costUSD") is not None else None
            )
            if piece_cost is not None:
                model_cost += piece_cost
            add_usage_delta(
                acc,
                input_tokens=_i(blob.get("inputTokens")),
                cache_read_tokens=_i(blob.get("cacheReadInputTokens")),
                cache_write_tokens=_i(blob.get("cacheCreationInputTokens")),
                output_tokens=_i(blob.get("outputTokens")),
                reasoning_tokens=thinking,
                total_tokens=(
                    _i(blob.get("inputTokens"))
                    + _i(blob.get("cacheReadInputTokens"))
                    + _i(blob.get("cacheCreationInputTokens"))
                    + _i(blob.get("outputTokens"))
                    + thinking
                ),
                cost_usd=piece_cost,
                model=str(model),
            )
    if model_cost <= 0 and row.get("totalCostUSD") is not None:
        acc["cost_usd"] = _f(acc.get("cost_usd")) + _f(row.get("totalCostUSD"))
        acc["cost_usd_known"] = True
    if row.get("hasUnknownModelCost"):
        acc["cost_unknown_sessions"] += 1
    acc["sessions_with_usage"] += 1
    acc["attribution"] = (
        acc.get("attribution")
        or "claude: cost-state for sessions whose startTime falls in window"
    )


def add_grok_usage_blob(acc: dict[str, Any], blob: dict[str, Any]) -> None:
    """Add one Grok session or turn usage object."""
    mu = blob.get("modelUsage") if isinstance(blob.get("modelUsage"), dict) else {}
    cost = grok_ticks_to_usd(blob.get("costUsdTicks"))
    if mu:
        for model, mblob in mu.items():
            if not isinstance(mblob, dict):
                continue
            add_usage_delta(
                acc,
                input_tokens=_i(mblob.get("inputTokens")),
                cache_read_tokens=_i(mblob.get("cachedReadTokens")),
                cache_write_tokens=_i(mblob.get("cacheCreationTokens")),
                output_tokens=_i(mblob.get("outputTokens")),
                reasoning_tokens=_i(mblob.get("reasoningTokens")),
                total_tokens=_i(mblob.get("totalTokens")) or None,
                model_calls=_i(mblob.get("modelCalls")),
                cost_usd=grok_ticks_to_usd(mblob.get("costUsdTicks")),
                model=str(model),
            )
    else:
        add_usage_delta(
            acc,
            input_tokens=_i(blob.get("inputTokens")),
            cache_read_tokens=_i(blob.get("cachedReadTokens")),
            cache_write_tokens=_i(blob.get("cacheCreationTokens")),
            output_tokens=_i(blob.get("outputTokens")),
            reasoning_tokens=_i(blob.get("reasoningTokens")),
            total_tokens=_i(blob.get("totalTokens")) or None,
            model_calls=_i(blob.get("modelCalls")),
            cost_usd=cost,
            model=str(blob.get("primaryModelId") or "") or None,
        )
    acc["attribution"] = (
        acc.get("attribution")
        or "grok: usage.json turns with endedAt in window (else session block)"
    )


def add_codex_last_usage(
    acc: dict[str, Any],
    blob: dict[str, Any],
    *,
    model: str | None = None,
) -> None:
    """Add one Codex last_token_usage delta (already window-filtered by caller)."""
    add_usage_delta(
        acc,
        input_tokens=_i(blob.get("input_tokens")),
        cache_read_tokens=_i(blob.get("cached_input_tokens")),
        cache_write_tokens=_i(blob.get("cache_write_input_tokens")),
        output_tokens=_i(blob.get("output_tokens")),
        reasoning_tokens=_i(blob.get("reasoning_output_tokens")),
        total_tokens=_i(blob.get("total_tokens")) or None,
        model=model or "codex-unknown",
    )
    acc["attribution"] = (
        acc.get("attribution")
        or "codex: sum payload.info.last_token_usage deltas on in-window event_msg"
    )


def _summarize_model_slot(slot: dict[str, Any]) -> dict[str, Any]:
    total = _i(slot.get("total_tokens"))
    cache_read = _i(slot.get("cache_read_tokens"))
    cost_known = bool(slot.get("cost_usd_known"))
    return {
        "model_calls": _i(slot.get("model_calls")),
        "input_tokens": _i(slot.get("input_tokens")),
        "cache_read_tokens": cache_read,
        "cache_write_tokens": _i(slot.get("cache_write_tokens")),
        "output_tokens": _i(slot.get("output_tokens")),
        "reasoning_tokens": _i(slot.get("reasoning_tokens")),
        "total_tokens": total,
        "cache_read_pct": round(100.0 * cache_read / total, 1) if total else 0.0,
        "cost_usd": round(_f(slot.get("cost_usd")), 4) if cost_known else None,
        "cost_usd_known": cost_known,
    }


def _sort_by_model(by_model: dict[str, Any]) -> dict[str, Any]:
    def sort_key(item: tuple[str, Any]) -> tuple:
        name, slot = item
        if not isinstance(slot, dict):
            return (0.0, 0, name)
        cost = _f(slot.get("cost_usd")) if slot.get("cost_usd_known") else 0.0
        return (-cost, -_i(slot.get("total_tokens")), name)

    return {k: v for k, v in sorted(by_model.items(), key=sort_key)}


def summarize_usage(acc: dict[str, Any]) -> dict[str, Any]:
    by_model_raw = acc.get("by_model") or {}
    by_model: dict[str, Any] = {}
    by_model_tokens: dict[str, int] = {}
    if isinstance(by_model_raw, dict):
        for model, slot in by_model_raw.items():
            if not isinstance(slot, dict):
                # Legacy Counter-style: model -> total_tokens int
                try:
                    tok = int(slot)
                except (TypeError, ValueError):
                    continue
                by_model[str(model)] = _summarize_model_slot(
                    {"total_tokens": tok, "cost_usd_known": False}
                )
                by_model_tokens[str(model)] = tok
                continue
            summarized = _summarize_model_slot(slot)
            by_model[str(model)] = summarized
            by_model_tokens[str(model)] = summarized["total_tokens"]
    by_model = _sort_by_model(by_model)
    by_model_tokens = {
        k: by_model_tokens[k]
        for k in by_model
        if k in by_model_tokens
    }

    total = _i(acc.get("total_tokens"))
    cache_read = _i(acc.get("cache_read_tokens"))
    cache_pct = round(100.0 * cache_read / total, 1) if total else 0.0
    cost_known = bool(acc.get("cost_usd_known"))
    return {
        "sessions_with_usage": _i(acc.get("sessions_with_usage")),
        "model_calls": _i(acc.get("model_calls")),
        "input_tokens": _i(acc.get("input_tokens")),
        "cache_read_tokens": cache_read,
        "cache_write_tokens": _i(acc.get("cache_write_tokens")),
        "output_tokens": _i(acc.get("output_tokens")),
        "reasoning_tokens": _i(acc.get("reasoning_tokens")),
        "total_tokens": total,
        "cache_read_pct": cache_pct,
        "cost_usd": round(_f(acc.get("cost_usd")), 4) if cost_known else None,
        "cost_usd_known": cost_known,
        "cost_unknown_sessions": _i(acc.get("cost_unknown_sessions")),
        "by_model": by_model,
        # Kept for older renderers / one-liners.
        "by_model_tokens": by_model_tokens,
        "attribution": acc.get("attribution") or "",
        "notes": list(acc.get("notes") or []),
    }


def merge_usage_summaries(rows: list[dict[str, Any]]) -> dict[str, Any]:
    acc = empty_usage_acc()
    notes: list[str] = []
    attrs: list[str] = []
    for row in rows:
        if not row:
            continue
        acc["sessions_with_usage"] += _i(row.get("sessions_with_usage"))
        acc["model_calls"] += _i(row.get("model_calls"))
        for k in _TOKEN_KEYS:
            acc[k] = _i(acc.get(k)) + _i(row.get(k))
        if row.get("cost_usd_known") and row.get("cost_usd") is not None:
            acc["cost_usd"] = _f(acc.get("cost_usd")) + _f(row.get("cost_usd"))
            acc["cost_usd_known"] = True
        acc["cost_unknown_sessions"] += _i(row.get("cost_unknown_sessions"))
        # Prefer rich by_model; fall back to by_model_tokens.
        rich = row.get("by_model") or {}
        if isinstance(rich, dict) and rich:
            for model, slot in rich.items():
                if not isinstance(slot, dict):
                    continue
                _bump_model(
                    acc,
                    str(model),
                    input_tokens=_i(slot.get("input_tokens")),
                    cache_read_tokens=_i(slot.get("cache_read_tokens")),
                    cache_write_tokens=_i(slot.get("cache_write_tokens")),
                    output_tokens=_i(slot.get("output_tokens")),
                    reasoning_tokens=_i(slot.get("reasoning_tokens")),
                    total_tokens=_i(slot.get("total_tokens")),
                    model_calls=_i(slot.get("model_calls")),
                    cost_usd=_f(slot.get("cost_usd"))
                    if slot.get("cost_usd_known") and slot.get("cost_usd") is not None
                    else None,
                )
        else:
            for model, tok in (row.get("by_model_tokens") or {}).items():
                _bump_model(acc, str(model), total_tokens=_i(tok))
        attr = str(row.get("attribution") or "").strip()
        if attr and attr not in attrs:
            attrs.append(attr)
        for n in row.get("notes") or []:
            if n not in notes:
                notes.append(str(n))
    acc["notes"] = notes
    acc["attribution"] = " | ".join(attrs)
    return summarize_usage(acc)
