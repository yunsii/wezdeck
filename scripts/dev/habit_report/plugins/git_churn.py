"""Optional plugin: multi-repo git churn (work machine / configurable)."""

from __future__ import annotations

from datetime import date
from typing import Any

from ..git_churn import (
    collect_git_churn,
    device_profile_is_work,
    ensure_default_config,
    load_config,
)

NAME = "git_churn"


def detect() -> bool:
    cfg = load_config()
    if cfg.enabled == "off":
        return False
    if cfg.enabled == "on":
        return True
    # auto: work device profile, or explicit config file present
    if cfg.config_path:
        return True
    if device_profile_is_work():
        ensure_default_config()
        return True
    return False


def collect(*, start: date, end: date) -> dict[str, Any]:
    if device_profile_is_work():
        ensure_default_config()
    cfg = load_config()
    payload = collect_git_churn(start=start, end=end, cfg=cfg)
    payload["plugin"] = NAME
    payload["detected"] = True
    payload["device_profile_work"] = device_profile_is_work()
    return payload
