#!/usr/bin/env python3
"""Delete hostnames from a Chromium-family profile's history and omnibox suggestions.

Invoked by scripts/runtime/cli/browser-history-purge for --target
chrome|edge|brave (and each leg of --target chromium). The wrapper resolves
Windows paths and enumerates that browser's process command lines
(browsers.tsv).

Dry-run (default) copies History / Shortcuts / Top Sites to a temp dir and
counts on the copies, so it is safe while the browser runs. --apply refuses
while any matching process occupies the target User Data dir, backs the three
files up to *.bak-<stamp>, deletes, then runs integrity_check + orphan-visits
checks.

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


def exe_basename(cmdline):
    return os.path.basename(exe_of(cmdline).replace("\\", "/")).casefold()


def occupying_processes(cmdlines, target_user_data, default_user_data, process_names=None):
    """Lines (as given, PID prefix kept) of browser processes holding target_user_data.

    A process without --user-data-dir uses that browser's default User Data, so it
    only counts when the target is that default. WezDeck's debug Chrome passes its
    own --user-data-dir and is therefore ignored unless it points at the target.

    process_names: optional iterable of exe basenames (e.g. chrome.exe). When set,
    lines whose exe is outside the set are ignored — so a shared cmdlines dump
    cannot make Edge look occupied by Chrome.
    """
    target = _norm_path(target_user_data)
    is_default = default_user_data is not None and _norm_path(default_user_data) == target
    allowed = {n.casefold() for n in process_names} if process_names else None
    hits = []
    for raw in cmdlines:
        _, line = split_pid(raw)
        if not line:
            continue
        if allowed is not None and exe_basename(line) not in allowed:
            continue
        udd = user_data_dir_arg(line)
        if udd is None:
            if is_default:
                hits.append(raw.strip())
        elif _norm_path(udd) == target:
            hits.append(raw.strip())
    return hits


def print_occupying(cmdlines, user_data, default_user_data, out=sys.stdout, process_names=None):
    """For the wrapper's --stop: `PID<TAB>main|child<TAB>exe<TAB>user-data-dir` per holder.

    main = browser process (no --type=); it gets the graceful close + restart.
    """
    for raw in occupying_processes(cmdlines, user_data, default_user_data, process_names):
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
BAK_DIR_NAME = ".history-purge-bak"


def backup_dir(profile):
    return os.path.join(profile, BAK_DIR_NAME)


def list_backup_stamps(profile):
    """Return sorted stamp ids (oldest first) for legacy sidecars and bak dirs."""
    stamps = set()
    for name in FILES:
        prefix = f"{name}.bak-"
        try:
            for ent in os.listdir(profile):
                if ent.startswith(prefix):
                    stamps.add(ent[len(prefix):])
        except FileNotFoundError:
            pass
    bdir = backup_dir(profile)
    if os.path.isdir(bdir):
        for ent in os.listdir(bdir):
            if os.path.isdir(os.path.join(bdir, ent)) and not ent.startswith("."):
                stamps.add(ent)
    return sorted(stamps)


def _remove_stamp(profile, stamp):
    removed = []
    for name in FILES:
        path = os.path.join(profile, f"{name}.bak-{stamp}")
        if os.path.isfile(path):
            os.remove(path)
            removed.append(path)
    stamp_dir = os.path.join(backup_dir(profile), stamp)
    if os.path.isdir(stamp_dir):
        shutil.rmtree(stamp_dir)
        removed.append(stamp_dir)
    return removed


def recycle_backups(profile, keep, out=sys.stdout):
    """Keep the newest `keep` backup stamps; delete older (and all if keep<=0)."""
    stamps = list_backup_stamps(profile)
    if keep < 0:
        keep = 0
    to_delete = stamps if keep == 0 else stamps[:-keep] if len(stamps) > keep else []
    removed = []
    for stamp in to_delete:
        removed.extend(_remove_stamp(profile, stamp))
    # Drop empty bak root
    bdir = backup_dir(profile)
    if os.path.isdir(bdir) and not os.listdir(bdir):
        os.rmdir(bdir)
    kept = list_backup_stamps(profile)
    result = {
        "recycled": len(to_delete),
        "removed_paths": len(removed),
        "kept": kept,
        "keep": keep,
    }
    print(
        f"备份回收：删除 {len(to_delete)} 组，保留 {len(kept)} 组"
        + (f"（{', '.join(kept)}）" if kept else "")
        + f"；policy keep={keep}",
        file=out,
    )
    return result


def write_backup(profile, stamp, files):
    """Copy live DB files into profile/.history-purge-bak/<stamp>/."""
    dest_root = os.path.join(backup_dir(profile), stamp)
    os.makedirs(dest_root, exist_ok=True)
    written = []
    for name, path in files.items():
        if os.path.isfile(path):
            dst = os.path.join(dest_root, name)
            shutil.copy2(path, dst)
            written.append(dst)
    return dest_root, written


def run(profile, domains, apply, cmdlines, default_user_data, out=sys.stdout,
        browser_id="chrome", label="Chrome", process_names=None, backup_keep=1):
    files = {name: os.path.join(profile, name) for name in FILES}
    if not os.path.isfile(files["History"]):
        raise SystemExit(f"找不到 {files['History']}；用 --profile 指定含 History 的 profile 目录")
    result = {"target": browser_id, "profile": profile, "mode": "apply" if apply else "dry-run"}
    names = list(process_names) if process_names else None

    if apply:
        user_data = os.path.dirname(profile.rstrip("/"))
        if cmdlines is None:
            result.update(ok=False, refused="process-list-unavailable")
            print(f"无法枚举 {label} 进程（PowerShell 不可用），为安全起见不执行", file=sys.stderr)
            return result, EXIT_REFUSED
        hits = occupying_processes(cmdlines, user_data, default_user_data, names)
        if hits:
            result.update(ok=False, refused="browser-running", occupying=len(hits))
            hint = "请加 --stop，或完全退出后重试"
            if browser_id != "chrome-debug":
                hint += "；WezDeck 调试 Chrome（独立 --user-data-dir）不挡日常浏览器清理"
            print(
                f"有 {len(hits)} 个进程正在使用 {user_data}。{hint}",
                file=sys.stderr,
            )
            return result, EXIT_REFUSED
        if os.path.exists(os.path.join(user_data, "lockfile")):
            result.update(ok=False, refused="lockfile")
            print(
                f"{user_data}/lockfile 存在，{label} 可能仍在运行。确认已完全退出后，"
                "该文件是上次异常退出留下的，可手动删除再重试；或加 --stop",
                file=sys.stderr,
            )
            return result, EXIT_REFUSED
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        bak_root, _ = write_backup(profile, stamp, files)
        result["backup_dir"] = bak_root
        result["backup_stamp"] = stamp
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
            if ok:
                recycled = recycle_backups(profile, backup_keep, out=out)
                result["backup_recycle"] = {
                    "recycled": recycled["recycled"],
                    "kept": recycled["kept"],
                    "keep": backup_keep,
                }
            else:
                print(
                    f"校验失败，保留全部备份（含本次 {result.get('backup_stamp')}）便于回滚",
                    file=out,
                )
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
        bak = result.get("backup_dir", "")
        print(
            f"校验：integrity_check={v['integrity']} 孤立 visits={v['orphan_visits']} "
            f"残留网址={v['remaining_urls']}；备份 {bak}",
            file=out,
        )
    return result, 0 if ok else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--profile", required=True, help="profile dir (contains History), WSL path")
    ap.add_argument("--domains", action="append", default=[], help="comma-separated hostnames (repeatable)")
    ap.add_argument("--domains-file", action="append", default=[], help="one hostname per line; # comments")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--process-cmdlines-file",
                    help="browser process command lines, one per line (from the wrapper)")
    ap.add_argument("--default-user-data", help="that browser's default User Data dir, WSL path")
    ap.add_argument("--browser-id", default="chrome", help="id written into result JSON (chrome|edge|brave)")
    ap.add_argument("--label", default="Chrome", help="human label for refuse messages")
    ap.add_argument("--process-names", default="",
                    help="comma-separated exe basenames to treat as this browser (chrome.exe,…)")
    ap.add_argument("--backup-keep", type=int, default=1,
                    help="after successful apply, keep this many newest backup stamps (0=delete all)")
    ap.add_argument("--recycle-backups", action="store_true",
                    help="only apply backup retention on --profile; no history delete")
    ap.add_argument("--result-json", help="write the machine-readable result here")
    ap.add_argument("--print-occupying", action="store_true",
                    help="only list processes holding the profile's User Data (for --stop), then exit")
    args = ap.parse_args(argv)
    proc_names = [n.strip() for n in args.process_names.split(",") if n.strip()] or None
    default_udd = args.default_user_data or None

    if args.print_occupying:
        with open(args.process_cmdlines_file or os.devnull, encoding="utf-8", errors="replace") as fh:
            print_occupying(fh.read().splitlines(), os.path.dirname(args.profile.rstrip("/")),
                            default_udd, process_names=proc_names)
        return 0

    if args.recycle_backups:
        recycled = recycle_backups(args.profile, args.backup_keep)
        result = {
            "target": args.browser_id, "profile": args.profile, "mode": "recycle-backups",
            "ok": True, **{k: recycled[k] for k in ("recycled", "kept", "keep")},
            "removed_paths": recycled["removed_paths"],
        }
        if args.result_json:
            with open(args.result_json, "w", encoding="utf-8") as fh:
                json.dump(result, fh, ensure_ascii=False)
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

    result, code = run(
        args.profile, domains, args.apply, cmdlines, default_udd,
        browser_id=args.browser_id, label=args.label, process_names=proc_names,
        backup_keep=args.backup_keep,
    )
    result["domains"] = len(domains)
    if args.result_json:
        with open(args.result_json, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False)
    return code


if __name__ == "__main__":
    sys.exit(main())
