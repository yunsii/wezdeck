#!/usr/bin/env bash
# Unit tests for scripts/runtime/cli/browser-history-purge and
# scripts/runtime/browser-history/chrome_purge.py. Hermetic: temp SQLite
# fixtures, injected browser process command lines, stubbed ego-browser.
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cli="$repo_root/scripts/runtime/cli/browser-history-purge"
impl="$repo_root/scripts/runtime/browser-history"
browsers_tsv="$impl/browsers.tsv"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  PASS  %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; [[ -n "${2-}" ]] && printf '    %s\n' "$2"; }
assert_eq() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "got=[$2] want=[$3]"; fi; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export WEZTERM_RUNTIME_LOG_FILE="$tmp/runtime.log"
export WEZTERM_RUNTIME_LOG_ENABLED=1
export WEZTERM_RUNTIME_LOG_LEVEL=info
export WEZTERM_RUNTIME_LOG_CATEGORIES=""

make_profile() {
  local ud="$1"
  mkdir -p "$ud/Default"
  python3 -I - "$ud/Default" <<'PY'
import sqlite3, sys, os
p = sys.argv[1]
h = sqlite3.connect(os.path.join(p, "History"))
h.executescript("""
create table urls(id integer primary key, url text);
create table visits(id integer primary key, url integer);
create table visit_source(id integer primary key, source integer);
create table keyword_search_terms(keyword_id integer, url_id integer, term text);
create table segments(id integer primary key, name text, url_id integer);
create table segment_usage(id integer primary key, segment_id integer);
""")
urls = [
    (1, "https://coco.pollodev.com/a"),
    (2, "https://coco.pollodev.com/b?x=1"),
    (3, "https://pollodev.com/"),                 # parent: keep
    (4, "https://test-sub2api.pollodev.com/"),    # sibling: keep
    (5, "https://x.coco.pollodev.com/"),          # child: keep
    (6, "https://COCO.pollodev.com:8443/c"),      # case/port: delete
    (7, "https://internal-jl.com/coco"),          # keep
]
h.executemany("insert into urls values(?,?)", urls)
visits = [(10, 1), (11, 1), (12, 2), (13, 3), (14, 4), (15, 6), (16, 7)]
h.executemany("insert into visits values(?,?)", visits)
h.executemany("insert into visit_source values(?,?)", [(10, 0), (13, 0)])
h.executemany("insert into keyword_search_terms values(?,?,?)", [(1, 1, "coco"), (1, 7, "coco")])
h.executemany("insert into segments values(?,?,?)", [(100, "coco", 1), (101, "jl", 7)])
h.executemany("insert into segment_usage values(?,?)", [(1, 100), (2, 101)])
h.commit(); h.close()
s = sqlite3.connect(os.path.join(p, "Shortcuts"))
s.execute("create table omni_box_shortcuts(id text, text text, url text)")
s.executemany("insert into omni_box_shortcuts values(?,?,?)",
              [("a", "co", "https://coco.pollodev.com/"), ("b", "co", "https://internal-jl.com/coco"),
               ("c", "pd", "https://pollodev.com/")])
s.commit(); s.close()
t = sqlite3.connect(os.path.join(p, "Top Sites"))
t.execute("create table top_sites(url text, url_rank integer, title text)")
t.executemany("insert into top_sites values(?,?,?)",
              [("https://coco.pollodev.com/", 0, "c"), ("https://internal-jl.com/", 1, "j")])
t.commit(); t.close()
PY
}

q() { python3 -I -c 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchone()[0])' "$1" "$2"; }

ud="$tmp/User Data"
make_profile "$ud"
prof="$ud/Default"
export BROWSER_HISTORY_PURGE_DEFAULT_USER_DATA="$ud"

echo "== usage"
"$cli" --domains a.com >/dev/null 2>&1; assert_eq "missing --target exits 2" "$?" 2
"$cli" --target cdp --domains a.com >/dev/null 2>&1; assert_eq "bad --target exits 2" "$?" 2
"$cli" --target chrome >/dev/null 2>&1; assert_eq "no domains exits 2" "$?" 2
"$cli" --target chrome --domains 'a.com;rm' >/dev/null 2>&1; assert_eq "non-hostname rejected" "$?" 2

