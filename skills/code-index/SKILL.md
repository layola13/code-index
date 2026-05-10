---
name: "code-index"
description: "Use the generated code index under ./.code_index as a code map to inspect repo structure, follow imports or calls, and narrow source reads before editing implementation files."
when_to_use: "Use this as a blocking first step when a code index already exists and the task involves repository analysis, architecture tracing, symbol lookup, dependency follow-up, or locating implementation files. In large repos, use it before broad Grep/Glob scans or repo-wide source reads unless the index is stale or missing."
---

# Code Index

## Instructions
- This is a blocking first step whenever `./.code_index/` already exists and you need repository structure, dependency tracing, symbol lookup, or implementation-file discovery.
- Start with `./.code_index/index/architecture.dot` for the smallest file-level dependency map. Outgoing edges show what a file depends on; incoming edges show likely impact.
- Then use `./.code_index/__index__.py` for entry points, top directories, and high-priority symbols.
- Read `./.code_index/index/summary.md` for a human-readable overview.
- Browse `./.code_index/skeleton/` when you need method-level detail; skeleton functions include concise stub calls instead of full method bodies.
- Treat the code index and skeleton as a code map only. After they identify candidate files, read the original source before asserting implementation details, quoting behavior, or editing code.
- Use `./.code_index/index/modules.jsonl` and `./.code_index/index/symbols.jsonl` only when you need exact module or symbol-level detail.
- In large repositories, you must use this index before broad repo-wide Grep/Glob scans or raw source-file sweeps until the index proves stale or the needed detail is missing.
- If a file is missing from the DOT, no internal file-level dependency edge was resolved for it; jump straight to the skeleton or JSON index.
- The skeleton is valid Python with lightweight call stubs, inheritance, and constructor assignments for easier grep and AST-based lookup.
- The skeleton is not the source of truth for exact logic, syntax, comments, formatting, or language-specific edge cases; confirm against the original files before making precise code claims.
- Only fall back to full source-file reads when the index is stale, missing, or insufficient for the question at hand.
- If the index is stale after edits, rerun `/index`.
