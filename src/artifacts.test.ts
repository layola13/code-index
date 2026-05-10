import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  searchModules,
  searchSymbols,
  type ModuleIndexRecord,
  type SymbolIndexRecord,
} from './artifacts.js'

async function createTempIndex(
  modules: ModuleIndexRecord[],
  symbols: SymbolIndexRecord[],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'code-index-search-'))
  const indexDir = join(root, 'index')
  await mkdir(indexDir, { recursive: true })
  await writeFile(join(indexDir, 'modules.jsonl'), modules.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf8')
  await writeFile(join(indexDir, 'symbols.jsonl'), symbols.map(s => JSON.stringify(s)).join('\n') + '\n', 'utf8')
  await writeFile(join(indexDir, 'edges.jsonl'), '', 'utf8')
  return root
}

function moduleRecord(overrides: Partial<ModuleIndexRecord> & Pick<ModuleIndexRecord, 'module_id' | 'path'>): ModuleIndexRecord {
  return {
    classes_count: 0,
    errors: [],
    functions_count: 0,
    imports_count: 0,
    lang: 'ts',
    methods_count: 0,
    module_id: overrides.module_id,
    notes: [],
    parse_mode: 'ast-tree-sitter',
    path: overrides.path,
    truncated: false,
    ...overrides,
  }
}

function symbolRecord(
  overrides: Partial<SymbolIndexRecord> & Pick<SymbolIndexRecord, 'kind' | 'module_id' | 'qualified_name' | 'signature' | 'symbol_id'>,
): SymbolIndexRecord {
  return {
    kind: overrides.kind,
    module_id: overrides.module_id,
    qualified_name: overrides.qualified_name,
    signature: overrides.signature,
    source_lines: overrides.source_lines ?? { start: 1, end: 1 },
    symbol_id: overrides.symbol_id,
    ...overrides,
  }
}

describe('search modes', () => {
  it('supports contains, exact, prefix, suffix, and regex modes for modules', async () => {
    const root = await createTempIndex(
      [
        moduleRecord({ module_id: 'a', path: 'src/alpha.ts', lang: 'ts', parse_mode: 'ast-tree-sitter' }),
        moduleRecord({ module_id: 'b', path: 'src/beta.ts', lang: 'ts', parse_mode: 'ast-tree-sitter' }),
        moduleRecord({ module_id: 'c', path: 'docs/ALPHA.md', lang: 'md', parse_mode: 'ast-tree-sitter' }),
      ],
      [],
    )

    await expect(searchModules(root, { query: 'alpha', limit: 10 })).resolves.toHaveLength(2)
    await expect(searchModules(root, { query: 'src/alpha.ts', queryMode: 'exact', limit: 10 })).resolves.toHaveLength(1)
    await expect(searchModules(root, { query: 'src/', queryMode: 'prefix', limit: 10 })).resolves.toHaveLength(2)
    await expect(searchModules(root, { query: '.md', queryMode: 'suffix', limit: 10 })).resolves.toHaveLength(1)
    await expect(searchModules(root, { query: '^docs/.+\\.md$', queryMode: 'regex', limit: 10 })).resolves.toHaveLength(1)
  })

  it('supports contains, exact, prefix, suffix, and regex modes for symbols', async () => {
    const root = await createTempIndex(
      [
        moduleRecord({ module_id: 'a', path: 'src/lib.ts' }),
        moduleRecord({ module_id: 'b', path: 'src/utils.ts' }),
      ],
      [
        symbolRecord({
          kind: 'function',
          module_id: 'a',
          qualified_name: 'alphaBeta',
          signature: 'alphaBeta(): void',
          symbol_id: 'a::alphaBeta',
        }),
        symbolRecord({
          kind: 'function',
          module_id: 'b',
          qualified_name: 'betaGamma',
          signature: 'betaGamma(): void',
          symbol_id: 'b::betaGamma',
        }),
      ],
    )

    await expect(searchSymbols(root, { query: 'alpha', limit: 10 })).resolves.toHaveLength(1)
    await expect(searchSymbols(root, { name: 'alphaBeta', limit: 10 })).resolves.toHaveLength(1)
    await expect(searchSymbols(root, { query: 'alphaBeta', queryMode: 'exact', limit: 10 })).resolves.toHaveLength(1)
    await expect(searchSymbols(root, { query: 'beta', queryMode: 'prefix', limit: 10 })).resolves.toHaveLength(1)
    await expect(searchSymbols(root, { query: 'Gamma', queryMode: 'suffix', limit: 10 })).resolves.toHaveLength(1)
    await expect(searchSymbols(root, { query: '^b::beta.*', queryMode: 'regex', limit: 10 })).resolves.toHaveLength(1)
  })

  it('keeps the default contains mode when queryMode is omitted', async () => {
    const root = await createTempIndex(
      [moduleRecord({ module_id: 'a', path: 'src/alpha.ts' })],
      [],
    )

    const exact = await searchModules(root, { query: 'src/alpha.ts', limit: 10 })
    const contains = await searchModules(root, { query: 'alpha', limit: 10 })

    expect(exact).toHaveLength(1)
    expect(contains).toHaveLength(1)
    expect(exact[0]?.item.path).toBe('src/alpha.ts')
  })

  it('rejects invalid regex queries and unknown modes', async () => {
    const root = await createTempIndex(
      [moduleRecord({ module_id: 'a', path: 'src/alpha.ts' })],
      [symbolRecord({
        kind: 'function',
        module_id: 'a',
        qualified_name: 'alpha',
        signature: 'alpha(): void',
        symbol_id: 'a::alpha',
      })],
    )

    await expect(
      searchModules(root, { query: '(', queryMode: 'regex', limit: 10 }),
    ).rejects.toThrow(/invalid regex query/)
    await expect(
      searchSymbols(root, { query: 'alpha', queryMode: 'bogus', limit: 10 }),
    ).rejects.toThrow(/unsupported queryMode/)
  })
})