echo "== dry-run leaves files untouched"
before="$(md5sum "$prof/History" | cut -d' ' -f1)"
out="$("$cli" --target chrome --domains coco.pollodev.com 2>&1)"; rc=$?
assert_eq "dry-run exit 0" "$rc" 0
assert_eq "dry-run History unchanged" "$(md5sum "$prof/History" | cut -d' ' -f1)" "$before"
grep -q '历史网址 3 条 / 访问记录 4 条 / 地址栏快捷建议 1 条 / 常用网站 1 条' <<<"$out" \
  && ok "dry-run counts" || bad "dry-run counts" "$out"
ls "$prof"/*.bak-* >/dev/null 2>&1 && bad "dry-run made no backup" || ok "dry-run made no backup"

echo "== apply refused when everyday Chrome holds the profile"
cat > "$tmp/procs-daily.txt" <<'EOF'
"C:\Program Files\Google\Chrome\Application\chrome.exe" --type=renderer --lang=zh-CN
"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir=E:\chrome-profiles\ai --remote-debugging-port=9222 --headless
EOF
BROWSER_HISTORY_PURGE_CMDLINES_FILE="$tmp/procs-daily.txt" "$cli" --target chrome --domains coco.pollodev.com --apply >/dev/null 2>&1
assert_eq "daily chrome running → exit 3" "$?" 3
assert_eq "refused: History unchanged" "$(md5sum "$prof/History" | cut -d' ' -f1)" "$before"

echo "== apply refused while lockfile exists"
: > "$tmp/procs-none.txt"
touch "$ud/lockfile"
BROWSER_HISTORY_PURGE_CMDLINES_FILE="$tmp/procs-none.txt" "$cli" --target chrome --domains coco.pollodev.com --apply >/dev/null 2>&1
assert_eq "lockfile → exit 3" "$?" 3
rm -f "$ud/lockfile"

echo "== apply allowed while only WezDeck debug Chrome runs"
cat > "$tmp/procs-debug.txt" <<'EOF'
"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir=E:\chrome-profiles\ai --remote-debugging-port=9222 --headless
"C:\Program Files\Google\Chrome\Application\chrome.exe" --type=renderer --user-data-dir="E:\chrome-profiles\ai" --lang=zh-CN

EOF
printf 'coco.pollodev.com # old\n\n# comment\n' > "$tmp/domains.txt"
out="$(BROWSER_HISTORY_PURGE_CMDLINES_FILE="$tmp/procs-debug.txt" "$cli" --target chrome --domains-file "$tmp/domains.txt" --apply 2>&1)"; rc=$?
assert_eq "apply exit 0" "$rc" 0
grep -q 'integrity_check=ok 孤立 visits=0 残留网址=0' <<<"$out" && ok "apply verify line" || bad "apply verify line" "$out"
assert_eq "deleted target urls" "$(q "$prof/History" "select group_concat(id) from (select id from urls order by id)")" "3,4,5,7"
assert_eq "visits kept" "$(q "$prof/History" "select group_concat(id) from (select id from visits order by id)")" "13,14,16"
assert_eq "visit_source cleaned" "$(q "$prof/History" "select group_concat(id) from visit_source")" "13"
assert_eq "keyword terms cleaned" "$(q "$prof/History" "select group_concat(url_id) from keyword_search_terms")" "7"
assert_eq "segments cleaned" "$(q "$prof/History" "select group_concat(id) from segments")" "101"
assert_eq "segment_usage cleaned" "$(q "$prof/History" "select group_concat(segment_id) from segment_usage")" "101"
assert_eq "shortcuts kept others" "$(q "$prof/Shortcuts" "select group_concat(id) from omni_box_shortcuts")" "b,c"
assert_eq "top sites kept others" "$(q "$prof/Top Sites" "select group_concat(url) from top_sites")" "https://internal-jl.com/"
bak_stamp_dir="$(ls -d "$prof"/.history-purge-bak/* 2>/dev/null | head -n1)"
[[ -n "$bak_stamp_dir" && -f "$bak_stamp_dir/History" ]] && ok "backup dir has History" || bad "backup dir has History" "$bak_stamp_dir"
assert_eq "backup has old rows" "$(q "$bak_stamp_dir/History" "select count(*) from urls")" 7
ls "$prof"/*.bak-* >/dev/null 2>&1 && bad "no legacy sidecar bak" || ok "no legacy sidecar bak"
grep -q 'category="browser_agent".*browser-history-purge completed.*target="chrome" mode="apply".*ok="true"' "$WEZTERM_RUNTIME_LOG_FILE" \
  && ok "runtime_log browser_agent row" || bad "runtime_log browser_agent row" "$(cat "$WEZTERM_RUNTIME_LOG_FILE" 2>/dev/null)"
grep -q 'urls="3" visits="4"' "$WEZTERM_RUNTIME_LOG_FILE" && ok "log carries counts" || bad "log carries counts"

echo "== occupancy parser"
python3 -I - "$impl" <<'PY' && ok "occupying_processes cases" || bad "occupying_processes cases"
import sys
sys.path.insert(0, sys.argv[1])
from chrome_purge import occupying_processes as occ, user_data_dir_arg as udd
D = "/mnt/c/Users/u/AppData/Local/Google/Chrome/User Data"
exe = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'
assert udd(exe + ' --user-data-dir="C:\\a b\\User Data" --x') == "C:\\a b\\User Data"
assert udd(exe + ' "--user-data-dir=C:\\a b\\User Data" --x') == "C:\\a b\\User Data"
assert udd(exe + ' --user-data-dir=E:\\p\\ai --x') == "E:\\p\\ai"
assert udd(exe + ' --type=gpu') is None
# no --user-data-dir → default profile in use
assert occ([exe + " --type=renderer"], D, D)
# debug Chrome only → free
assert not occ([exe + " --user-data-dir=E:\\chrome-profiles\\ai"], D, D)
# explicit default path, quoted, different case, trailing slash → in use
assert occ([exe + ' "--user-data-dir=C:\\Users\\U\\AppData\\Local\\Google\\Chrome\\User Data\\"'], D, D)
# custom target: no-flag processes do not hold it
assert not occ([exe], "/mnt/e/chrome-profiles/other", D)
assert occ([exe + " --user-data-dir=E:\\chrome-profiles\\other"], "/mnt/e/chrome-profiles/other", D)
PY

echo "== --stop usage"
"$cli" --target chrome --domains a.com --stop >/dev/null 2>&1; assert_eq "--stop without --apply exits 2" "$?" 2
"$cli" --target ego --domains a.com --apply --stop >/dev/null 2>&1; assert_eq "--stop with ego exits 2" "$?" 2
"$cli" --target chrome --domains a.com --apply --no-restart >/dev/null 2>&1; assert_eq "--no-restart without --stop exits 2" "$?" 2

echo "== --stop: close holders, purge, reopen"
# Stateful PowerShell stub: enumerates $PS_STATE, applies taskkill per $PS_MODE.
cat > "$tmp/ps-stub" <<'EOF'
#!/usr/bin/env bash
cmd="$1"
printf '%s\n' "$cmd" >> "${PS_LOG:?}"
case "$cmd" in
  Get-CimInstance*) cat "${PS_STATE:?}" ;;
  taskkill.exe*)
    pids="$(grep -o '/PID [0-9]*' <<<"$cmd" | cut -d' ' -f2)"
    forced=0; [[ "$cmd" == *" /F"* ]] && forced=1
    case "$PS_MODE" in
      stuck) ;;
      graceful) for p in $pids; do [[ "$p" == 100 ]] && sed -i '/^10[0-9]\t/d' "$PS_STATE"; done ;;
      stubborn)  # browser exits, background children survive until /F
        for p in $pids; do
          if [[ "$forced" == 1 || "$p" == 100 ]]; then sed -i "/^$p\t/d" "$PS_STATE"; fi
        done ;;
    esac ;;
  Start-Process*) ;;
esac
EOF
chmod +x "$tmp/ps-stub"
exe='"C:\Program Files\Google\Chrome\Application\chrome.exe"'
write_state() {
  printf '100\t%s --restore-last-session\n101\t%s --type=renderer --lang=zh-CN\n102\t%s --type=gpu-process\n200\t%s --user-data-dir=E:\\chrome-profiles\\ai --remote-debugging-port=9222\n201\t%s --type=renderer --user-data-dir=E:\\chrome-profiles\\ai\n' \
    "$exe" "$exe" "$exe" "$exe" "$exe" > "$PS_STATE"
}
stop_case() {  # name mode extra-args...
  local name="$1" mode="$2"; shift 2
  local u="$tmp/stop-$name/User Data"
  make_profile "$u"
  export PS_STATE="$tmp/stop-$name.state" PS_LOG="$tmp/stop-$name.log" PS_MODE="$mode"
  : > "$PS_LOG"; write_state
  out="$(BROWSER_HISTORY_PURGE_DEFAULT_USER_DATA="$u" BROWSER_HISTORY_PURGE_POWERSHELL="$tmp/ps-stub" \
    BROWSER_HISTORY_PURGE_STOP_WAIT=2 BROWSER_HISTORY_PURGE_FORCE_WAIT=2 BROWSER_HISTORY_PURGE_LOCK_WAIT=1 \
    BROWSER_HISTORY_PURGE_POLL_SECONDS=0.05 \
    "$cli" --target chrome --domains coco.pollodev.com --apply --stop "$@" 2>&1)"
  rc=$?
  urls_left="$(q "$u/Default/History" "select count(*) from urls")"
}

stop_case graceful graceful
assert_eq "graceful: exit 0" "$rc" 0
assert_eq "graceful: purged" "$urls_left" 4
assert_eq "graceful: closes only the browser process" "$(grep '^taskkill' "$PS_LOG")" "taskkill.exe /PID 100"
grep -q '/PID 20[01]' "$PS_LOG" && bad "graceful: debug Chrome untouched" || ok "graceful: debug Chrome untouched"
grep -q "^Start-Process -FilePath 'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe' -ArgumentList '--restore-last-session'$" "$PS_LOG" \
  && ok "graceful: reopened with --restore-last-session" || bad "graceful: reopened with --restore-last-session" "$(cat "$PS_LOG")"
grep -q 'browser-history-purge completed.*stopped="3" forced="0" restarted="1"' "$WEZTERM_RUNTIME_LOG_FILE" \
  && ok "graceful: log stopped/forced/restarted" || bad "graceful: log stopped/forced/restarted" "$(tail -n1 "$WEZTERM_RUNTIME_LOG_FILE")"

stop_case stubborn stubborn
assert_eq "stubborn: exit 0" "$rc" 0
assert_eq "stubborn: purged" "$urls_left" 4
assert_eq "stubborn: force-kills only remaining holders" "$(grep '/F' "$PS_LOG")" "taskkill.exe /F /PID 101 /PID 102"
grep -q '强制结束剩余 2 个进程' <<<"$out" && ok "stubborn: reports forced kill" || bad "stubborn: reports forced kill" "$out"
grep -q '^Start-Process' "$PS_LOG" && ok "stubborn: reopened" || bad "stubborn: reopened"

stop_case stuck stuck
assert_eq "stuck: exit 3" "$rc" 3
assert_eq "stuck: nothing deleted" "$urls_left" 7
ls -d "$tmp/stop-stuck/User Data/Default/.history-purge-bak"/*/ >/dev/null 2>&1 && bad "stuck: no backup" || ok "stuck: no backup"
grep -q '^Start-Process' "$PS_LOG" && bad "stuck: no restart" || ok "stuck: no restart"
grep -q 'browser-history-purge failed.*refused="stop-failed"' "$WEZTERM_RUNTIME_LOG_FILE" \
  && ok "stuck: log refused=stop-failed" || bad "stuck: log refused=stop-failed" "$(tail -n1 "$WEZTERM_RUNTIME_LOG_FILE")"

