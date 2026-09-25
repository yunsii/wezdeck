# shellcheck shell=bash
# Line-budget checks against budgets.conf.

hygiene_load_budgets() {
  local conf="$1"
  HYGIENE_BUDGET_CONF="$conf"
  HYGIENE_ALLOWLIST=()
  [[ -f "$conf" ]] || return 0
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue
    if [[ "$line" == allow\ * ]]; then
      HYGIENE_ALLOWLIST+=("${line#allow }")
    fi
  done <"$conf"
}

hygiene_is_allowlisted() {
  local rel="$1" a
  for a in "${HYGIENE_ALLOWLIST[@]:-}"; do
    [[ "$rel" == "$a" ]] && return 0
  done
  return 1
}

# Batch size check via one Python process.
# Args: root mode(pre-commit|audit) files...
# Sets HYGIENE_SIZE_FAILS; prints findings.
hygiene_check_sizes() {
  local root="$1" mode="$2"
  shift 2
  HYGIENE_SIZE_FAILS=0
  [[ "$#" -gt 0 ]] || return 0
  local conf="${HYGIENE_BUDGET_CONF:-$(hygiene_home)/budgets.conf}"
  local out
  out="$(python3 - "$root" "$mode" "$conf" "$@" <<'PY'
import fnmatch, subprocess, sys
from pathlib import Path

root = Path(sys.argv[1])
mode = sys.argv[2]
conf_path = Path(sys.argv[3])
files = sys.argv[4:]

patterns = []  # (pattern, soft, hard)
allow = set()
if conf_path.is_file():
    for raw in conf_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("allow "):
            allow.add(line[len("allow "):].strip())
            continue
        parts = line.split()
        if len(parts) != 3:
            continue
        pat, soft, hard = parts
        patterns.append((pat, int(soft), int(hard)))

def budget_for(rel: str):
    for pat, soft, hard in patterns:
        if fnmatch.fnmatch(rel, pat):
            return soft, hard
        # scripts/**/*.sh style
        if "**" in pat:
            alt = pat.replace("**/", "*").replace("/**", "/*")
            if fnmatch.fnmatch(rel, alt):
                return soft, hard
            if pat.endswith("/**/*.sh") and rel.startswith(pat[: -len("/**/*.sh")] + "/") and rel.endswith(".sh"):
                return soft, hard
    return None

def line_count(p: Path) -> int:
    try:
        return sum(1 for _ in p.open("rb"))
    except OSError:
        return 0

def head_line_count(rel: str):
    try:
        data = subprocess.check_output(["git", "-C", str(root), "show", f"HEAD:{rel}"], stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        return None
    if not data:
        return 0
    return data.count(b"\n") + (0 if data.endswith(b"\n") else 1)

fails = 0
for rel in files:
    path = root / rel
    if not path.is_file():
        continue
    b = budget_for(rel)
    if b is None:
        continue
    soft, hard = b
    n = line_count(path)
    allowed = rel in allow
    tag = " [allowlisted]" if allowed else ""

    if n > soft:
        print(f"ADVISORY {rel}: {n} lines > soft {soft} (hard {hard}){tag}")

    if n <= hard:
        continue

    if mode == "audit":
        print(f"OVER-HARD {rel}: {n} lines > hard {hard}{tag}")
        continue

    # pre-commit
    if allowed:
        print(f"ADVISORY {rel}: {n} lines > hard {hard} [allowlisted; growth still watched]")
        head_n = head_line_count(rel)
        if head_n is not None and head_n > hard and n > head_n:
            print(f"FAIL {rel}: allowlisted but grew past hard ({head_n} -> {n}; hard {hard})")
            fails += 1
        continue

    head_n = head_line_count(rel)
    if head_n is None:
        print(f"FAIL {rel}: new file {n} lines > hard {hard}")
        fails += 1
        continue
    if head_n <= hard < n:
        print(f"FAIL {rel}: crossed hard budget this commit ({head_n} -> {n}; hard {hard})")
        fails += 1
    else:
        print(f"ADVISORY {rel}: already over hard ({n} lines; hard {hard}) — split when touching domain")

print(f"__FAILS__={fails}")
PY
)"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if [[ "$line" == __FAILS__=* ]]; then
      HYGIENE_SIZE_FAILS=$((HYGIENE_SIZE_FAILS + ${line#__FAILS__=}))
    else
      printf '%s\n' "$line"
    fi
  done <<<"$out"
}

# Keep for --strict path in run.sh
hygiene_budget_for() {
  local rel="$1"
  local conf="${HYGIENE_BUDGET_CONF:-$(hygiene_home)/budgets.conf}"
  local result
  result="$(python3 - "$rel" "$conf" <<'PY'
import fnmatch, sys
from pathlib import Path
rel, conf_path = sys.argv[1], Path(sys.argv[2])
patterns = []
for raw in conf_path.read_text(encoding="utf-8", errors="replace").splitlines():
    line = raw.split("#", 1)[0].strip()
    if not line or line.startswith("allow "):
        continue
    parts = line.split()
    if len(parts) == 3:
        patterns.append((parts[0], parts[1], parts[2]))
for pat, soft, hard in patterns:
    if fnmatch.fnmatch(rel, pat):
        print(f"{soft} {hard}")
        raise SystemExit(0)
    if "**" in pat:
        alt = pat.replace("**/", "*").replace("/**", "/*")
        if fnmatch.fnmatch(rel, alt) or (
            pat.endswith("/**/*.sh") and rel.startswith(pat[: -len("/**/*.sh")] + "/") and rel.endswith(".sh")
        ):
            print(f"{soft} {hard}")
            raise SystemExit(0)
raise SystemExit(1)
PY
)" || return 1
  read -r HYGIENE_MATCH_SOFT HYGIENE_MATCH_HARD <<<"$result"
  return 0
}
