#!/usr/bin/env python3
"""Delete the given hostnames from a Windows Chrome profile's history and omnibox suggestions.

Invoked by scripts/runtime/cli/browser-history-purge (--target chrome); the
wrapper resolves Windows paths and enumerates chrome.exe command lines.

Dry-run (default) copies History / Shortcuts / Top Sites to a temp dir and
counts on the copies, so it is safe while Chrome runs. --apply refuses while
any chrome.exe occupies the target User Data dir, backs the three files up to
*.bak-<stamp>, deletes, then runs integrity_check + orphan-visits checks.

Hostnames match exactly (a.example.com does not match example.com or
b.a.example.com).

Scope:
  History    urls / visits plus keyword / segment / annotation side tables
  Shortcuts  omni_box_shortcuts (typed-fragment -> URL suggestions)
  Top Sites  top_sites (new-tab tiles)
"""

import argparse
import datetime
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import urllib.parse

EXIT_REFUSED = 3


def host_of(url):
    try:
        return (urllib.parse.urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def parse_domains(items):
    out = set()
    for item in items:
        for part in item.split(","):
            d = part.strip().lower()
            if d and not d.startswith("#"):
                out.add(d)
    return out


def read_domains_file(path):
    items = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.split("#", 1)[0].strip()
            if line:
                items.append(line)
    return items


# ── occupancy detection ──────────────────────────────────────────────


def _norm_path(p):
    p = p.strip().strip('"').strip().replace("\\", "/").rstrip("/")
    m = re.match(r"^([A-Za-z]):/(.*)$", p)
    if m:
        p = f"/mnt/{m.group(1).lower()}/{m.group(2)}"
    return p.casefold()


def user_data_dir_arg(cmdline):
    """Return the --user-data-dir value from a chrome.exe command line, or None.

    Handles `--user-data-dir=X`, `--user-data-dir="X Y"`, and `"--user-data-dir=X Y"`.
    """
    idx = cmdline.find("--user-data-dir=")
    if idx < 0:
        return None
    rest = cmdline[idx + len("--user-data-dir="):]
    whole_quoted = idx > 0 and cmdline[idx - 1] == '"'
    if rest.startswith('"'):
        end = rest.find('"', 1)
        return rest[1:end] if end > 0 else rest[1:]
    if whole_quoted:
        end = rest.find('"')
        return rest[:end] if end >= 0 else rest
    m = re.search(r"\s--", rest)
    return (rest[: m.start()] if m else rest).strip()


def split_pid(line):
    """`PID<TAB>cmdline` (wrapper format) -> (pid, cmdline); bare cmdline -> (None, cmdline)."""
    m = re.match(r"^\s*(\d+)\t(.*)$", line)
    if m:
        return int(m.group(1)), m.group(2).strip()
    return None, line.strip()


def exe_of(cmdline):
    if cmdline.startswith('"'):
        end = cmdline.find('"', 1)
        return cmdline[1:end] if end > 0 else cmdline[1:]
    return cmdline.split(" ", 1)[0]


def occupying_processes(cmdlines, target_user_data, default_user_data):
    """Lines (as given, PID prefix kept) of chrome.exe processes holding target_user_data.

    A process without --user-data-dir uses Chrome's default User Data, so it only
    counts when the target is that default. WezDeck's debug Chrome passes its own
    --user-data-dir and is therefore ignored unless it points at the target.
    """
    target = _norm_path(target_user_data)
    is_default = default_user_data is not None and _norm_path(default_user_data) == target
    hits = []
    for raw in cmdlines:
        _, line = split_pid(raw)
        if not line:
            continue
        udd = user_data_dir_arg(line)
        if udd is None:
            if is_default:
                hits.append(raw.strip())
        elif _norm_path(udd) == target:
            hits.append(raw.strip())
    return hits


def print_occupying(cmdlines, user_data, default_user_data, out=sys.stdout):
    """For the wrapper's --stop: `PID<TAB>main|child<TAB>exe<TAB>user-data-dir` per holder.

    main = browser process (no --type=); it gets the graceful close + restart.
    """
    for raw in occupying_processes(cmdlines, user_data, default_user_data):
        pid, line = split_pid(raw)
        if pid is None:
            continue
        role = "child" if "--type=" in line else "main"
        print(f"{pid}\t{role}\t{exe_of(line)}\t{user_data_dir_arg(line) or ''}", file=out)


# ── SQLite purge ─────────────────────────────────────────────────────


def _tables(conn):
    return {r[0] for r in conn.execute("select name from sqlite_master where type='table'")}


def _columns(conn, table):
    return {r[1] for r in conn.execute(f"pragma table_info({table})")}


def _in(ids):
    return ",".join(str(int(i)) for i in ids) or "NULL"


def purge_history(path, domains, apply):
    conn = sqlite3.connect(path)
    try:
        have = _tables(conn)
        url_ids, per_domain = [], {}
        for i, u in conn.execute("select id, url from urls"):
            h = host_of(u)
            if h in domains:
                url_ids.append(i)
                per_domain[h] = per_domain.get(h, 0) + 1
        counts = {"urls": len(url_ids), "visits": 0, "per_domain": per_domain}
        if not url_ids:
            return counts
        u = _in(url_ids)
        visit_ids = [r[0] for r in conn.execute(f"select id from visits where url in ({u})")]
        counts["visits"] = len(visit_ids)
        if not apply:
            return counts
        v = _in(visit_ids)
        for table in ("visit_source", "content_annotations", "context_annotations", "clusters_and_visits"):
            if table not in have:
                continue
            col = "visit_id" if "visit_id" in _columns(conn, table) else "id"
            conn.execute(f"delete from {table} where {col} in ({v})")
        conn.execute(f"delete from visits where url in ({u})")
        if "keyword_search_terms" in have:
            conn.execute(f"delete from keyword_search_terms where url_id in ({u})")
        if "segments" in have:
            seg = _in(r[0] for r in conn.execute(f"select id from segments where url_id in ({u})"))
            if "segment_usage" in have:
                conn.execute(f"delete from segment_usage where segment_id in ({seg})")
            conn.execute(f"delete from segments where id in ({seg})")
        conn.execute(f"delete from urls where id in ({u})")
        conn.commit()
        conn.execute("vacuum")
        return counts
    finally:
        conn.close()


def purge_simple(path, table, domains, apply):
    if not os.path.isfile(path):
        return 0
    conn = sqlite3.connect(path)
    try:
        if table not in _tables(conn):
            return 0
        rows = [r for r, url in conn.execute(f"select rowid, url from {table}") if host_of(url) in domains]
        if apply and rows:
            conn.execute(f"delete from {table} where rowid in ({_in(rows)})")
            conn.commit()
        return len(rows)
    finally:
        conn.close()


def verify_history(path, domains):
    conn = sqlite3.connect(path)
    try:
        integrity = conn.execute("pragma integrity_check").fetchone()[0]
        orphans = conn.execute(
            "select count(*) from visits where url not in (select id from urls)"
        ).fetchone()[0]
        remaining = sum(1 for (u,) in conn.execute("select url from urls") if host_of(u) in domains)
        return {"integrity": integrity, "orphan_visits": orphans, "remaining_urls": remaining}
    finally:
        conn.close()


FILES = ("History", "Shortcuts", "Top Sites")


def run(profile, domains, apply, cmdlines, default_user_data, out=sys.stdout):
    files = {name: os.path.join(profile, name) for name in FILES}
    if not os.path.isfile(files["History"]):
        raise SystemExit(f"找不到 {files['History']}；用 --profile 指定含 History 的 profile 目录")
    result = {"target": "chrome", "profile": profile, "mode": "apply" if apply else "dry-run"}

    if apply:
        user_data = os.path.dirname(profile.rstrip("/"))
        if cmdlines is None:
            result.update(ok=False, refused="process-list-unavailable")
            print("无法枚举 chrome.exe 进程（PowerShell 不可用），为安全起见不执行", file=sys.stderr)
            return result, EXIT_REFUSED
        hits = occupying_processes(cmdlines, user_data, default_user_data)
        if hits:
            result.update(ok=False, refused="chrome-running", occupying=len(hits))
            print(
                f"有 {len(hits)} 个 chrome.exe 正在使用 {user_data}。请完全退出 Chrome"
                "（含托盘后台）后重试；WezDeck 调试 Chrome 用独立 --user-data-dir，不受影响",
                file=sys.stderr,
            )
            return result, EXIT_REFUSED
        if os.path.exists(os.path.join(user_data, "lockfile")):
            result.update(ok=False, refused="lockfile")
            print(
                f"{user_data}/lockfile 存在，Chrome 可能仍在运行。确认 Chrome 已完全退出后，"
                "该文件是上次异常退出留下的，可手动删除再重试",
                file=sys.stderr,
            )
            return result, EXIT_REFUSED
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        for path in files.values():
            if os.path.isfile(path):
                shutil.copy2(path, f"{path}.bak-{stamp}")
        result["backup_suffix"] = f".bak-{stamp}"
        work = files
        tmp = None
    else:
        tmp = tempfile.mkdtemp(prefix="browser-history-purge.")
        work = {}
        for name, path in files.items():
            if os.path.isfile(path):
                dst = os.path.join(tmp, name)
                shutil.copy2(path, dst)
                work[name] = dst
            else:
                work[name] = os.path.join(tmp, name)

    try:
        hist = purge_history(work["History"], domains, apply)
        shortcuts = purge_simple(work["Shortcuts"], "omni_box_shortcuts", domains, apply)
        top = purge_simple(work["Top Sites"], "top_sites", domains, apply)
        result.update(urls=hist["urls"], visits=hist["visits"], shortcuts=shortcuts, top_sites=top,
                      per_domain=hist["per_domain"])
        ok = True
        if apply:
            check = verify_history(work["History"], domains)
            result["verify"] = check
            ok = check["integrity"] == "ok" and check["orphan_visits"] == 0 and check["remaining_urls"] == 0
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)

    result["ok"] = ok
    verb = "已删除" if apply else "将删除（dry-run，加 --apply 执行）"
    print(f"profile: {profile}", file=out)
    for d in sorted(domains):
        print(f"  {d}: {hist['per_domain'].get(d, 0)} 网址", file=out)
    print(
        f"{verb}：历史网址 {hist['urls']} 条 / 访问记录 {hist['visits']} 条 / "
        f"地址栏快捷建议 {shortcuts} 条 / 常用网站 {top} 条",
        file=out,
    )
    if apply:
        v = result["verify"]
        print(
            f"校验：integrity_check={v['integrity']} 孤立 visits={v['orphan_visits']} "
            f"残留网址={v['remaining_urls']}；备份后缀 {result['backup_suffix']}",
            file=out,
        )
    return result, 0 if ok else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--profile", required=True, help="Chrome profile dir (contains History), WSL path")
    ap.add_argument("--domains", action="append", default=[], help="comma-separated hostnames (repeatable)")
    ap.add_argument("--domains-file", action="append", default=[], help="one hostname per line; # comments")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--process-cmdlines-file", help="chrome.exe command lines, one per line (from the wrapper)")
    ap.add_argument("--default-user-data", help="Chrome's default User Data dir, WSL path")
    ap.add_argument("--result-json", help="write the machine-readable result here")
    ap.add_argument("--print-occupying", action="store_true",
                    help="only list processes holding the profile's User Data (for --stop), then exit")
    args = ap.parse_args(argv)

    if args.print_occupying:
        with open(args.process_cmdlines_file or os.devnull, encoding="utf-8", errors="replace") as fh:
            print_occupying(fh.read().splitlines(), os.path.dirname(args.profile.rstrip("/")),
                            args.default_user_data)
        return 0

    items = list(args.domains)
    for f in args.domains_file:
        items += read_domains_file(f)
    domains = parse_domains(items)
    if not domains:
        ap.error("没有域名：用 --domains 或 --domains-file 指定")

    cmdlines = None
    if args.process_cmdlines_file:
        with open(args.process_cmdlines_file, encoding="utf-8", errors="replace") as fh:
            cmdlines = fh.read().splitlines()

    result, code = run(args.profile, domains, args.apply, cmdlines, args.default_user_data)
    result["domains"] = len(domains)
    if args.result_json:
        with open(args.result_json, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False)
    return code


if __name__ == "__main__":
    sys.exit(main())
