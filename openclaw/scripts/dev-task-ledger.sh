#!/usr/bin/env bash
# OpenClaw development-task ledger → Feishu Base (bitable).
# Secrets: OPENCLAW_TASKS_BASE_TOKEN / OPENCLAW_TASKS_TABLE_ID from env or shell-env.d.
set -euo pipefail

cmd="${1:-}"
shift || true

STATE_DIR="${OPENCLAW_TASKS_STATE_DIR:-${HOME}/.local/state/openclaw-tasks}"
INDEX_FILE="${STATE_DIR}/index.json"
ENV_FILE="${OPENCLAW_TASKS_ENV_FILE:-${HOME}/.config/shell-env.d/openclaw-tasks.env}"

# Development allowlist: coco-forge + wezdeck (wezterm-config).
# Override with OPENCLAW_TASKS_ALLOWED_ROOTS (colon-separated absolute paths).
DEFAULT_ALLOWED_ROOTS="${HOME}/work/coco-forge:${HOME}/work/.worktrees/coco-forge:${HOME}/github/wezterm-config:${HOME}/work/.worktrees/wezterm-config:${HOME}/work/wezterm-config"

load_env() {
  if [[ -f "${ENV_FILE}" ]]; then
    # shellcheck disable=SC1090
    set -a
    # shellcheck disable=SC1091
    source "${ENV_FILE}"
    set +a
  fi
}

# Return 0 if path is under an allowed root (or equals a root).
path_allowed() {
  local raw="${1:-}"
  if [[ -z "${raw}" ]]; then
    return 1
  fi
  local resolved roots root r
  if [[ -e "${raw}" ]]; then
    resolved="$(realpath -m "${raw}" 2>/dev/null || readlink -f "${raw}" 2>/dev/null || echo "${raw}")"
  else
    # non-existent path: still normalize for prefix check
    resolved="$(realpath -m "${raw}" 2>/dev/null || echo "${raw}")"
  fi
  roots="${OPENCLAW_TASKS_ALLOWED_ROOTS:-${DEFAULT_ALLOWED_ROOTS}}"
  IFS=':' read -r -a arr <<<"${roots}"
  for root in "${arr[@]}"; do
    [[ -z "${root}" ]] && continue
    r="$(realpath -m "${root}" 2>/dev/null || echo "${root}")"
    if [[ "${resolved}" == "${r}" || "${resolved}" == "${r}/"* ]]; then
      return 0
    fi
  done
  return 1
}

