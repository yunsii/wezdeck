#!/usr/bin/env bash

sync_prompt_language() {
  local locale="${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}"
  if [[ "$locale" =~ ^zh ]]; then
    printf 'zh\n'
  else
    printf 'en\n'
  fi
}

sync_prompt_no_dir_message() {
  local lang="${1:-en}"
  if [[ "$lang" == zh ]]; then
    printf '未检测到任何用户目录。\n'
  else
    printf 'No user directories detected.\n'
  fi
}

sync_prompt_hint_message() {
  local lang="${1:-en}"
  if [[ "$lang" == zh ]]; then
    printf 'Agent CLI 请在确认目标目录后运行 skill 的同步脚本。\n'
  else
    printf 'Agent CLI users should confirm a target and then run the skill sync script.\n'
  fi
}

sync_prompt_input_message() {
  local lang="${1:-en}"
  if [[ "$lang" == zh ]]; then
    printf '输入编号或绝对路径：\n'
  else
    printf 'Enter a choice number or absolute path:\n'
  fi
}

sync_prompt_abs_message() {
  local lang="${1:-en}"
  if [[ "$lang" == zh ]]; then
    printf '路径必须是绝对路径。\n'
  else
    printf 'Path must be absolute.\n'
  fi
}

sync_prompt_missing_message() {
  local lang="${1:-en}"
  if [[ "$lang" == zh ]]; then
    printf '路径不存在。\n'
  else
    printf 'Path does not exist.\n'
  fi
}

sync_prompt_range_message() {
  local lang="${1:-en}"
  if [[ "$lang" == zh ]]; then
    printf '编号越界。\n'
  else
    printf 'Selection out of range.\n'
  fi
}

render_sync_prompt_output() {
  local mode="$1"
  local lang="$2"
  shift 2

  local idx=1
  local dir
  for dir in "$@"; do
    printf '  %d) %s\n' "$idx" "$dir"
    ((idx++))
  done

  case "$mode" in
    tty)
      sync_prompt_input_message "$lang"
      ;;
    non-tty)
      sync_prompt_hint_message "$lang"
      ;;
    *)
      printf 'Unknown mode: %s\n' "$mode" >&2
      return 1
      ;;
  esac
}
