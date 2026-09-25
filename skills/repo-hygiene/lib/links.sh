# shellcheck shell=bash
# Relative markdown link + heading-anchor checks.

# Check relative file links (and optional anchors) in markdown files.
# Args: root, soft_anchors(0|1), files...
# Prints findings; sets HYGIENE_LINK_FAILS.
hygiene_check_md_links() {
  local root="$1" soft_anchors="$2"
  shift 2
  HYGIENE_LINK_FAILS=0
  [[ "$#" -gt 0 ]] || return 0
  local out
  out="$(python3 - "$root" "$soft_anchors" "$@" <<'PY'
import re, sys
from pathlib import Path

root = Path(sys.argv[1])
soft_anchors = sys.argv[2] == "1"
mds = sys.argv[3:]
link_re = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")

def gfm_slugs(title: str) -> set[str]:
    """GitHub-ish heading ids.

    After lowercasing and stripping markdown, punctuation is removed while
    spaces are preserved, then each space becomes '-'. That means
    ``Hook → status`` becomes ``hook--status`` (arrow gone → two spaces).
    Also emit a collapsed variant for older/looser links.
    """
    s = title.strip()
    s = re.sub(r"`([^`]*)`", r"\1", s)
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
    s = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", s)
    s = s.lower()
    # keep word chars, CJK, spaces, hyphens, underscores
    cleaned = []
    for ch in s:
        o = ord(ch)
        if ch.isalnum() or ch in " -_" or 0x4E00 <= o <= 0x9FFF:
            cleaned.append(ch)
        # else drop punctuation (do not insert space)
    s = "".join(cleaned)
    # GFM: each run of spaces? Actually each space → '-'; we map every
    # whitespace char to '-' without collapsing, matching github-slugger /
    # commonmark heading ids used by GitHub.
    spaced = re.sub(r"\s", "-", s)
    spaced = spaced.strip("-")
    collapsed = re.sub(r"-{2,}", "-", spaced).strip("-")
    out = {spaced, collapsed}
    # also underscore↔hyphen soft variants
    out.add(spaced.replace("_", "-"))
    out.add(collapsed.replace("_", "-"))
    return {x for x in out if x}

def anchors_of(p: Path) -> set[str]:
    t = p.read_text(encoding="utf-8", errors="replace")
    out: set[str] = set()
    for m in re.finditer(r"^(#{1,6})\s+(.+?)(?:\s+\{#([^}]+)\})?\s*$", t, re.M):
        if m.group(3):
            out.add(m.group(3))
        out |= gfm_slugs(m.group(2))
    return out

fails = 0
for md in mds:
    path = root / md
    if not path.is_file():
        continue
    text = path.read_text(encoding="utf-8", errors="replace")
    for m in link_re.finditer(text):
        raw = m.group(2).strip()
        url = raw.split()[0].strip("<>")
        if url.startswith(("http://", "https://", "mailto:", "data:", "//")):
            continue
        file_part, frag = (url.split("#", 1) + [""])[:2]
        if not file_part:
            target = path
        else:
            target = (path.parent / file_part).resolve()
            if not target.exists():
                print(f"FAIL {md}: missing file {file_part} (from {url})")
                fails += 1
                continue
        if frag:
            if not target.is_file():
                print(f"FAIL {md}: anchor target not a file {url}")
                fails += 1
                continue
            an = anchors_of(target)
            frag_l = frag.lower()
            # accept exact, collapsed, or underscore variants
            frag_collapsed = re.sub(r"-{2,}", "-", frag_l)
            if frag_l not in an and frag_collapsed not in an:
                kind = "ADVISORY" if soft_anchors else "FAIL"
                print(f"{kind} {md}: missing anchor #{frag} (from {url})")
                if not soft_anchors:
                    fails += 1
print(f"__FAILS__={fails}")
PY
)"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if [[ "$line" == __FAILS__=* ]]; then
      HYGIENE_LINK_FAILS=$((HYGIENE_LINK_FAILS + ${line#__FAILS__=}))
    else
      printf '%s\n' "$line"
    fi
  done <<<"$out"
}

# Audit-only backtick paths. Quiet by default quality:
# - require a path separator OR a known tracked basename
# - resolve basename against git ls-files index
# Args: root files...
hygiene_check_backtick_paths() {
  local root="$1"
  shift
  [[ "$#" -gt 0 ]] || return 0
  python3 - "$root" "$@" <<'PY'
import re, subprocess, sys
from pathlib import Path
from collections import defaultdict

root = Path(sys.argv[1])
files = sys.argv[2:]
pat = re.compile(r"`([A-Za-z0-9_./\-]+(?:\.[A-Za-z0-9]+))`")

# basename → list of repo-relative paths
by_base: dict[str, list[str]] = defaultdict(list)
try:
    out = subprocess.check_output(
        ["git", "-C", str(root), "ls-files", "-z"],
        stderr=subprocess.DEVNULL,
    )
    for rel in out.split(b"\0"):
        if not rel:
            continue
        s = rel.decode("utf-8", "replace")
        by_base[Path(s).name].append(s)
except subprocess.CalledProcessError:
    by_base = defaultdict(list)

# Extensions / names that are usually prose, not paths
skip_names = {
    "package.json", "tsconfig.json", "Cargo.toml", "go.mod",
    "README.md", "AGENTS.md", "CLAUDE.md", "CHANGELOG.md",
}

advisory = 0
for rel in files:
    p = root / rel
    if not p.is_file():
        continue
    text = p.read_text(encoding="utf-8", errors="replace")
    seen = set()
    for m in pat.finditer(text):
        cand = m.group(1)
        if cand in seen:
            continue
        seen.add(cand)
        if cand.startswith(("http://", "https://", "/")):
            continue
        if "<" in cand or "*" in cand or cand.count("..") > 2:
            continue
        if cand in skip_names:
            continue
        # bare basename without slash: OK if unique-or-any tracked hit
        if "/" not in cand:
            if cand in by_base:
                continue
            # not tracked anywhere — only report if it looks like a repo script/module
            if not cand.endswith((".sh", ".lua", ".py", ".ps1", ".js", ".ts", ".tsx", ".go")):
                continue
            print(f"ADVISORY {rel}: backtick basename not in git `{cand}`")
            advisory += 1
            continue
        # path-like: check relative to repo root and to the md file
        if (root / cand).exists() or (p.parent / cand).exists():
            continue
        base = Path(cand).name
        if base in by_base:
            # exists elsewhere under another prefix — not missing, just shorthand
            continue
        print(f"ADVISORY {rel}: backtick path missing `{cand}`")
        advisory += 1
print(f"__BACKTICK_ADVISORY__={advisory}")
PY
}
