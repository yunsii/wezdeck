#!/usr/bin/env python3
"""reply-language-guard — bind Claude Code user-facing prose to the user's preferred language.

Operator doc: docs/tmux-ui.md#reply-language-guard-trial
Settings snippet: reply-language-guard.settings-snippet.json (machine-local wire only)

Reads the preferred language from (in order):
  1. REPLY_LANGUAGE_GUARD_LANG
  2. ~/.claude/settings.json "language"
  3. REPLY_LANGUAGE_GUARD_DEFAULT (optional)

For CJK-preferring languages (zh / ja / ko), blocks or nudges when stripped prose is
Latin-heavy. Latin-preferring languages (en) are a no-op for enforcement in v1 but still
emit telemetry so thresholds can be tuned later.

Stop (default): block once when the final reply drifts; retry after our own block passes.
PostToolUse (--event post-tool-use): soft additionalContext nudge, one reminder per reply.

Trial telemetry: every judged turn appends one NDJSON row under the state dir (default
~/.local/state/reply-language-guard/events.ndjson). Preview is short; full text is never
stored unless REPLY_LANGUAGE_GUARD_LOG_FULL=1.

Env:
  REPLY_LANGUAGE_GUARD=0              disable entirely
  REPLY_LANGUAGE_GUARD_MODE=enforce|collect   default enforce (collect always on when enabled)
  REPLY_LANGUAGE_GUARD_LANG=…         override preferred language
  REPLY_LANGUAGE_GUARD_STATE=DIR      state + events dir
  REPLY_LANGUAGE_GUARD_LOG_FULL=1     also store prose_sha + longer preview
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

MIN_LATIN = 60
NOTE_MIN_LATIN = 30
RATIO = 3.0
TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024
PREVIEW_CHARS = 120
EVENTS_MAX_BYTES = 20 * 1024 * 1024

EXEMPT = re.compile(
    r"```.*?```|`[^`\n]*`|https?://\S+|(?:~|\.{1,2})?/?[A-Za-z0-9_.@-]+(?:/[A-Za-z0-9_.@-]+)+/?",
    re.S,
)
LATIN = re.compile(r"[A-Za-z]")
HAN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
HIRA = re.compile(r"[\u3040-\u309f]")
KATA = re.compile(r"[\u30a0-\u30ff]")
HANGUL = re.compile(r"[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]")

# language string (lower) → family + which scripts count as "on preferred"
LANG_TABLE = (
    (("简体中文", "繁體中文", "繁体中文", "中文", "chinese", "zh", "zh-cn", "zh-tw", "zh-hans", "zh-hant"), "cjk", "zh"),
    (("日本語", "日文", "japanese", "ja", "jp"), "cjk", "ja"),
    (("한국어", "韓文", "韩文", "korean", "ko", "kr"), "cjk", "ko"),
    (("english", "en", "en-us", "en-gb"), "latin", "en"),
)


def state_dir() -> Path:
    raw = os.environ.get("REPLY_LANGUAGE_GUARD_STATE")
    if raw:
        return Path(raw)
    xdg = os.environ.get("XDG_STATE_HOME")
    if xdg:
        return Path(xdg) / "reply-language-guard"
    return Path.home() / ".local" / "state" / "reply-language-guard"


def settings_language() -> Optional[str]:
    path = Path.home() / ".claude" / "settings.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    lang = data.get("language") if isinstance(data, dict) else None
    return lang if isinstance(lang, str) and lang.strip() else None


def resolve_preferred() -> Tuple[str, str, str]:
    """Return (label, family, script_profile). family is cjk|latin|unknown."""
    label = (
        os.environ.get("REPLY_LANGUAGE_GUARD_LANG")
        or settings_language()
        or os.environ.get("REPLY_LANGUAGE_GUARD_DEFAULT")
        or ""
    ).strip()
    if not label:
        return "", "unknown", ""
    key = label.lower()
    for aliases, family, profile in LANG_TABLE:
        if label in aliases or key in aliases:
            return label, family, profile
    # Heuristic: any CJK char in the label → cjk/zh
    if HAN.search(label) or HIRA.search(label) or KATA.search(label) or HANGUL.search(label):
        return label, "cjk", "zh"
    return label, "unknown", ""


def script_counts(text: str) -> Dict[str, int]:
    prose = EXEMPT.sub(" ", text)
    return {
        "latin": len(LATIN.findall(prose)),
        "han": len(HAN.findall(prose)),
        "hira": len(HIRA.findall(prose)),
        "kata": len(KATA.findall(prose)),
        "hangul": len(HANGUL.findall(prose)),
        "prose_chars": len(prose.strip()),
        "msg_chars": len(text),
    }


def preferred_script_count(counts: Dict[str, int], profile: str) -> int:
    if profile == "ja":
        return counts["han"] + counts["hira"] + counts["kata"]
    if profile == "ko":
        return counts["han"] + counts["hangul"]
    # zh and default cjk: Han is the preferred script; kana/hangul are foreign
    return counts["han"]


def latin_drift(counts: Dict[str, int], profile: str, min_latin: int) -> bool:
    pref = preferred_script_count(counts, profile)
    return counts["latin"] >= min_latin and counts["latin"] > RATIO * pref


def mode() -> str:
    # collect = log only; enforce = log + act; off handled by env=0
    m = (os.environ.get("REPLY_LANGUAGE_GUARD_MODE") or "enforce").strip().lower()
    return m if m in ("enforce", "collect") else "enforce"


def append_event(row: Dict[str, Any]) -> None:
    directory = state_dir()
    try:
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "events.ndjson"
        if path.exists() and path.stat().st_size >= EVENTS_MAX_BYTES:
            rotated = directory / "events.ndjson.1"
            try:
                if rotated.exists():
                    rotated.unlink()
                path.rename(rotated)
            except OSError:
                pass
        line = json.dumps(row, ensure_ascii=False, separators=(",", ":"))
        with path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        return


def preview_of(text: str) -> str:
    prose = EXEMPT.sub(" ", text).strip()
    prose = re.sub(r"\s+", " ", prose)
    limit = 400 if os.environ.get("REPLY_LANGUAGE_GUARD_LOG_FULL") == "1" else PREVIEW_CHARS
    return prose[:limit]


def reason_for(label: str) -> str:
    return (
        f"这条回复主要偏离了你的习惯语言（{label or 'preferred'}）。"
        "给用户看的文字要用该语言（代码、命令、路径和术语原词除外）。"
        "用习惯语言把这条回复重写一遍再结束；本轮后面的进度说明也一样。"
    )


def note_for(label: str) -> str:
    return (
        f"刚才这段给用户看的进度说明主要偏离了习惯语言（{label or 'preferred'}）。"
        "给用户看的文字要用该语言（代码、命令、路径和术语原词除外），从下一句起改回去。"
    )


def latest_note(transcript_path: str) -> Tuple[Optional[str], str]:
    with open(transcript_path, "rb") as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - TRANSCRIPT_TAIL_BYTES))
        lines = f.read().splitlines()
    latest, texts = None, []
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        message = entry.get("message") if entry.get("type") == "assistant" else None
        if not (isinstance(message, dict) and isinstance(message.get("content"), list)):
            continue
        for block in message["content"]:
            if isinstance(block, dict) and block.get("type") == "text" and block.get("text"):
                if message.get("id") != latest:
                    latest, texts = message.get("id"), []
                texts.append(block["text"])
    return latest, "\n".join(texts)


def base_row(
    event: str,
    label: str,
    family: str,
    profile: str,
    counts: Dict[str, int],
    decision: str,
    text: str,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    pref = preferred_script_count(counts, profile) if profile else 0
    ratio = (counts["latin"] / pref) if pref else (float(counts["latin"]) if counts["latin"] else 0.0)
    row: Dict[str, Any] = {
        "ts": int(time.time() * 1000),
        "event": event,
        "decision": decision,
        "preferred": label,
        "family": family,
        "profile": profile,
        "mode": mode(),
        "latin": counts["latin"],
        "han": counts["han"],
        "hira": counts["hira"],
        "kata": counts["kata"],
        "hangul": counts["hangul"],
        "preferred_script": pref,
        "ratio": round(ratio, 3),
        "msg_chars": counts["msg_chars"],
        "prose_chars": counts["prose_chars"],
        "preview": preview_of(text),
        "msg_sha12": hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:12],
    }
    if extra:
        row.update(extra)
    return row


def post_tool_use(data: dict, label: str, family: str, profile: str) -> None:
    path = data.get("transcript_path") or data.get("transcriptPath")
    if not isinstance(path, str):
        return
    message_id, text = latest_note(path)
    if not message_id:
        return
    seen = state_dir() / ("note-" + hashlib.sha256(path.encode()).hexdigest()[:32])
    try:
        if seen.read_text(encoding="utf-8") == message_id:
            return
    except OSError:
        pass
    try:
        state_dir().mkdir(parents=True, exist_ok=True)
        seen.write_text(message_id, encoding="utf-8")
    except OSError:
        pass

    counts = script_counts(text)
    drift = family == "cjk" and profile and latin_drift(counts, profile, NOTE_MIN_LATIN)
    decision = "remind" if drift else "allow"
    append_event(
        base_row(
            "PostToolUse",
            label,
            family,
            profile,
            counts,
            decision,
            text,
            {"message_id": message_id, "session_key_sha12": hashlib.sha256(path.encode()).hexdigest()[:12]},
        )
    )
    if drift and mode() == "enforce":
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PostToolUse",
                        "additionalContext": note_for(label),
                    }
                },
                ensure_ascii=False,
            )
        )


def stop(data: dict, label: str, family: str, profile: str) -> None:
    active = data.get("stop_hook_active", data.get("stopHookActive")) in (True, "true")
    key = (
        data.get("transcript_path")
        or data.get("transcriptPath")
        or data.get("session_id")
        or data.get("sessionId")
    )
    marker = None
    if isinstance(key, str) and key:
        marker = state_dir() / ("stop-" + hashlib.sha256(key.encode()).hexdigest()[:32])

    if active and (marker is None or marker.exists()):
        if marker and marker.exists():
            try:
                marker.unlink()
            except OSError:
                pass
        # Still log the retry pass-through when we have a message
        message = data.get("last_assistant_message", data.get("lastAssistantMessage"))
        if isinstance(message, str):
            counts = script_counts(message)
            append_event(
                base_row(
                    "Stop",
                    label,
                    family,
                    profile,
                    counts,
                    "allow_retry",
                    message,
                    {"stop_hook_active": True},
                )
            )
        return

    message = data.get("last_assistant_message", data.get("lastAssistantMessage"))
    if not isinstance(message, str):
        return
    counts = script_counts(message)
    drift = family == "cjk" and profile and latin_drift(counts, profile, MIN_LATIN)
    if drift:
        if marker:
            try:
                state_dir().mkdir(parents=True, exist_ok=True)
                marker.write_text("", encoding="utf-8")
            except OSError:
                pass
        append_event(
            base_row(
                "Stop",
                label,
                family,
                profile,
                counts,
                "block" if mode() == "enforce" else "would_block",
                message,
                {"stop_hook_active": bool(active)},
            )
        )
        if mode() == "enforce":
            out = {"decision": "block", "reason": reason_for(label), "systemMessage": f"回复语言偏离习惯语言（{label}），已要求重写。"}
            print(json.dumps(out, ensure_ascii=False))
        return

    if marker and marker.exists():
        try:
            marker.unlink()
        except OSError:
            pass
    append_event(
        base_row(
            "Stop",
            label,
            family,
            profile,
            counts,
            "allow",
            message,
            {"stop_hook_active": bool(active)},
        )
    )


def report() -> int:
    path = state_dir() / "events.ndjson"
    if not path.exists():
        print(f"no events at {path}", file=sys.stderr)
        return 1
    tallies: Dict[str, int] = {}
    blocks = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            key = f"{row.get('event')}:{row.get('decision')}"
            tallies[key] = tallies.get(key, 0) + 1
            if row.get("decision") in ("block", "would_block", "remind"):
                blocks.append(row)
    print(f"events_file={path}")
    print(f"preferred_now={resolve_preferred()[0]!r} family={resolve_preferred()[1]}")
    print("counts:")
    for k in sorted(tallies):
        print(f"  {k}={tallies[k]}")
    print(f"recent_actions={min(10, len(blocks))} (newest last):")
    for row in blocks[-10:]:
        print(
            f"  {row.get('ts')} {row.get('event')} {row.get('decision')} "
            f"latin={row.get('latin')} pref={row.get('preferred_script')} "
            f"ratio={row.get('ratio')} preview={row.get('preview')!r}"
        )
    return 0


def main(argv: list[str]) -> int:
    if "--report" in argv:
        return report()
    if os.environ.get("REPLY_LANGUAGE_GUARD", "1") == "0":
        return 0
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0
    if not isinstance(data, dict):
        return 0

    label, family, profile = resolve_preferred()
    if family == "unknown" and not label:
        # No preferred language configured → collect a single skip marker per process is noisy;
        # stay silent and do not enforce.
        return 0

    if "--event=post-tool-use" in argv or argv[-2:] == ["--event", "post-tool-use"]:
        post_tool_use(data, label, family, profile)
        return 0
    stop(data, label, family, profile)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception:  # noqa: BLE001 — never break the session
        sys.exit(0)
