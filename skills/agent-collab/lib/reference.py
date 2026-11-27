"""Ticket reference for agents (the web console's 复制引用 on a ticket page).

A short block another agent can act on without asking: which ticket, its
route and state, where its files are (ticket.md / meta.json / events / runs),
where work happens (repos, worktree, branch), what its runs cost, and the
commands that read the rest. Sibling of the session reference
(``native/wezdeck-wsl/remote_reference.go``). Lines with nothing to say are
left out, so a fresh ticket stays a few lines long.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def _short(p: Any) -> str:
    s = str(p or "")
    home = os.path.expanduser("~")
    if home and home != "/" and s.startswith(home + "/"):
        return "~" + s[len(home):]
    return s


def _tokens(n: float) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(int(n))


def _secs(ms: Any) -> str:
    if not isinstance(ms, (int, float)):
        return "?"
    s = ms / 1000
    return f"{s:.1f}s" if s < 120 else f"{s / 60:.1f}min"


def _join(*parts: Any) -> str:
    return " · ".join(str(p) for p in parts if p not in (None, "", [], {}))


def _run_totals(recs: list[dict[str, Any]]) -> str:
    tok = {"input": 0, "cache_read": 0, "cache_write": 0, "output": 0}
    cost = 0.0
    cost_known = False
    turns = 0
    wall = 0
    failed = 0
    for rec in recs:
        t = rec.get("tokens") or {}
        for k in tok:
            if isinstance(t.get(k), (int, float)):
                tok[k] += t[k]
        if isinstance(rec.get("cost_usd"), (int, float)):
            cost += rec["cost_usd"]
            cost_known = True
        if isinstance(rec.get("turns"), int):
            turns += rec["turns"]
        if isinstance(rec.get("wall_ms"), (int, float)):
            wall += rec["wall_ms"]
        if rec.get("exit") not in (0, None):
            failed += 1
    den = tok["input"] + tok["cache_read"] + tok["cache_write"]
    return _join(
        f"{len(recs)} 次" + (f"（失败 {failed}）" if failed else ""),
        f"{turns} turns" if turns else None,
        f"tokens {_tokens(sum(tok.values()))}（in {_tokens(tok['input'])} / cache_read "
        f"{_tokens(tok['cache_read'])} / cache_write {_tokens(tok['cache_write'])} / out {_tokens(tok['output'])}）"
        if sum(tok.values()) else None,
        f"缓存命中 {tok['cache_read'] / den:.0%}" if den else None,
        f"${cost:.4f}" if cost_known else None,
        f"墙钟 {_secs(wall)}" if wall else None,
    )


def _run_line(rec: dict[str, Any], launch: dict[str, Any]) -> str:
    s = rec.get("session") or {}
    reuse = s.get("reuse")
    if reuse and s.get("reason"):
        reuse = f"{reuse}/{s['reason']}"
    rec_trig = rec.get("trigger") if isinstance(rec.get("trigger"), dict) else {}
    trig = (launch.get("trigger") or {}).get("source") or rec_trig.get("source")
    return _join(
        rec.get("run"),
        "/".join(dict.fromkeys(str(x) for x in (rec.get("phase"), rec.get("role")) if x)),
        "/".join(str(x) for x in (rec.get("backend"), rec.get("model")) if x),
        f"exit {rec.get('exit')}" if rec.get("exit") is not None else "未结束",
        f"{rec['turns']} turns" if isinstance(rec.get("turns"), int) else None,
        _secs(rec.get("wall_ms")) if rec.get("wall_ms") is not None else None,
        f"${rec['cost_usd']:.4f}" if isinstance(rec.get("cost_usd"), (int, float)) else None,
        f"会话 {reuse}" if reuse else None,
        f"触发 {trig}" if trig else None,
        f"开始 {rec.get('started_at')}" if rec.get("started_at") else None,
    )


def _checkouts(data_dir: Path) -> dict[str, str]:
    """repo → "base @head7" from the ticket's checkout events (research reads)."""
    out: dict[str, str] = {}
    path = data_dir / "events.jsonl"
    if not path.is_file():
        return out
    with path.open(encoding="utf-8") as f:
        for line in f:
            if '"checkout"' not in line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("kind") == "checkout" and ev.get("repo"):
                out[str(ev["repo"])] = " ".join(x for x in (str(ev.get("base") or ""),
                                                             f"@{str(ev.get('head') or '')[:9]}" if ev.get("head") else "") if x)
    return out