is_remote_url() {
  local s="${1:-}"
  [[ "${s}" =~ ^(https?://|git@|ssh://|git://) ]]
}

# Best-effort: git toplevel for a path (empty if not a repo).
git_toplevel() {
  local p="${1:-}"
  [[ -z "${p}" ]] && return 0
  git -C "${p}" rev-parse --show-toplevel 2>/dev/null || true
}

# Convert any git remote form → https web URL (clickable in Feishu Base).
# git@host:org/repo.git | ssh://git@host/… | https://…/.git → https://host/org/repo
repo_to_web_url() {
  local raw="${1:-}"
  [[ -z "${raw}" ]] && return 1
  python3 -c '
import re, sys
u = (sys.argv[1] or "").strip()
if not u:
    sys.exit(1)
# git@host:path
m = re.match(r"^git@([^:]+):(.+)$", u)
if m:
    host, path = m.group(1), m.group(2)
    path = path.removeprefix("/").removesuffix(".git")
    print(f"https://{host}/{path}")
    raise SystemExit(0)
# ssh://git@host[:port]/path or ssh://host/path
m = re.match(r"^ssh://(?:git@)?([^/]+?)(?::\d+)?/(.+)$", u)
if m:
    host, path = m.group(1), m.group(2)
    path = path.removesuffix(".git")
    print(f"https://{host}/{path}")
    raise SystemExit(0)
# git://host/path
m = re.match(r"^git://([^/]+)/(.+)$", u)
if m:
    host, path = m.group(1), m.group(2)
    path = path.removesuffix(".git")
    print(f"https://{host}/{path}")
    raise SystemExit(0)
# http(s)://…  strip .git suffix for cleaner browser link
m = re.match(r"^(https?://)(.+)$", u)
if m:
    scheme, rest = m.group(1), m.group(2)
    if rest.endswith(".git"):
        rest = rest[:-4]
    # prefer https for clickability
    if scheme == "http://":
        scheme = "https://"
    print(f"{scheme}{rest}")
    raise SystemExit(0)
# unknown form — pass through
print(u)
' "${raw}"
}

# Resolve origin (or first remote) URL for a local git path; or echo if already URL.
# Always returns https web form when conversion succeeds.
resolve_repo_remote() {
  local p="${1:-}"
  [[ -z "${p}" ]] && return 1
  local url top rname web
  if is_remote_url "${p}"; then
    url="${p}"
  else
    top="$(git_toplevel "${p}")"
    [[ -z "${top}" ]] && top="${p}"
    url="$(git -C "${top}" remote get-url origin 2>/dev/null || true)"
    if [[ -z "${url}" ]]; then
      rname="$(git -C "${top}" remote 2>/dev/null | head -1 || true)"
      if [[ -n "${rname}" ]]; then
        url="$(git -C "${top}" remote get-url "${rname}" 2>/dev/null || true)"
      fi
    fi
  fi
  [[ -n "${url}" ]] || return 1
  web="$(repo_to_web_url "${url}" || true)"
  printf '%s' "${web:-${url}}"
}

assert_local_dev_path() {
  local p="${1:-}"
  [[ -z "${p}" ]] && return 0
  if is_remote_url "${p}"; then
    return 0
  fi
  if ! path_allowed "${p}"; then
    echo "error: development path not on allowlist (coco-forge | wezdeck/wezterm-config)" >&2
    echo "  refused path: ${p}" >&2
    echo "  allowed: ${OPENCLAW_TASKS_ALLOWED_ROOTS:-${DEFAULT_ALLOWED_ROOTS}}" >&2
    exit 5
  fi
}

# Normalize REPO → https web URL for Feishu 仓库; CWD → absolute local path.
# Allowlist checks apply only to local paths (not to remote URLs).
normalize_repo_and_cwd() {
  local path_hint="" remote="" top="" web=""

  if [[ -n "${CWD:-}" ]]; then
    CWD="$(realpath -m "${CWD}" 2>/dev/null || echo "${CWD}")"
    path_hint="${CWD}"
  fi
  if [[ -n "${REPO:-}" ]] && ! is_remote_url "${REPO}"; then
    REPO="$(realpath -m "${REPO}" 2>/dev/null || echo "${REPO}")"
    path_hint="${REPO}"
    if [[ -z "${CWD:-}" ]]; then
      CWD="${REPO}"
    fi
  fi
  if [[ -z "${REPO:-}" && -n "${CWD:-}" ]]; then
    path_hint="${CWD}"
  fi

  # Allowlist: local cwd + local repo path (before rewriting REPO to URL)
  if [[ -n "${path_hint}" ]]; then
    top="$(git_toplevel "${path_hint}")"
    [[ -z "${top}" ]] && top="${path_hint}"
    assert_local_dev_path "${top}"
    assert_local_dev_path "${CWD:-}"
  fi

  if [[ -n "${REPO:-}" ]] && is_remote_url "${REPO}"; then
    remote="${REPO}"
  else
    if [[ -n "${path_hint}" ]]; then
      remote="$(resolve_repo_remote "${path_hint}" || true)"
    fi
  fi
  if [[ -z "${remote}" ]]; then
    echo "error: cannot resolve git remote for 仓库 field" >&2
    echo "  pass a local path with origin configured, or --repo with https/git@ URL" >&2
    exit 5
  fi
  # Always store clickable https web URL in 仓库 (not git@ / local path / .git)
  web="$(repo_to_web_url "${remote}" || true)"
  REPO="${web:-${remote}}"

  if [[ -n "${CWD:-}" ]]; then
    CWD="$(realpath -m "${CWD}" 2>/dev/null || echo "${CWD}")"
  fi
}

require_bins() {
  if ! command -v lark-cli >/dev/null 2>&1; then
    echo "error: lark-cli not on PATH (install @larksuite/cli)" >&2
    exit 127
  fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "error: jq required" >&2
    exit 127
  fi
  if ! command -v uuidgen >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
    echo "error: uuidgen or python3 required" >&2
    exit 127
  fi
}

require_config() {
  load_env
  BASE_TOKEN="${OPENCLAW_TASKS_BASE_TOKEN:-}"
  TABLE_ID="${OPENCLAW_TASKS_TABLE_ID:-}"
  AS_IDENTITY="${OPENCLAW_TASKS_LARK_AS:-bot}"
  if [[ -z "${BASE_TOKEN}" || -z "${TABLE_ID}" ]]; then
    echo "error: set OPENCLAW_TASKS_BASE_TOKEN and OPENCLAW_TASKS_TABLE_ID" >&2
    echo "  (e.g. ${ENV_FILE})" >&2
    exit 2
  fi
}

new_task_id() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
  fi
}

now_local() {
  # Second precision for Base **text** time fields (YYYY-MM-DD HH:MM:SS).
  # 开始时间/确认时间/结束时间 must be type=text in Feishu Base:
  # datetime display formats max at minute (no :ss) and default yyyy/MM/dd
  # only shows the day.
  date '+%Y-%m-%d %H:%M:%S'
}

ensure_state() {
  mkdir -p "${STATE_DIR}"
  if [[ ! -f "${INDEX_FILE}" ]]; then
    echo '{}' >"${INDEX_FILE}"
    chmod 600 "${INDEX_FILE}"
  fi
}

index_get() {
  local task_id="$1"
  jq -r --arg id "${task_id}" '.[$id].record_id // empty' "${INDEX_FILE}"
}

index_del() {
  local task_id="$1"
  local tmp
  tmp="$(mktemp)"
  jq --arg id "${task_id}" 'del(.[$id])' "${INDEX_FILE}" >"${tmp}"
  mv "${tmp}" "${INDEX_FILE}"
  chmod 600 "${INDEX_FILE}"
}

# Drop every index entry pointing at record_id (best-effort local cleanup).
index_del_by_record() {
  local record_id="$1"
  local tmp
  tmp="$(mktemp)"
  jq --arg rid "${record_id}" '
    with_entries(select(.value.record_id != $rid))
  ' "${INDEX_FILE}" >"${tmp}"
  mv "${tmp}" "${INDEX_FILE}"
  chmod 600 "${INDEX_FILE}"
}

# index_set TASK_ID RECORD_ID [confirm_required 0|1] [confirmed 0|1]
index_set() {
  local task_id="$1" record_id="$2"
  local confirm_required="${3:-}"
  local confirmed="${4:-}"
  local tmp
  tmp="$(mktemp)"
  jq --arg id "${task_id}" --arg rid "${record_id}" --arg at "$(date -Iseconds)" \
    --arg cr "${confirm_required}" --arg cf "${confirmed}" '
    .[$id] = ((.[$id] // {}) + {record_id: $rid, updated_at: $at}
      + (if $cr == "" then {} else {confirm_required: ($cr == "1")} end)
      + (if $cf == "" then {} else {confirmed: ($cf == "1")} end))
  ' "${INDEX_FILE}" >"${tmp}"
  mv "${tmp}" "${INDEX_FILE}"
  chmod 600 "${INDEX_FILE}"
}

index_needs_confirm() {
  local task_id="$1"
  jq -e --arg id "${task_id}" '
    (.[$id].confirm_required == true) and (.[$id].confirmed != true)
  ' "${INDEX_FILE}" >/dev/null 2>&1
}

# Resolve record_id: local index first, then list+filter by task_id field (best-effort)
resolve_record_id() {
  local task_id="$1"
  local rid
  rid="$(index_get "${task_id}")"
  if [[ -n "${rid}" ]]; then
    printf '%s' "${rid}"
    return 0
  fi
  # fallback: pull a page and match task_id (limit 200)
  local list_json
  list_json="$(lark-cli base +record-list \
    --as "${AS_IDENTITY}" \
    --base-token "${BASE_TOKEN}" \
    --table-id "${TABLE_ID}" \
    --limit 200 \
    --format json 2>/dev/null || true)"
  rid="$(printf '%s' "${list_json}" | jq -r --arg id "${task_id}" '
    (.data.records // .data.items // .records // [])
    | map(select(
        ((.fields.task_id // .fields["task_id"] // "") | tostring | test($id))
        or ((.fields // {}) | to_entries | map(select(.key=="task_id") | .value) | first // "" | tostring) == $id
      ))
    | .[0].record_id // .[0].id // empty
  ' 2>/dev/null || true)"
  # try more robust parse for field values as objects/arrays
  if [[ -z "${rid}" ]]; then
    rid="$(printf '%s' "${list_json}" | python3 -c '
import json,sys
tid=sys.argv[1]
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(0)
recs = d.get("data",{}).get("records") or d.get("data",{}).get("items") or d.get("records") or []
def cell(v):
    if v is None: return ""
    if isinstance(v, str): return v
    if isinstance(v, list):
        parts=[]
        for x in v:
            if isinstance(x, dict) and "text" in x: parts.append(str(x["text"]))
            else: parts.append(str(x))
        return "".join(parts)
    if isinstance(v, dict):
        return str(v.get("text") or v.get("value") or "")
    return str(v)
for r in recs:
    f=r.get("fields") or {}
    if cell(f.get("task_id"))==tid:
        print(r.get("record_id") or r.get("id") or "")
        break
' "${task_id}" <<<"${list_json}" 2>/dev/null || true)"
  fi
  if [[ -n "${rid}" ]]; then
    index_set "${task_id}" "${rid}"
    printf '%s' "${rid}"
  fi
}

upsert_fields() {
  local json_fields="$1"
  local record_id="${2:-}"
  local args=(
    base +record-upsert
    --as "${AS_IDENTITY}"
    --base-token "${BASE_TOKEN}"
    --table-id "${TABLE_ID}"
    --json "${json_fields}"
    --format json
  )
  if [[ -n "${record_id}" ]]; then
    args+=(--record-id "${record_id}")
  fi
  lark-cli "${args[@]}"
}

usage() {
  cat <<'EOF'
Usage:
  dev-task-ledger.sh open   --title TEXT [--repo PATH|URL] [--cwd PATH] [--branch B]
                            [--scope S] [--acceptance A] [--risk low|medium|high]
                            [--source feishu|cli|manual] [--source-ref R]
                            [--confirm-required 0|1] [--tags T] [--model M]
                            [--requester-id OU_ID] [--requester NAME]
                            [--task-id UUID]
  dev-task-ledger.sh update --task-id UUID [--status S] [--title T] ... (same optional fields)
  dev-task-ledger.sh confirm --task-id UUID
  dev-task-ledger.sh close  --task-id UUID --status done|failed|cancelled|blocked
                            [--summary TEXT] [--commits HASHES] [--branch B]
                            [--mr URL] [--cwd PATH]
  dev-task-ledger.sh show   --task-id UUID
  dev-task-ledger.sh list   [--limit N]
  dev-task-ledger.sh delete --task-id UUID | --record-id REC
                            # remove Base row + local index (tests / mistakes)
  dev-task-ledger.sh config  # print whether base/table env is set (no secrets)

Env:
  OPENCLAW_TASKS_BASE_TOKEN   Feishu base token
  OPENCLAW_TASKS_TABLE_ID     table id (tbl…)
  OPENCLAW_TASKS_LARK_AS      bot|user (default bot)
  OPENCLAW_TASKS_ENV_FILE     default ~/.config/shell-env.d/openclaw-tasks.env

Notes:
  --repo           local path (→ origin, then https web URL for 仓库) or any git remote form
  --cwd            local absolute/relative path only → Base field cwd
  仓库 (Base)      always https://… web URL (clickable); never git@ / local path / bare .git
  cwd (Base)       local working path (machine-local; allowlisted)
  --requester-id   Feishu open_id (ou_…), writes person field 需求提出人
  --requester      display name only (stored in record_note when no id; prefer --requester-id)
  delete           after every smoke/test open, delete the row (do not leave test data in Base)
EOF
}

parse_kv() {
  TITLE=""; REPO=""; CWD=""; BRANCH=""; SCOPE=""; ACCEPT=""; RISK=""
  SOURCE="feishu"; SOURCE_REF=""; CONFIRM_REQ="1"; TAGS=""; MODEL=""
  TASK_ID=""; RECORD_ID=""; STATUS=""; SUMMARY=""; COMMITS=""; MR=""
  REQUESTER_ID=""; REQUESTER_NAME=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title) TITLE="$2"; shift 2 ;;
      --repo) REPO="$2"; shift 2 ;;
      --cwd) CWD="$2"; shift 2 ;;
      --branch) BRANCH="$2"; shift 2 ;;
      --scope) SCOPE="$2"; shift 2 ;;
      --acceptance) ACCEPT="$2"; shift 2 ;;
      --risk) RISK="$2"; shift 2 ;;
      --source) SOURCE="$2"; shift 2 ;;
      --source-ref) SOURCE_REF="$2"; shift 2 ;;
      --confirm-required) CONFIRM_REQ="$2"; shift 2 ;;
      --tags) TAGS="$2"; shift 2 ;;
      --model) MODEL="$2"; shift 2 ;;
      --task-id) TASK_ID="$2"; shift 2 ;;
      --record-id) RECORD_ID="$2"; shift 2 ;;
      --status) STATUS="$2"; shift 2 ;;
      --summary) SUMMARY="$2"; shift 2 ;;
      --commits) COMMITS="$2"; shift 2 ;;
      --mr) MR="$2"; shift 2 ;;
      --requester-id) REQUESTER_ID="$2"; shift 2 ;;
      --requester) REQUESTER_NAME="$2"; shift 2 ;;
      --limit) LIMIT="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
  done
}

