#!/usr/bin/env bash
# NotifyCard extract/render: kind registry + no rule walls + dual channel.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="$ROOT/scripts/session-bridge/notify_card.py"
FMT="$ROOT/scripts/session-bridge/format-need-human.py"

fail() { echo "FAIL: $*" >&2; exit 1; }

claude_choice=$(cat <<'EOF'
────────────────
 ☐ 交付路线
q line here?
❯ 1. Opt A
     detail a
  2. Opt B
     detail b
Enter to select · Esc to cancel
EOF
)

# Legacy wrapper still works
out=$(printf '%s\n' "$claude_choice" | python3 "$FMT" 's:1.1' 'claude-tui')
echo "$out" | grep -q '【交付路线】' || fail title
echo "$out" | grep -q '▶ 1. Opt A' || fail sel
if echo "$out" | grep -q '────'; then fail 'legacy still has rules'; fi

# Claude family extract
card=$(printf '%s\n' "$claude_choice" | python3 "$PY" extract \
  --event need_human --target 's:1.1' --kind claude-tui)
echo "$card" | jq -e '.kind_family == "claude"' >/dev/null || fail family-claude
echo "$card" | jq -e '.options | length == 2' >/dev/null || fail opts
echo "$card" | jq -e '.options[0].selected == true' >/dev/null || fail selected

md=$(printf '%s\n' "$card" | python3 "$PY" render --channel feishu_md)
echo "$md" | grep -q '## 🔔 需要确认' || fail md-head
echo "$md" | grep -q '← 当前' || fail md-sel
if echo "$md" | grep -q '────'; then fail 'md has rules'; fi

poke=$(printf '%s\n' "$card" | python3 "$PY" render --channel poke_text)
echo "$poke" | grep -q '【host-watch · need_human】' || fail poke-frame
echo "$poke" | grep -q '1\*\.Opt A' || fail poke-opt-sel
echo "$poke" | grep -q 'Opt B' || fail poke-opt
if echo "$poke" | grep -q '────'; then fail 'poke has rules'; fi

# Codex permission-ish
codex_ui=$(cat <<'EOF'
Allow running bash command?

  cd /tmp && make test

[y/N]
EOF
)
card_c=$(printf '%s\n' "$codex_ui" | python3 "$PY" extract \
  --event need_human --target 'c:0.0' --kind codex-tui)
echo "$card_c" | jq -e '.kind_family == "codex"' >/dev/null || fail family-codex
# Should not be empty dump of rules
sum_or_q=$(echo "$card_c" | jq -r '
  if (.question|length)>0 then .question
  elif (.title|length)>0 then .title
  else (.summary_lines|join(" "))
  end')
[[ -n "$sum_or_q" ]] || fail codex-empty
echo "$sum_or_q" | grep -qiE 'allow|bash|make' || fail codex-content

# Grok idle: strip chrome + rules
grok_idle=$(cat <<'EOF'
● 已完成配置同步。

────────────────────────────────────────
❯
────────────────────────────────────────
  grok · ctx:12%
EOF
)
card_g=$(printf '%s\n' "$grok_idle" | python3 "$PY" extract \
  --event turn_idle --target 'g:0.1' --kind grok-tui)
echo "$card_g" | jq -e '.kind_family == "grok"' >/dev/null || fail family-grok
echo "$card_g" | jq -e '.summary_lines | length >= 1' >/dev/null || fail grok-sum
if echo "$card_g" | jq -r '.summary_lines[]' | grep -q '────'; then fail grok-rules; fi
md_g=$(printf '%s\n' "$card_g" | python3 "$PY" render --channel feishu_md)
echo "$md_g" | grep -q '回合空闲' || fail grok-md
if echo "$md_g" | grep -q 'pane 尾部'; then fail 'idle still dumps pane tail'; fi

# take / ended without capture
take=$(python3 "$PY" card --event take --target t:0.0 --kind claude-tui \
  --note '吃饭' --extra 'ttl=90m' --channel poke_text)
echo "$take" | grep -q '【host-watch · take】' || fail take-frame
echo "$take" | grep -q '吃饭' || fail take-note

echo "PASS: notify-card (kind registry + dual channel)"
