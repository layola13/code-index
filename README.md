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

From a fresh clone, install this plugin into Codex with:

```bash
bun run plugin:install
```

That script runs:

```bash
codex plugin marketplace add ..
```

这里传的是仓库根目录，不是 `.agents/plugins` 目录本身。Codex 会在这个根目录下自动查找 `.agents/plugins/marketplace.json`。

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

启用插件后，Codex 会自动暴露这个插件的 MCP 服务。当前支持的工具有：

- `search`
- `build-index`
- `read-artifact`
- `search-modules`
- `search-symbols`
- `search-edges`
- `get-symbol-source`
- `list-skeletons`
- `read-skeleton`
- `describe-index`

`search` 直接扫描源代码文本。可以用 `|` 表示多个条件的“或”，也可以在末尾加 `in <scope>` 来限制到仓库内的某个路径前缀。
`search` 还支持 `caseSensitive`、`contextLines`、`pathGlob`、`excludeGlob`、`language` 和 `maxLinesPerFile`。

`search` 适合查代码内容、符号上下文、调用点、配置文本和实现细节。只有在你只想做文件名或目录名的模糊匹配时，才使用 Codex 的文件搜索。

`search-edges` 用于查依赖和调用边，支持 `incoming`、`outgoing` 和 `both`。`get-symbol-source` 会直接返回符号对应的源码片段和行号。`list-skeletons` 与 `read-skeleton` 则用于浏览生成的 `skeleton/` 目录，不用手猜路径。

路由规则：

1. 需要查原始源码文本、调用点、配置值、日志字符串、实现细节，或者像 `A|B|C` 这种多条件查询时，使用 `search`。
2. 需要查符号元数据，比如类名、函数名、方法名、限定名、签名或 kind 时，使用 `search-symbols`。
3. 需要查模块元数据，比如路径、语言、解析模式或其他索引字段时，使用 `search-modules`。
4. 只需要文件名、目录名，或者只是一个大概路径猜测时，使用 Codex file search。
5. 如果一个请求既像内容搜索又像路径搜索，优先选 `search`。

## Source strategy indexing

默认索引只处理 raw 源文件。对于 webpack、esbuild、vite、minified-js 这类产物，索引器会先检测文件特征，再看对应的 source strategy 是否启用：

- 如果文件看起来就是 raw 源码，直接索引。
- 如果文件看起来是 bundle 或压缩产物，只有在启用了对应 `sourceStrategyKinds` 时才会尝试拆分。
- 如果没有启用对应策略，普通 bundle 文件会被跳过。
- 如果文件带有 source map，会直接跳过，不做解压或二次索引。
- 无 sourcemap 的第三方压缩 JS 会自动尝试 `minified-js`，以便生成模块级骨架。

CLI 和 MCP 都支持显式启用策略：

```bash
bun run src/cli.ts build . --source-strategy webpack --source-strategy esbuild
```

默认会扫描当前项目根目录下的 `plugins/` 目录，自动加载其中的 `.codex-plugin/plugin.json`。

如果你要接入仓库外部的第三方策略包，再额外传入插件清单路径：

```bash
bun run src/cli.ts build . \
  --source-strategy external-bundle \
  --source-strategy-plugin-manifest /path/to/plugin/.codex-plugin/plugin.json
```

可用值：

- `auto`
- `webpack`
- `esbuild`
- `vite`
- `minified-js`

`auto` 会启用当前内置策略注册表中的所有可用策略。

MCP 的 `build-index` 工具也接受同样的 `sourceStrategyKinds` 和 `sourceStrategyPluginManifests` 参数。

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