def build(
    tid: str,
    data_dir: Path,
    meta: dict[str, Any],
    mj: dict[str, Any],
    ticket: dict[str, Any],
    recs: list[dict[str, Any]],
    launches: dict[str, dict[str, Any]],
    children: list[dict[str, Any]],
) -> str:
    kind = ticket.get("kind") or "ticket"
    lines = [f"[wezdeck 工单] {ticket.get('title') or tid}",
             "id: " + _join(tid, f"类型 {kind}",
                            f"父单 {ticket['parent']}" if ticket.get("parent") else None)]
    handler = mj.get("handler") if isinstance(mj.get("handler"), dict) else None
    lines.append("路由: " + _join(
        f"{ticket.get('from') or '?'} → {', '.join(ticket.get('repos') or []) or ticket.get('to') or '?'}",
        f"处理方 {handler['repo']}" + (f"（{handler['via']}）" if handler.get("via") else "") if handler and handler.get("repo") else None,
        f"状态 {ticket.get('status')}" + (f"（phase {ticket['phase']}）" if ticket.get("phase") else ""),
        f"owner {ticket['owner']}" if ticket.get("owner") else None,
        f"认领 {meta['claimed_by']}（第 {mj.get('claim_gen')} 次）" if meta.get("claimed_by") else None,
    ))
    origin = mj.get("origin") or {}
    if origin:
        lines.append("来源: " + _join(*(f"{k} {v}" if k != "system" else v for k, v in origin.items())))
    lines.append("时间: " + _join(f"创建 {ticket.get('created_at')}", f"更新 {ticket.get('updated_at')}"))
    prog = ticket.get("progress") or {}
    if prog.get("message"):
        lines.append("进度: " + _join(prog.get("step"), prog.get("message"), prog.get("ts")))
    for key in ("summary", "solution_doc", "source_pr"):
        if meta.get(key) and meta[key] != ticket.get("title"):
            lines.append(f"{key}: {meta[key]}")
    checkouts = _checkouts(data_dir)
    repos = list(dict.fromkeys([str(r) for r in mj.get("repos") or []] + list(checkouts)))
    if repos:
        lines.append("仓库: " + ", ".join(r + (f"（{checkouts[r]}）" if r in checkouts else "") for r in repos))
    if ticket.get("worktree"):
        lines.append(f"工作树: {_short(ticket['worktree'])}"
                     + (f"（分支 {ticket['branch']}）" if ticket.get("branch") else ""))
    elif ticket.get("branch"):
        lines.append(f"分支: {ticket['branch']}")
    lines.append(f"目录: {_short(data_dir)}/（ticket.md · meta.json · events.jsonl"
                 + (" · runs/" if (data_dir / "runs").is_dir() else "") + "）")
    if mj.get("contract_sha256"):
        lines.append(f"契约: contract.md（sha256 {str(mj['contract_sha256'])[:12]}）")
    for name, integ in (mj.get("integration") or {}).items():
        if isinstance(integ, dict):
            lines.append(f"集成 {name}: " + _join(integ.get("branch"), _short(integ.get("worktree")),
                                                 "冲突" if integ.get("conflict") else None))
    if recs:
        lines.append("运行合计: " + _run_totals(recs))
        last = recs[-1]
        lines.append("最近运行: " + _run_line(last, launches.get(last.get("run")) or {}))
        rid = last.get("run")
        if rid:
            files = [f"runs/{rid}.json"] + [f"runs/{rid}{ext}" for ext in (".stream.jsonl", ".final.txt")
                                             if (data_dir / "runs" / f"{rid}{ext}").is_file()]
            lines.append("运行记录: " + " · ".join(files))
            sha = ((launches.get(rid) or {}).get("prompt") or {}).get("store_sha256")
            if sha:
                lines.append(f"初始消息: ticket api prompt --sha {sha}")
    if ticket.get("running"):
        lines.append("进行中: " + ", ".join(ticket["running"]))
    for role, s in (mj.get("sessions") or {}).items():
        if isinstance(s, dict) and s.get("id"):
            lines.append(f"会话 {role}: " + _join(
                s.get("backend"), s.get("id"),
                f"历史 {_tokens(s['history_tokens'])} tokens" if isinstance(s.get("history_tokens"), (int, float)) else None,
                f"ttl {s['cache_ttl']}" if s.get("cache_ttl") else None,
                _short(s.get("worktree")) if s.get("worktree") else None,
            ))
    if children:
        lines.append("子单: " + "; ".join(
            f"{c.get('id')}（{c.get('to') or '?'} · {c.get('status')}）" for c in children))
    lines.append(f"查看: ticket api show --id {tid} · ticket api events --after 0 --ticket {tid}"
                 + (f" · ticket api transcript --run {recs[-1].get('run')}" if recs and recs[-1].get("run") else ""))
    return "\n".join(lines)