stop_case norestart graceful --no-restart
assert_eq "--no-restart: exit 0" "$rc" 0
grep -q '^Start-Process' "$PS_LOG" && bad "--no-restart: not reopened" || ok "--no-restart: not reopened"

# Only debug Chrome running: nothing to stop, nothing to reopen.
u="$tmp/stop-idle/User Data"; make_profile "$u"
export PS_STATE="$tmp/stop-idle.state" PS_LOG="$tmp/stop-idle.log" PS_MODE=graceful
: > "$PS_LOG"; write_state; sed -i '/^10[0-9]\t/d' "$PS_STATE"
BROWSER_HISTORY_PURGE_DEFAULT_USER_DATA="$u" BROWSER_HISTORY_PURGE_POWERSHELL="$tmp/ps-stub" \
  "$cli" --target chrome --domains coco.pollodev.com --apply --stop >/dev/null 2>&1
assert_eq "idle: exit 0" "$?" 0
grep -qE '^(taskkill|Start-Process)' "$PS_LOG" && bad "idle: no kill / restart" || ok "idle: no kill / restart"

echo "== occupancy parser: PID-prefixed lines"
python3 -I - "$impl" <<'PY2' && ok "print_occupying roles" || bad "print_occupying roles"
import io, sys
sys.path.insert(0, sys.argv[1])
from chrome_purge import print_occupying
D = "/mnt/c/Users/u/AppData/Local/Google/Chrome/User Data"
exe = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'
buf = io.StringIO()
print_occupying([f"7\t{exe} --flag", f"8\t{exe} --type=gpu", f"9\t{exe} --user-data-dir=E:\\x", "10\t"], D, D, out=buf)
assert buf.getvalue() == (
    "7\tmain\tC:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\t\n"
    "8\tchild\tC:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\t\n"), buf.getvalue()
