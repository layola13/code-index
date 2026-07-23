# code-index-rs

Rust implementation of the `code-index` builder focused on very large repositories.

This project builds the same core `.code_index` artifact layout used by the TypeScript
plugin:

- `.code_index/index/manifest.json`
- `.code_index/index/modules.jsonl`
- `.code_index/index/symbols.jsonl`
- `.code_index/index/edges.jsonl`
- `.code_index/index/summary.md`
- `.code_index/index/architecture.dot`
- `.code_index/skeleton/`
- `.code_index/__index__.py`

## Usage

From the parent `code-index` plugin, prefer the integrated engine switch:

```bash
bun run src/cli.ts build /path/to/project --engine rust --workers 8
```

The Rust engine can also be run directly while developing it:

```bash
cargo build --release
./target/release/code-index-rs build /path/to/project --workers 8
./target/release/code-index-rs describe /path/to/project
```

By default, output is written to the target project's `.code_index` directory.

Useful options:

```bash
./target/release/code-index-rs build /path/to/project \
  --workers 8 \
  --max-files 10000 \
  --max-file-bytes 1048576 \
  --ignore some-large-dir
```

## Current Parser Scope

The first implementation is a native Rust concurrent index builder, not a wrapper
around the Bun/TypeScript implementation.

It uses:

- `ignore` for gitignore-aware parallel discovery
- `rayon` for concurrent source parsing
- heuristic language parsers for Rust, TypeScript/JavaScript, Python, Shell,
  C/C++, Go, Java, Zig, OCaml, Haxe, SAASM, and generic source files

For Rust files it extracts:

- `use` and `mod` imports
- top-level `fn`
- `struct`, `enum`, `trait`, including named and tuple fields
- `impl` blocks merged back into their target type (including trait impls)
- methods inside `impl`, including generic and async signatures
- lightweight call edges

For TypeScript/JavaScript it also recovers exported classes, interfaces, enums,
type aliases, re-export names, and arrow functions. Shell files (`.sh`, `.bash`,
and `.zsh`) recover function declarations, sourced files, top-level variables,
and command-style call hints. Rust and Python multi-line function signatures are
joined before parsing, while module-level imports, re-exports, constants, type
aliases, macros, `__all__` entries, and assignments remain visible as navigation
placeholders.

Skeleton output is a Python navigation representation for every source language.
It includes source metadata, class fields, inherited/implemented bases, static
associated functions, constructor assignments, lightweight call/await/raise stubs,
export-only placeholders, and deterministic disambiguation
when two source files would otherwise map to the same `.py` skeleton path. A
declaration-free source file receives a valid `__module_summary__` instead of a
`# no indexed symbols` marker.

This is intentionally faster and less syntax-complete than tree-sitter. The next
step for parity is adding optional tree-sitter parsing for high-value languages
while keeping the discovery/read/write pipeline native and parallel.

## Real Large-Repo Test

Test target:

`/root/projects/rust`

Command:

```bash
bun run src/cli.ts build /root/projects/rust --engine rust --workers 8
```

Result from a real full rebuild:

- source files discovered: 104,820
- workers: 8
- modules: 104,820
- classes: 178,733
- functions: 411,054
- methods: 83,330
- edges: 2,000,114
- output directory: `/root/projects/rust/.code_index`
- output size: about 1.5G

Timings:

- discovery: 0.74s
- parse: 11.18s
- build edges: 8.19s
- write artifacts: 13.59s
- total: 36.69s

The TypeScript/Bun implementation timed out through MCP on the same repository
before completing a full rebuild. The measured Rust implementation completes the
full build, but write volume is now a major bottleneck because the index contains
large `edges.jsonl`, `symbols.jsonl`, and `skeleton/` artifacts.

## Optimization Notes

The main remaining bottlenecks for giant repositories are no longer source
discovery or parse worker scheduling:

- `edges.jsonl` was about 739 MB for the Rust repository.
- `symbols.jsonl` was about 268 MB.
- `skeleton/` was about 460 MB.
- writing all artifacts took 13.59s in the final integrated test, more than
  edge construction and close to parse time.

Recommended next improvements:

- Add artifact profiles such as `full`, `compact`, and `no-skeleton`.
- Stream edge construction directly to disk or chunked temp files to reduce peak memory.
- Add optional compressed artifacts for very large indexes.
- Add incremental cache keyed by file metadata and content hash.
- Add tree-sitter Rust parsing behind a feature flag for users who prefer richer symbols over speed.
