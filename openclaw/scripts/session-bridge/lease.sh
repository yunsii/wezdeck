#!/usr/bin/env bash
# Temporary remote-control leases (P2). TTL + max_sends + action allowlist.
# shellcheck source=lib.sh
set -euo pipefail

_SB_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$_SB_LIB_DIR/lib.sh"

sb_lease_dir() {
  local d
  d="$(sb_state_dir)/session-bridge-leases"
  mkdir -p "$d"
  printf '%s\n' "$d"
}

sb_default_lease_ttl() {
  local n
  n="$(sb_cfg_get '.defaults.lease_ttl_sec' 2>/dev/null || true)"
  if [[ -z "$n" || "$n" == "null" ]]; then
    n=120
  fi
  printf '%s\n' "$n"
}

sb_now_epoch() {
  date -u +%s
}

sb_iso_from_epoch() {
  date -u -d "@$1" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -r "$1" +"%Y-%m-%dT%H:%M:%SZ"
}

sb_normalize_host_target() {
  # → sess:win.pane (tmux -t form); also keep full id
  local t="$1"
  t="${t#tmux:}"
  printf '%s\n' "$t"
}

sb_lease_path() {
  printf '%s/%s.json\n' "$(sb_lease_dir)" "$1"
}

sb_lease_load() {
  local id="$1"
  local p
  p="$(sb_lease_path "$id")"
  [[ -f "$p" ]] || return 1
  cat "$p"
}