build_partial_json() {
  # stdout: JSON object with only set fields (Chinese column names)
  # person field 需求提出人 expects [{"id":"ou_xxx"}]
  python3 - <<'PY' \
    "${TITLE:-}" "${STATUS:-}" "${SOURCE:-}" "${SOURCE_REF:-}" \
    "${REPO:-}" "${CWD:-}" "${BRANCH:-}" "${SCOPE:-}" "${ACCEPT:-}" \
    "${RISK:-}" "${CONFIRM_REQ:-}" "${TAGS:-}" "${MODEL:-}" \
    "${SUMMARY:-}" "${COMMITS:-}" "${MR:-}" "${TASK_ID:-}" \
    "${OPENED_AT:-}" "${CLOSED_AT:-}" "${CONFIRMED_AT:-}" \
    "${REQUESTER_ID:-}" "${REQUESTER_NAME:-}"
import json, sys
keys = [
  ("标题", 0), ("状态", 1), ("来源", 2), ("source_ref", 3),
  ("仓库", 4), ("cwd", 5), ("分支", 6), ("范围", 7), ("验收", 8),
  ("风险", 9), ("需确认", 10), ("tags", 11), ("模型", 12),
  ("结果摘要", 13), ("commits", 14), ("MR", 15), ("task_id", 16),
  ("开始时间", 17), ("结束时间", 18), ("确认时间", 19),
]
vals = sys.argv[1:]
out = {}
for name, i in keys:
    if i >= len(vals):
        break
    v = vals[i]
    if v is None or v == "":
        continue
    if name == "需确认":
        out[name] = v in ("1", "true", "True", "yes", "YES")
    else:
        out[name] = v
# person field: prefer open_id
req_id = vals[20] if len(vals) > 20 else ""
req_name = vals[21] if len(vals) > 21 else ""
if req_id:
    out["需求提出人"] = [{"id": req_id}]
elif req_name:
    # fallback note when only a display name is known
    note = out.get("record_note") or ""
    extra = f"需求提出人: {req_name}"
    out["record_note"] = f"{note}; {extra}".strip("; ") if note else extra
print(json.dumps(out, ensure_ascii=False))
PY
}