PY2

echo "== ego: per-domain process, read-back, timeout"
cat > "$tmp/ego-stub" <<'EOF'
#!/usr/bin/env bash
# args: nodejs -e <script>
script="$3"
dom="$(grep -o 'const DOMAIN = "[^"]*"' <<<"$script" | cut -d'"' -f2)"
mode="$(grep -o 'const MODE = "[^"]*"' <<<"$script" | cut -d'"' -f2)"
echo "$dom" >> "${EGO_STUB_LOG:?}"
case "$dom" in
  slow.example.com) sleep 5 ;;
  left.example.com) echo "BHP_RESULT {\"domain\":\"$dom\",\"mode\":\"$mode\",\"found\":2,\"deleted\":1,\"remaining\":1}" >&2 ;;
  *) echo "noise" >&2; echo "BHP_RESULT {\"domain\":\"$dom\",\"mode\":\"$mode\",\"found\":3,\"deleted\":3,\"remaining\":0}" >&2 ;;
esac
EOF
chmod +x "$tmp/ego-stub"
export BROWSER_HISTORY_PURGE_EGO_BROWSER="$tmp/ego-stub" EGO_STUB_LOG="$tmp/ego.log"
out="$("$cli" --target ego --domains a.example.com,b.example.com --apply 2>&1)"; rc=$?
assert_eq "ego apply ok" "$rc" 0
assert_eq "one process per domain" "$(tr '\n' ' ' < "$tmp/ego.log")" "a.example.com b.example.com "
grep -q 'ego 已删除：6 条；失败域名 0 个' <<<"$out" && ok "ego summary" || bad "ego summary" "$out"
: > "$tmp/ego.log"
out="$("$cli" --target ego --domains left.example.com,slow.example.com,c.example.com --per-domain-timeout 1 --apply 2>&1)"; rc=$?
assert_eq "ego residue/timeout → exit 1" "$rc" 1
grep -q 'slow.example.com: 失败 timeout-1s' <<<"$out" && ok "timeout reported" || bad "timeout reported" "$out"
grep -q '失败域名 2 个：left.example.com,slow.example.com' <<<"$out" && ok "failed domains listed" || bad "failed domains listed" "$out"
grep -q 'c.example.com' "$tmp/ego.log" && ok "continues after timeout" || bad "continues after timeout"
out="$("$cli" --target ego --domains a.example.com 2>&1)"; rc=$?
assert_eq "ego dry-run ok" "$rc" 0
grep -q 'dry-run' <<<"$out" && ok "ego dry-run wording" || bad "ego dry-run wording" "$out"