sb_lease_is_valid_json() {
  # stdin: lease json → exit 0 if not expired and sends remaining
  local now
  now="$(sb_now_epoch)"
  jq -e --argjson now "$now" '
    (.expires_at_epoch > $now)
    and ((.sends_used // 0) < (.max_sends // 0))
  ' >/dev/null 2>&1
}

sb_lease_mint() {
  local target="$1"
  local ttl="${2:-}"
  local max_sends="${3:-3}"
  local minted_by="${4:-claw}"
  local note="${5:-}"
  local actions_csv="${6:-send_text,send_enter,approve_if_prompt}"

  sb_require_no_panic

  if [[ -z "$ttl" ]]; then
    ttl="$(sb_default_lease_ttl)"
  fi
  local tmux_target
  tmux_target="$(sb_normalize_host_target "$target")"
  local id now exp
  now="$(sb_now_epoch)"
  exp=$((now + ttl))
  id="lease-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"

  local actions_json
  actions_json="$(printf '%s' "$actions_csv" | tr ',' '\n' | jq -Rsc 'split("\n")|map(select(length>0))')"

  local body
  body="$(jq -nc \
    --arg id "$id" \
    --arg target "$tmux_target" \
    --arg target_raw "$target" \
    --argjson actions "$actions_json" \
    --argjson max_sends "$max_sends" \
    --argjson ttl "$ttl" \
    --argjson now "$now" \
    --argjson exp "$exp" \
    --arg minted_by "$minted_by" \
    --arg note "$note" \
    --arg created "$(sb_now_iso)" \
    --arg expires "$(sb_iso_from_epoch "$exp")" \
    '{
      id: $id,
      target: $target,
      target_raw: $target_raw,
      actions: $actions,
      max_sends: $max_sends,
      sends_used: 0,
      ttl_sec: $ttl,
      created_at: $created,
      created_at_epoch: $now,
      expires_at: $expires,
      expires_at_epoch: $exp,
      minted_by: $minted_by,
      note: $note
    }')"
  printf '%s\n' "$body" >"$(sb_lease_path "$id")"
  sb_audit "lease_mint" "$minted_by" "$tmux_target" "ok" "ttl=$ttl max_sends=$max_sends" "$id"
  jq -nc --argjson lease "$body" '{ok:true, lease:$lease}'
}

sb_lease_status() {
  local id="${1:-}"
  local now
  now="$(sb_now_epoch)"
  if [[ -n "$id" ]]; then
    local p body
    p="$(sb_lease_path "$id")"
    if [[ ! -f "$p" ]]; then
      sb_die 2 "lease 不存在: $id"
    fi
    body="$(cat "$p")"
    local valid=false
    if printf '%s' "$body" | sb_lease_is_valid_json; then
      valid=true
    fi
    jq -nc --argjson lease "$body" --argjson valid "$valid" --argjson now "$now" \
      '{ok:true, lease:$lease, valid:$valid, now_epoch:$now}'
    return 0
  fi
  local arr='[]'
  local f
  shopt -s nullglob
  for f in "$(sb_lease_dir)"/*.json; do
    local body valid=false
    body="$(cat "$f")"
    if printf '%s' "$body" | sb_lease_is_valid_json; then
      valid=true
    fi
    arr="$(jq -c --argjson lease "$body" --argjson valid "$valid" \
      '. + [($lease + {valid:$valid})]' <<<"$arr")"
  done
  shopt -u nullglob
  jq -nc --argjson leases "$arr" --argjson now "$now" \
    '{ok:true, leases:$leases, now_epoch:$now}'
}

sb_lease_revoke() {
  local id="$1"
  local p
  p="$(sb_lease_path "$id")"
  if [[ ! -f "$p" ]]; then
    sb_die 2 "lease 不存在: $id"
  fi
  rm -f "$p"
  sb_audit "lease_revoke" "local" "$id" "ok" "revoked"
  jq -nc --arg id "$id" '{ok:true, revoked:$id}'
}

# Find a valid lease for target that allows action; print lease id or empty
sb_lease_find_for() {
  local target="$1"
  local action="$2"
  local tmux_target preferred="${3:-}"
  tmux_target="$(sb_normalize_host_target "$target")"
  local f body
  if [[ -n "$preferred" ]]; then
    if body="$(sb_lease_load "$preferred" 2>/dev/null)"; then
      if printf '%s' "$body" | jq -e --arg t "$tmux_target" --arg a "$action" '
          (.target == $t)
          and (.actions | index($a) != null)
        ' >/dev/null 2>&1 \
        && printf '%s' "$body" | sb_lease_is_valid_json; then
        printf '%s\n' "$preferred"
        return 0
      fi
    fi
    return 1
  fi
  shopt -s nullglob
  for f in "$(sb_lease_dir)"/*.json; do
    body="$(cat "$f")"
    if printf '%s' "$body" | jq -e --arg t "$tmux_target" --arg a "$action" '
        (.target == $t)
        and (.actions | index($a) != null)
      ' >/dev/null 2>&1 \
      && printf '%s' "$body" | sb_lease_is_valid_json; then
      jq -er '.id' <<<"$body"
      shopt -u nullglob
      return 0
    fi
  done
  shopt -u nullglob
  return 1
}

# Atomically consume one send from a lease. Serialized by a per-lease flock so
# concurrent host-send-keys cannot both read sends_used=0 and each write 1
# (check-then-consume lost update — adversarial-review lease.sh race). Validity
# check + increment + exhaustion-delete all run inside the lock. Callers MUST
# consume BEFORE delivering keystrokes (reserve-then-send) so a raced consume can
# never authorize an extra injection.
sb_lease_consume() {
  local id="$1"
  local p
  p="$(sb_lease_path "$id")"
  [[ -f "$p" ]] || return 1
  (
    flock 9 || exit 1
    body="$(cat "$p" 2>/dev/null)" || exit 1
    printf '%s' "$body" | sb_lease_is_valid_json || exit 1
    body="$(jq -c '.sends_used = ((.sends_used // 0) + 1)' <<<"$body")"
    # atomic replace within the lock
    printf '%s\n' "$body" >"$p.tmp.$$" && mv -f "$p.tmp.$$" "$p"
    used="$(jq -er '.sends_used' <<<"$body")"
    max="$(jq -er '.max_sends' <<<"$body")"
    # auto-delete if exhausted (still under lock)
    if [[ "$used" -ge "$max" ]]; then
      rm -f "$p"
    fi
    printf '%s\n' "$body"
  ) 9>"$p.lock"
}