cmd_open() {
  parse_kv "$@"
  require_config
  ensure_state
  if [[ -z "${TITLE}" ]]; then
    echo "error: --title required" >&2
    exit 2
  fi
  # Default local paths to coco-forge primary if omitted
  if [[ -z "${REPO}" && -z "${CWD}" ]]; then
    REPO="${HOME}/work/coco-forge"
    CWD="${HOME}/work/coco-forge"
  fi
  if [[ -z "${CWD}" && -n "${REPO}" ]] && ! is_remote_url "${REPO}"; then
    CWD="${REPO}"
  fi
  # 仓库 → remote URL; cwd → local path; allowlist on local paths
  normalize_repo_and_cwd
  if [[ -z "${TASK_ID}" ]]; then
    TASK_ID="$(new_task_id)"
  fi
  STATUS="${STATUS:-open}"
  OPENED_AT="$(now_local)"
  RISK="${RISK:-medium}"
  # Closed loop for 需确认 / 确认时间:
  # - confirm-required 1: 需确认=true, 确认时间 empty until confirm
  # - confirm-required 0: 需确认=false, 确认时间=开始时间 (no separate gate)
  local conf_req_flag conf_done_flag
  if [[ "${CONFIRM_REQ}" == "1" || "${CONFIRM_REQ}" == "true" || "${CONFIRM_REQ}" == "yes" ]]; then
    CONFIRM_REQ="1"
    conf_req_flag="1"
    conf_done_flag="0"
    CONFIRMED_AT=""
  else
    CONFIRM_REQ="0"
    conf_req_flag="0"
    conf_done_flag="1"
    CONFIRMED_AT="${OPENED_AT}"
  fi
  local fields
  fields="$(build_partial_json)"
  local resp rid
  resp="$(upsert_fields "${fields}")"
  rid="$(printf '%s' "${resp}" | python3 -c '
import json,sys
d=json.load(sys.stdin)
rec=(d.get("data") or {}).get("record") or {}
ids=rec.get("record_id_list") or []
if ids:
    print(ids[0]); raise SystemExit
for k in ("record_id","id"):
    if isinstance(rec.get(k), str):
        print(rec[k]); raise SystemExit
print(d.get("data",{}).get("record_id") or "")
' 2>/dev/null || true)"
  if [[ -z "${rid}" ]]; then
    echo "error: upsert failed or no record_id" >&2
    printf '%s\n' "${resp}" | head -c 1500 >&2
    exit 4
  fi
  index_set "${TASK_ID}" "${rid}" "${conf_req_flag}" "${conf_done_flag}"
  jq -n \
    --arg tid "${TASK_ID}" \
    --arg rid "${rid}" \
    --arg opened "${OPENED_AT}" \
    --arg conf "${CONFIRMED_AT:-}" \
    --argjson need "$([[ "${conf_req_flag}" == "1" ]] && echo true || echo false)" \
    '{ok:true, task_id:$tid, record_id:$rid, opened_at:$opened, confirm_required:$need}
     + (if $conf != "" then {confirmed_at:$conf} else {} end)'
}