echo "== template placeholders"
grep -q '__DOMAIN__' "$impl/ego-history-delete.tmpl.mjs" && grep -q '__MODE__' "$impl/ego-history-delete.tmpl.mjs" \
  && ok "template has placeholders" || bad "template has placeholders"

echo "== backup dir + recycle"
make_profile "$tmp/bak-ud"
: > "$tmp/procs-none.txt"
BROWSER_HISTORY_PURGE_DEFAULT_USER_DATA="$tmp/bak-ud" BROWSER_HISTORY_PURGE_CMDLINES_FILE="$tmp/procs-none.txt" \
  "$cli" --target chrome --domains coco.pollodev.com --apply >/dev/null
# Simulate a legacy sidecar + a second stamp dir, then recycle keep=1.
stamp1="$(ls "$tmp/bak-ud/Default/.history-purge-bak")"
cp "$tmp/bak-ud/Default/.history-purge-bak/$stamp1/History" "$tmp/bak-ud/Default/History.bak-20200101-000000"
mkdir -p "$tmp/bak-ud/Default/.history-purge-bak/20200101-000000"
cp "$tmp/bak-ud/Default/.history-purge-bak/$stamp1/History" "$tmp/bak-ud/Default/.history-purge-bak/20200101-000000/History"
out="$(BROWSER_HISTORY_PURGE_DEFAULT_USER_DATA="$tmp/bak-ud" \
  "$cli" --target chrome --recycle-backups --backup-keep 1 2>&1)"; rc=$?
