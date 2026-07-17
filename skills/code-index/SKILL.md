---
name: "code-index"
description: "Use the generated code index under ./.code_index as a code map for repository analysis, architecture tracing, symbol lookup, dependency follow-up, and locating implementation files before broad source reads."
---

# Code Index

## Instructions
- This is a blocking first step whenever `./.code_index/` already exists and you need repository structure, dependency tracing, symbol lookup, or implementation-file discovery.
- Never build or refresh an index with `rootDir` set to `~`, `$HOME`, `~/projects`, or `/home/vscode/projects`; use the concrete project directory instead.
- Start with `./.code_index/index/architecture.dot` for the smallest file-level dependency map. Outgoing edges show what a file depends on; incoming edges show likely impact.
- Then use `./.code_index/__index__.py` for entry points, top directories, and high-priority symbols.
- Read `./.code_index/index/summary.md` for a human-readable overview.
- Browse `./.code_index/skeleton/` when you need method-level detail; skeleton functions include concise stub calls instead of full method bodies.
- Treat the code index and skeleton as a code map only. After they identify candidate files, read the original source before asserting implementation details, quoting behavior, or editing code.
- Use `./.code_index/index/modules.jsonl` and `./.code_index/index/symbols.jsonl` only when you need exact module or symbol-level detail.
- Use the dedicated edge and skeleton helpers when available: `search-edges` for incoming/outgoing dependency or call lookups, `get-symbol-source` for symbol snippets and line ranges, and `list-skeletons` / `read-skeleton` for method-level browsing.
- In large repositories, you must use this index before broad repo-wide Grep/Glob scans or raw source-file sweeps until the index proves stale or the needed detail is missing.
- If a file is missing from the DOT, no internal file-level dependency edge was resolved for it; jump straight to the skeleton or JSON index.
- The skeleton is valid Python with lightweight call stubs, inheritance, and constructor assignments for easier grep and AST-based lookup.
- The skeleton is not the source of truth for exact logic, syntax, comments, formatting, or language-specific edge cases; confirm against the original files before making precise code claims.
- Only fall back to full source-file reads when the index is stale, missing, or insufficient for the question at hand.
- If the index is stale after edits, rerun `/index`.

## Build Routing
- Use MCP `build-index` with `engine: "typescript"` by default.
- For very large repositories, Rust/C/C++ monorepos, compiler repositories, or projects where the TypeScript engine is too slow or times out, prefer MCP `build-index` with `engine: "rust"` and `workers: 8`.
- Example Rust-engine rebuild: `{"rootDir": "/path/to/project", "engine": "rust", "workers": 8}`.
- The Rust engine only changes index construction. Continue using the same `search`, `search-modules`, `search-symbols`, `search-edges`, `get-symbol-source`, `list-skeletons`, and `read-skeleton` tools to query the generated `.code_index`.

## Search Routing
- Decide the target type first, then pick exactly one search tool.
- If the target is raw source text inside files, use `code-index` source search.
- If the target is Codex chat history, session transcripts, or rollout JSONL content, use the MCP `search-history` tool.
- If the target is symbol metadata, use `search-symbols`.
- If the target is module metadata, use `search-modules`.
- If the target is a filename, directory name, or approximate path, use Codex file search.
- If the request is ambiguous between content and path, prefer `code-index` source search.
- Never use Codex file search for source content, symbol metadata, or module metadata.

## Decision Order
1. Does the user want to find code text, call sites, config values, string literals, or implementation details? Use `code-index` source search.
2. Does the user want Codex chat history or conversation transcripts? Use `search-history`.
3. Does the user want a class, function, method, qualified name, signature, or kind? Use `search-symbols`.
4. Does the user want module path, language, parse mode, or another index field? Use `search-modules`.
5. Does the user want a filename or folder name, or only an approximate path guess? Use Codex file search.
6. If more than one answer seems possible, choose the earliest matching rule above.

## Fast Heuristics
- Function name, constant, setting, log string, code fragment, quoted source text, or regex-like query such as `A|B|C` -> `code-index` source search.
- Chat history, rollout transcript, or conversation text -> `search-history`.
- Symbol name or qualified symbol -> `search-symbols`.
- Module path or file-level index metadata -> `search-modules`.
- File basename or folder name -> Codex file search.
- Example: `describe\\(|startMcpServer|ListToolsRequestSchema|CallToolRequestSchema|callTool|tools/list|tools/call in src` -> `code-index` source search.
- Example: `src/index.ts` or `bevy` as a project path guess -> Codex file search.