cmd_update() {
  parse_kv "$@"
  require_config
  ensure_state
  if [[ -z "${TASK_ID}" ]]; then
    echo "error: --task-id required" >&2
    exit 2
  fi
  if [[ -n "${REPO}" || -n "${CWD}" ]]; then
    normalize_repo_and_cwd
  fi
  local rid fields resp
  rid="$(resolve_record_id "${TASK_ID}")"
  if [[ -z "${rid}" ]]; then
    echo "error: no record for task_id=${TASK_ID}" >&2
    exit 3
  fi
  fields="$(build_partial_json)"
  # always keep task_id stable
  fields="$(printf '%s' "${fields}" | jq --arg id "${TASK_ID}" '. + {task_id:$id}')"
  resp="$(upsert_fields "${fields}" "${rid}")"
  jq -n --arg tid "${TASK_ID}" --arg rid "${rid}" --argjson raw "${resp}" \
    '{ok:true, task_id:$tid, record_id:$rid, raw:$raw}' 2>/dev/null \
    || echo "{\"ok\":true,\"task_id\":\"${TASK_ID}\",\"record_id\":\"${rid}\"}"
}

cmd_confirm() {
  parse_kv "$@"
  require_config
  ensure_state
  if [[ -z "${TASK_ID}" ]]; then
    echo "error: --task-id required" >&2
    exit 2
  fi
  local rid
  rid="$(resolve_record_id "${TASK_ID}")"
  if [[ -z "${rid}" ]]; then
    echo "error: no record for task_id=${TASK_ID}" >&2
    exit 3
  fi
  # 确认时间 = 用户确认方案/初评/开发方式的时刻（秒）
  CONFIRMED_AT="$(now_local)"
  local fields
  fields="$(jq -n --arg t "${CONFIRMED_AT}" --arg s "in_progress" \
    '{"确认时间":$t,"状态":$s,"需确认":false}')"
  upsert_fields "${fields}" "${rid}" >/dev/null
  index_set "${TASK_ID}" "${rid}" "1" "1"
  echo "{\"ok\":true,\"task_id\":\"${TASK_ID}\",\"status\":\"in_progress\",\"confirmed_at\":\"${CONFIRMED_AT}\",\"record_id\":\"${rid}\"}"
}

