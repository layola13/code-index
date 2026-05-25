#!/bin/sh

script_dir=$(CDPATH= cd "$(dirname "$0")" 2>/dev/null && pwd -P)
plugin_root=$(dirname "$script_dir")
ts_script="$plugin_root/scripts/run-index-hook.ts"
log_path="${CODE_INDEX_HOOK_LOG_PATH:-${HOME:-/tmp}/.codex/log/code-index-hook.log}"

log_wrapper() {
  log_dir=$(dirname "$log_path")
  mkdir -p "$log_dir" 2>/dev/null || true
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date 2>/dev/null || printf "unknown-time")
  printf "%s hook-wrapper %s\n" "$timestamp" "$*" >>"$log_path" 2>/dev/null || true
}

find_bun() {
  if [ -n "${BUN_BIN:-}" ] && [ -x "$BUN_BIN" ]; then
    printf "%s\n" "$BUN_BIN"
    return 0
  fi

  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi

  for candidate in "${HOME:-}/.bun/bin/bun" "/usr/local/bin/bun" "/opt/bun/bin/bun"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf "%s\n" "$candidate"
      return 0
    fi
  done

  return 1
}

if [ ! -r "$ts_script" ]; then
  log_wrapper "skip reason=missing-script script=$ts_script"
  exit 0
fi

if ! bun_bin=$(find_bun); then
  log_wrapper "skip reason=bun-not-found script=$ts_script path=${PATH:-}"
  exit 0
fi

"$bun_bin" run "$ts_script" "$@"
status=$?

if [ "$status" -eq 127 ]; then
  log_wrapper "skip reason=bun-exited-127 bun=$bun_bin script=$ts_script"
  exit 0
fi

exit "$status"
