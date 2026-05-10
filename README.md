# Code Index Plugin

Standalone Bun + TypeScript plugin for building and querying a repository code index.

## What it provides

- A CLI for building code indexes into `.code_index`
- An MCP server for querying index artifacts and rebuilding indexes
- Optional Codex lifecycle hooks for refreshing the index on every supported lifecycle event

## Language Support

The indexer has first-class AST parsing for:

- `typescript`
- `tsx`
- `javascript`
- `python`
- `go`
- `rust`
- `java`
- `haxe`
- `c`
- `cpp`
- `zig`

Other extensions still participate through the generic parser, so unsupported languages can still produce usable class/function skeletons and import hints.

If an AST parser or binding fails at runtime, the build falls back to the heuristic parser instead of returning an empty success result.

## Project layout

- `.codex-plugin/plugin.json` - plugin manifest
- `.mcp.json` - MCP server manifest
- `hooks/hooks.json` - plugin hook manifest
- `scripts/run-index-hook.ts` - hook entrypoint
- `src/` - indexing and MCP implementation
- `skills/code-index/SKILL.md` - plugin skill for Codex

## Requirements

- Bun
- Codex with plugin support enabled

## Local install in Codex

This repository is set up as a local plugin under:

`/home/vscode/projects/code-index`

The local marketplace file is:

`/home/vscode/projects/.agents/plugins/marketplace.json`

The plugin entry uses:

`./code-index`

relative to the marketplace root, so Codex resolves it to:

`/home/vscode/projects/code-index`

## Codex config

The Codex home config should include:

```toml
[features]
plugins = true
plugin_hooks = true
hooks = true

[projects."/home/vscode/projects/code-index"]
trust_level = "trusted"

[plugins."code-index@local-projects"]
enabled = true
```

Do not keep a separate global `mcp_servers.code-index` entry once the plugin is enabled. The plugin manifest already contributes the MCP server.

This Codex-specific wiring is only an adapter around the portable core. If you are using another CLI, you can ignore the plugin and talk to the CLI or MCP server directly.

## Hook behavior

The plugin ships hooks for all lifecycle events currently supported by Codex:

- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`
- `SessionStart`
- `UserPromptSubmit`
- `Stop`

Each hook calls the same Bun script:

`bun run "${PLUGIN_ROOT}/scripts/run-index-hook.ts"`

The script:

- reads the hook payload from stdin
- uses the payload `cwd`
- builds the code index into `cwd/.code_index`
- stays silent on stdout

That silence matters because Codex parses hook stdout as structured hook output.

The `PLUGIN_ROOT` placeholder is important. Plugin hooks run from the active session
directory, not from the plugin directory, so relative paths like `scripts/run-index-hook.ts`
will break once the plugin is installed elsewhere.

Keeping the hook file as a thin adapter means the indexer implementation lives in one place:
the Bun/TypeScript project itself. Other CLIs can reuse the CLI or MCP server without copying
any Codex-specific hook wiring.

## MCP usage

Once the plugin is enabled, Codex should expose the plugin MCP server automatically. The MCP server supports:

- `build-index`
- `read-artifact`
- `search-modules`
- `search-symbols`
- `describe-index`

## CLI usage

From the project root:

```bash
bun install
bun run src/cli.ts --help
bun run src/cli.ts build .
bun run src/cli.ts mcp
```

## Hook testing

You can simulate the hook script directly:

```bash
printf '{"cwd":"/some/project"}' | bun run scripts/run-index-hook.ts
```

The hook returns exit code `0` on success and writes only failures to stderr.

## Publishing

To publish this as a reusable plugin:

- keep the plugin root self-contained
- keep `.codex-plugin/plugin.json` present
- keep hook paths relative to the plugin root
- keep MCP config relative to the plugin root
- register the plugin in a marketplace manifest

The current local marketplace file is enough for local testing. A published marketplace would move the same `code-index` plugin entry to a distributable catalog.