cmd_close() {
  parse_kv "$@"
  require_config
  ensure_state
  if [[ -z "${TASK_ID}" || -z "${STATUS}" ]]; then
    echo "error: --task-id and --status required" >&2
    exit 2
  fi
  if [[ -n "${REPO}" || -n "${CWD}" ]]; then
    normalize_repo_and_cwd
  fi
  case "${STATUS}" in
    done|failed|cancelled|blocked) ;;
    *) echo "error: close status must be done|failed|cancelled|blocked" >&2; exit 2 ;;
  esac
  local rid fields
  rid="$(resolve_record_id "${TASK_ID}")"
  if [[ -z "${rid}" ]]; then
    echo "error: no record for task_id=${TASK_ID}" >&2
    exit 3
  fi
  # done requires confirm when open used --confirm-required 1
  if [[ "${STATUS}" == "done" ]] && index_needs_confirm "${TASK_ID}"; then
    echo "error: task still 需确认 — run confirm after user approves plan/初评/开发方式" >&2
    echo "  ./openclaw/scripts/dev-task-ledger.sh confirm --task-id ${TASK_ID}" >&2
    exit 6
  fi
  # 结束时间 = 台账结案时刻（close 调用秒级），不是 PR merge 自动时间
  CLOSED_AT="$(now_local)"
  fields="$(jq -n \
    --arg s "${STATUS}" \
    --arg end "${CLOSED_AT}" \
    --arg sum "${SUMMARY}" \
    --arg c "${COMMITS}" \
    --arg b "${BRANCH}" \
    --arg mr "${MR}" \
    --arg cwd "${CWD}" \
    '{
      "状态": $s,
      "结束时间": $end,
      "需确认": false
    }
    + (if $sum != "" then {"结果摘要": $sum} else {} end)
    + (if $c != "" then {"commits": $c} else {} end)
    + (if $b != "" then {"分支": $b} else {} end)
    + (if $mr != "" then {"MR": $mr} else {} end)
    + (if $cwd != "" then {"cwd": $cwd} else {} end)
  ')"
  upsert_fields "${fields}" "${rid}" >/dev/null
  index_set "${TASK_ID}" "${rid}" "" "1"
  echo "{\"ok\":true,\"task_id\":\"${TASK_ID}\",\"status\":\"${STATUS}\",\"closed_at\":\"${CLOSED_AT}\",\"record_id\":\"${rid}\"}"
}

