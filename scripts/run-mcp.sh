#!/bin/sh

script_dir=$(CDPATH= cd "$(dirname "$0")" 2>/dev/null && pwd -P)
plugin_root=$(dirname "$script_dir")
mcp_script="$plugin_root/src/mcp.ts"

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

if [ ! -r "$mcp_script" ]; then
  printf "code-index MCP script not found: %s\n" "$mcp_script" >&2
  exit 1
fi

if ! bun_bin=$(find_bun); then
  printf "code-index MCP requires Bun; tried BUN_BIN, PATH, ~/.bun/bin/bun, /usr/local/bin/bun, /opt/bun/bin/bun\n" >&2
  exit 1
fi

cd "$plugin_root" || exit 1
exec "$bun_bin" run "$mcp_script" "$@"