assert_eq "recycle-backups exit 0" "$rc" 0
assert_eq "recycle kept one stamp" "$(ls "$tmp/bak-ud/Default/.history-purge-bak" | wc -l)" 1
[[ ! -f "$tmp/bak-ud/Default/History.bak-20200101-000000" ]] && ok "recycle removed legacy sidecar" \
  || bad "recycle removed legacy sidecar"
grep -q '备份回收：删除' <<<"$out" && ok "recycle reports" || bad "recycle reports" "$out"
BROWSER_HISTORY_PURGE_DEFAULT_USER_DATA="$tmp/bak-ud" \
  "$cli" --target chrome --recycle-backups --backup-keep 0 >/dev/null
[[ ! -d "$tmp/bak-ud/Default/.history-purge-bak" ]] && ok "recycle keep=0 removes bak dir" \
  || bad "recycle keep=0 removes bak dir"

echo "== browsers.tsv + edge / chromium targets"
grep -q $'^chrome\t' "$browsers_tsv" && grep -q $'^edge\t' "$browsers_tsv" && grep -q $'^brave\t' "$browsers_tsv" \
  && ok "browsers.tsv has chrome/edge/brave" || bad "browsers.tsv has chrome/edge/brave"
"$cli" --target chrome-debug --domains a.com >/dev/null 2>&1
# May exit 0 (dry-run) or 2 (no constants in weird env) — at least accepts target
"$cli" --target chrome-debug --recycle-backups --backup-keep 0 >/dev/null 2>&1
assert_eq "chrome-debug target accepted (recycle)" "$?" 0
"$cli" --target edge --domains a.com --profile /tmp --stop >/dev/null 2>&1
assert_eq "--stop without --apply exits 2 (edge)" "$?" 2
"$cli" --target chromium --domains a.com --profile /tmp >/dev/null 2>&1
assert_eq "--profile with chromium exits 2" "$?" 2

# edge reuses the injected DEFAULT_USER_DATA hook (same SQLite schema).
make_profile "$tmp/edge-ud"
before_edge="$(md5sum "$tmp/edge-ud/Default/History" | cut -d' ' -f1)"
out="$(BROWSER_HISTORY_PURGE_DEFAULT_USER_DATA="$tmp/edge-ud" \
  "$cli" --target edge --domains coco.pollodev.com 2>&1)"; rc=$?
assert_eq "edge dry-run exit 0" "$rc" 0
assert_eq "edge dry-run History unchanged" "$(md5sum "$tmp/edge-ud/Default/History" | cut -d' ' -f1)" "$before_edge"
grep -q '历史网址 3 条' <<<"$out" && ok "edge dry-run counts" || bad "edge dry-run counts" "$out"
: > "$tmp/procs-none.txt"
out="$(BROWSER_HISTORY_PURGE_DEFAULT_USER_DATA="$tmp/edge-ud" BROWSER_HISTORY_PURGE_CMDLINES_FILE="$tmp/procs-none.txt" \
  "$cli" --target edge --domains coco.pollodev.com --apply 2>&1)"; rc=$?
assert_eq "edge apply exit 0" "$rc" 0
assert_eq "edge deleted target urls" "$(q "$tmp/edge-ud/Default/History" "select count(*) from urls")" 4
grep -q 'target="edge".*mode="apply".*ok="true"' "$WEZTERM_RUNTIME_LOG_FILE" \
  && ok "edge runtime_log target=edge" || bad "edge runtime_log target=edge" "$(tail -n3 "$WEZTERM_RUNTIME_LOG_FILE")"

