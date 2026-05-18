import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getSymbolSource,
  listSkeletons,
  readSkeleton,
  searchEdges,
  searchModules,
  searchSymbols,
  type EdgeIndexRecord,
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

async function createTempArtifactRepo(args: {
  edges?: EdgeIndexRecord[]
  modules: ModuleIndexRecord[]
  skeletons?: Record<string, string>
  sourceFiles?: Record<string, string>
  symbols: SymbolIndexRecord[]
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'code-index-artifacts-'))
  const indexDir = join(root, 'index')
  const skeletonDir = join(root, 'skeleton')
  await mkdir(indexDir, { recursive: true })
  await mkdir(skeletonDir, { recursive: true })
  await writeFile(
    join(indexDir, 'modules.jsonl'),
    args.modules.map(module => JSON.stringify(module)).join('\n') + '\n',
    'utf8',
  )
  await writeFile(
    join(indexDir, 'symbols.jsonl'),
    args.symbols.map(symbol => JSON.stringify(symbol)).join('\n') + '\n',
    'utf8',
  )
  await writeFile(
    join(indexDir, 'edges.jsonl'),
    (args.edges ?? []).map(edge => JSON.stringify(edge)).join('\n') + '\n',
    'utf8',
  )
  await writeFile(join(skeletonDir, '__root__.py'), '...\n', 'utf8')

  for (const [relativePath, content] of Object.entries(args.skeletons ?? {})) {
    const absolutePath = join(skeletonDir, relativePath)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content, 'utf8')
  }

  for (const [relativePath, content] of Object.entries(args.sourceFiles ?? {})) {
    const absolutePath = join(root, relativePath)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content, 'utf8')
  }

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

function edgeRecord(
  overrides: Partial<EdgeIndexRecord> & Pick<EdgeIndexRecord, 'edgeId' | 'kind' | 'source' | 'sourceFile' | 'target'>,
): EdgeIndexRecord {
  return {
    edgeId: overrides.edgeId,
    kind: overrides.kind,
    source: overrides.source,
    sourceFile: overrides.sourceFile,
    target: overrides.target,
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

describe('edge and artifact helpers', () => {
  it('searches edges, resolves symbol source snippets, and reads skeleton files', async () => {
    const root = await createTempArtifactRepo({
      modules: [
        moduleRecord({ module_id: 'a', path: 'src/a.ts', lang: 'ts' }),
        moduleRecord({ module_id: 'b', path: 'src/b.ts', lang: 'ts' }),
      ],
      symbols: [
        symbolRecord({
          kind: 'function',
          module_id: 'a',
          qualified_name: 'a::foo',
          signature: 'foo(): number',
          source_lines: { start: 1, end: 3 },
          symbol_id: 'a::foo',
        }),
        symbolRecord({
          kind: 'function',
          module_id: 'b',
          qualified_name: 'b::bar',
          signature: 'bar(): number',
          source_lines: { start: 1, end: 1 },
          symbol_id: 'b::bar',
        }),
      ],
      edges: [
        edgeRecord({
          edgeId: 'edge-1',
          kind: 'imports',
          source: 'a',
          sourceFile: 'src/a.ts',
          target: './b.ts',
          targetFile: 'src/b.ts',
        }),
        edgeRecord({
          edgeId: 'edge-2',
          kind: 'calls',
          source: 'a::foo',
          sourceFile: 'src/a.ts',
          sourceSymbol: 'a::foo',
          target: 'b::bar',
          targetFile: 'src/b.ts',
          lineStart: 1,
          lineEnd: 3,
        }),
      ],
      skeletons: {
        'src/a.py': 'class A:\n    pass\n',
        'src/nested/b.py': 'def b():\n    ...\n',
      },
      sourceFiles: {
        'src/a.ts': [
          'export function foo() {',
          '  return 1',
          '}',
          '',
        ].join('\n'),
        'src/b.ts': [
          'export function bar() {',
          '  return 2',
          '}',
          '',
        ].join('\n'),
      },
    })

    try {
      const incoming = await searchEdges(root, {
        direction: 'incoming',
        target: 'src/b.ts',
        limit: 10,
      })
      expect(incoming.totalCount).toBe(2)
      expect(incoming.items.map(item => item.edgeId)).toEqual([
        'edge-1',
        'edge-2',
      ])
      expect(incoming.items.every(item => item.targetModulePath === 'src/b.ts')).toBe(true)
      expect(incoming.items.every(item => item.sourceModulePath === 'src/a.ts')).toBe(true)

      const callers = await searchEdges(root, {
        sourceSymbol: 'a::foo',
        limit: 10,
      })
      expect(callers.totalCount).toBe(1)
      expect(callers.items[0]?.edgeId).toBe('edge-2')
      expect(callers.items[0]?.sourceSymbol).toBe('a::foo')

      const symbolSource = await getSymbolSource(root, {
        rootDir: root,
        symbolId: 'a::foo',
      })
      expect(symbolSource.sourcePath).toBe('src/a.ts')
      expect(symbolSource.path).toBe('src/a.ts')
      expect(symbolSource.startLine).toBe(1)
      expect(symbolSource.endLine).toBe(3)
      expect(symbolSource.snippet).toContain('export function foo() {')

      const skeletons = await listSkeletons(root)
      expect(skeletons.map(item => item.path)).toEqual([
        'skeleton/__root__.py',
        'skeleton/src/a.py',
        'skeleton/src/nested/b.py',
      ])

      const skeleton = await readSkeleton(root, { path: 'nested/b' })
      expect(skeleton.path).toBe('skeleton/src/nested/b.py')
      expect(skeleton.content).toContain('def b():')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('searchEdges respects incoming and outgoing direction filtering', async () => {
    const root = await createTempArtifactRepo({
      modules: [
        moduleRecord({ module_id: 'a', path: 'src/a.ts', lang: 'ts' }),
        moduleRecord({ module_id: 'b', path: 'src/b.ts', lang: 'ts' }),
      ],
      symbols: [],
      edges: [
        edgeRecord({
          edgeId: 'edge-1',
          kind: 'imports',
          source: 'a',
          sourceFile: 'src/a.ts',
          target: './b.ts',
          targetFile: 'src/b.ts',
        }),
        edgeRecord({
          edgeId: 'edge-2',
          kind: 'imports',
          source: 'b',
          sourceFile: 'src/b.ts',
          target: './a.ts',
          targetFile: 'src/a.ts',
        }),
      ],
    })

    try {
      const incoming = await searchEdges(root, {
        direction: 'incoming',
        target: 'src/b.ts',
      })
      expect(incoming.items.map(item => item.edgeId)).toEqual(['edge-1'])

      const outgoing = await searchEdges(root, {
        direction: 'outgoing',
        source: 'src/a.ts',
      })
      expect(outgoing.items.map(item => item.edgeId)).toEqual(['edge-1'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