cmd_show() {
  parse_kv "$@"
  require_config
  ensure_state
  local rid
  rid="$(resolve_record_id "${TASK_ID}")"
  if [[ -z "${rid}" ]]; then
    echo "error: not found" >&2
    exit 3
  fi
  lark-cli base +record-get \
    --as "${AS_IDENTITY}" \
    --base-token "${BASE_TOKEN}" \
    --table-id "${TABLE_ID}" \
    --record-id "${rid}" \
    --format json
}

cmd_list() {
  LIMIT="${LIMIT:-50}"
  parse_kv "$@"
  require_config
  lark-cli base +record-list \
    --as "${AS_IDENTITY}" \
    --base-token "${BASE_TOKEN}" \
    --table-id "${TABLE_ID}" \
    --limit "${LIMIT}" \
    --format json
}

# Hard-delete Base row (for smoke/test cleanup or mistaken open). Not soft-close.
cmd_delete() {
  parse_kv "$@"
  require_config
  ensure_state
  local rid tid="${TASK_ID:-}"
  if [[ -n "${RECORD_ID:-}" ]]; then
    rid="${RECORD_ID}"
  elif [[ -n "${tid}" ]]; then
    rid="$(resolve_record_id "${tid}")"
  else
    echo "error: --task-id or --record-id required" >&2
    exit 2
  fi
  if [[ -z "${rid}" ]]; then
    echo "error: no record to delete" >&2
    exit 3
  fi
  lark-cli base +record-delete \
    --as "${AS_IDENTITY}" \
    --base-token "${BASE_TOKEN}" \
    --table-id "${TABLE_ID}" \
    --record-id "${rid}" \
    --yes \
    --format json >/dev/null
  if [[ -n "${tid}" ]]; then
    index_del "${tid}"
  fi
  index_del_by_record "${rid}"
  echo "{\"ok\":true,\"deleted\":true,\"task_id\":\"${tid}\",\"record_id\":\"${rid}\"}"
}