# chromium: chrome+edge present under prefix, brave absent → skip brave.
prefix="$tmp/multi"
make_profile "$prefix/chrome/User Data"
make_profile "$prefix/edge/User Data"
# brave: no History
mkdir -p "$prefix/brave/User Data/Default"
out="$(BROWSER_HISTORY_PURGE_USER_DATA_PREFIX="$prefix" BROWSER_HISTORY_PURGE_LOCALAPPDATA="$tmp/empty-local" \
  BROWSER_HISTORY_PURGE_CMDLINES_FILE="$tmp/procs-none.txt" \
  "$cli" --target chromium --domains coco.pollodev.com --apply 2>&1)"; rc=$?
assert_eq "chromium apply exit 0" "$rc" 0
assert_eq "chromium chrome purged" "$(q "$prefix/chrome/User Data/Default/History" "select count(*) from urls")" 4
assert_eq "chromium edge purged" "$(q "$prefix/edge/User Data/Default/History" "select count(*) from urls")" 4
grep -q 'Brave: 未安装或无 History' <<<"$out" && ok "chromium skips brave" || bad "chromium skips brave" "$out"
grep -q 'chromium 汇总' <<<"$out" && ok "chromium summary line" || bad "chromium summary line" "$out"
grep -q 'target="chromium".*ok="true"' "$WEZTERM_RUNTIME_LOG_FILE" \
  && ok "chromium runtime_log" || bad "chromium runtime_log" "$(tail -n3 "$WEZTERM_RUNTIME_LOG_FILE")"
grep -q 'skipped=brave\|skipped="brave"' "$WEZTERM_RUNTIME_LOG_FILE" \
  && ok "chromium log skipped=brave" || bad "chromium log skipped=brave" "$(tail -n3 "$WEZTERM_RUNTIME_LOG_FILE")"

# chromium continues after one stop-failed leg.
stubborn_prefix="$tmp/multi-stop"
make_profile "$stubborn_prefix/chrome/User Data"
make_profile "$stubborn_prefix/edge/User Data"
cat > "$tmp/ps-stub-multi" <<'EOF'
#!/usr/bin/env bash
cmd="$1"
printf '%s\n' "$cmd" >> "${PS_LOG:?}"
case "$cmd" in
  Get-CimInstance*)
    # Only chrome holders; edge has none → chrome stop stuck, edge purges.
    if [[ -f "${PS_CHROME_STATE:-/dev/null}" ]]; then cat "$PS_CHROME_STATE"; fi
    ;;
  taskkill.exe*) ;;  # leave chrome stuck
  Start-Process*) ;;
esac
EOF
chmod +x "$tmp/ps-stub-multi"
exe='"C:\Program Files\Google\Chrome\Application\chrome.exe"'
printf '100\t%s\n101\t%s --type=renderer\n' "$exe" "$exe" > "$tmp/chrome-stuck.state"
export PS_LOG="$tmp/multi-stop.log" PS_CHROME_STATE="$tmp/chrome-stuck.state"
: > "$PS_LOG"
out="$(BROWSER_HISTORY_PURGE_USER_DATA_PREFIX="$stubborn_prefix" BROWSER_HISTORY_PURGE_LOCALAPPDATA="$tmp/empty-local" \
  BROWSER_HISTORY_PURGE_POWERSHELL="$tmp/ps-stub-multi" \
  BROWSER_HISTORY_PURGE_STOP_WAIT=1 BROWSER_HISTORY_PURGE_FORCE_WAIT=1 BROWSER_HISTORY_PURGE_LOCK_WAIT=0 \
  BROWSER_HISTORY_PURGE_POLL_SECONDS=0.05 \
  "$cli" --target chromium --domains coco.pollodev.com --apply --stop --no-restart 2>&1)"; rc=$?
assert_eq "chromium partial stop-fail → non-zero" "$rc" 3
assert_eq "chromium chrome untouched on stop-fail" "$(q "$stubborn_prefix/chrome/User Data/Default/History" "select count(*) from urls")" 7
assert_eq "chromium edge still purged" "$(q "$stubborn_prefix/edge/User Data/Default/History" "select count(*) from urls")" 4
grep -q '失败 chrome' <<<"$out" && ok "chromium reports failed chrome" || bad "chromium reports failed chrome" "$out"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
