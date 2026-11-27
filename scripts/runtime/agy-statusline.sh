#!/usr/bin/env bash
# Antigravity CLI (agy) statusLine command.
# Renders model, mode, context usage, and active quota group (5h / 7d used % +
# reset countdown, plus a compact summary of the secondary quota group when
# width allows), and taps the snapshot in the background for wezdeck-wsl.
set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
input=$(cat)

# wezdeck: keep this snapshot (account quotas, context) for the web console;
# in the background so the status line never waits on it.
printf '%s' "$input" | bash "$script_dir/agy-statusline-tap.sh" >/dev/null 2>&1 &

command -v jq >/dev/null 2>&1 || exit 0
[ -n "$input" ] || exit 0

printf '%s' "$input" | jq -r '
  def used_pct(b):
    if (b | type) == "object" and (b.remaining_fraction | type) == "number" then
      (((1 - b.remaining_fraction) * 100) | round
        | if . < 0 then 0 elif . > 100 then 100 else . end)
    else null end;

  def fmt_reset(sec):
    if (sec | type) != "number" or sec <= 0 then ""
    else
      (sec | floor) as $s
      | if $s >= 86400 then
          "\(($s / 86400) | floor)d \((($s % 86400) / 3600) | floor)h"
        elif $s >= 3600 then
          "\(($s / 3600) | floor)h \((($s % 3600) / 60) | floor)m"
        else
          "\((($s + 59) / 60) | floor | if . < 1 then 1 else . end)m"
        end
    end;

  def fmt_win(lbl; b):
    used_pct(b) as $p
    | if $p == null then null
      else
        fmt_reset(b.reset_in_seconds) as $r
        | if $r != "" then "\(lbl):\($p)%(rst:\($r))"
          else "\(lbl):\($p)%" end
      end;

  (.model.display_name // .model.id // "") as $model
  | (.plan_tier // "") as $plan
  | (.cycle_mode // "") as $mode
  | (.terminal_width // 0) as $width
  | (.quota // {}) as $q
  | ($model != "" and (($model | ascii_downcase | contains("gemini")) | not)) as $want_3p
  | (if $want_3p and (($q["3p-5h"] != null) or ($q["3p-weekly"] != null)) then "3p"
     elif ($q["gemini-5h"] != null) or ($q["gemini-weekly"] != null) then "gemini"
     elif ($q["3p-5h"] != null) or ($q["3p-weekly"] != null) then "3p"
     else "" end) as $pri
  | (if $pri == "gemini" then "3p" elif $pri == "3p" then "gemini" else "" end) as $sec
  | (if $sec == "3p" then "3p" else "gem" end) as $sec_lbl
  | [
      (if $plan != "" and $model != "" then "[\($plan)] \($model)"
       elif $model != "" then $model
       elif (.agent_state // "") != "" then "\(.agent_state)…"
       else empty end),
      (if $mode != "" then "[\($mode)]" else empty end),
      (if .sandbox.enabled == true then "[sandbox]" else empty end),
      (if (.context_window.context_window_size // 0) > 0 and (.context_window.used_percentage | type) == "number" then
         "ctx:\(.context_window.used_percentage | round)%"
       else empty end),
      (if $pri != "" then (fmt_win("5h"; $q["\($pri)-5h"]) // empty) else empty end),
      (if $pri != "" then (fmt_win("7d"; $q["\($pri)-weekly"]) // empty) else empty end),
      (if $sec != "" and ($width == 0 or $width >= 95) then
         (used_pct($q["\($sec)-5h"]) as $s5
          | used_pct($q["\($sec)-weekly"]) as $s7
          | if $s5 != null and $s7 != null then "\($sec_lbl):\($s5)%/\($s7)%"
            elif $s5 != null then "\($sec_lbl)5h:\($s5)%"
            elif $s7 != null then "\($sec_lbl)7d:\($s7)%"
            else empty end)
       else empty end)
    ]
  | join("  ")
' 2>/dev/null