cmd_config() {
  load_env
  python3 - <<PY
import os
bt=os.environ.get("OPENCLAW_TASKS_BASE_TOKEN","")
tid=os.environ.get("OPENCLAW_TASKS_TABLE_ID","")
print("env_file=${ENV_FILE}")
print("base_token_set=", bool(bt), "prefix=", (bt[:6]+"…") if len(bt)>6 else "")
print("table_id_set=", bool(tid), "table_id=", tid if tid else "")
print("lark_as=", os.environ.get("OPENCLAW_TASKS_LARK_AS","bot"))
print("state_dir=${STATE_DIR}")
print("lark_cli=", __import__("shutil").which("lark-cli"))
print("allowed_roots=", os.environ.get("OPENCLAW_TASKS_ALLOWED_ROOTS", "${DEFAULT_ALLOWED_ROOTS}"))
PY
}

require_bins
case "${cmd}" in
  open) cmd_open "$@" ;;
  update) cmd_update "$@" ;;
  confirm) cmd_confirm "$@" ;;
  close) cmd_close "$@" ;;
  show) cmd_show "$@" ;;
  list) cmd_list "$@" ;;
  delete|purge) cmd_delete "$@" ;;
  config) cmd_config "$@" ;;
  ""|-h|--help) usage ;;
  *) echo "unknown command: ${cmd}" >&2; usage; exit 2 ;;
esac
