import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { parseSourceSearchQuery, searchSourceFiles } from './sourceSearch.js'

async function createTempRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'code-index-source-search-'))
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content, 'utf8')
  }
  return root
}

describe('source search query parsing', () => {
  it('supports OR terms and trailing scope syntax', () => {
    const parsed = parseSourceSearchQuery(
      'describe\\(|startMcpServer|callTool in src',
    )

    expect(parsed.scope).toBe('src')
    expect(parsed.terms).toEqual([
      'describe\\(',
      'startMcpServer',
      'callTool',
    ])
  })

  it('rejects empty queries', () => {
    expect(() => parseSourceSearchQuery('   ')).toThrow(/cannot be empty/)
  })
})

describe('source search', () => {
  it('searches source text directly with OR terms and scope filtering', async () => {
    const root = await createTempRepo({
      '.code_index/ignored.ts': [
        'export const ignored = "describe("',
        '',
      ].join('\n'),
      'docs/readme.ts': [
        'export const readme = "SearchMode"',
        '',
      ].join('\n'),
      'src/index.ts': [
        'export function describe() {',
        '  return startMcpServer() || callTool()',
        '}',
        '',
      ].join('\n'),
      'src/nested/tools.ts': [
        'export const value = ListToolsRequestSchema',
        'export const other = CallToolRequestSchema',
        'export const words = "tools/list tools/call"',
        '',
      ].join('\n'),
    })

    try {
      const result = await searchSourceFiles({
        query:
          'describe\\(|startMcpServer|ListToolsRequestSchema|CallToolRequestSchema|callTool|tools/list|tools/call in src',
        rootDir: root,
      })

      expect(result.query.scope).toBe('src')
      expect(result.count).toBe(2)
      expect(result.totalCount).toBe(2)
      expect(result.items.map(item => item.path).sort()).toEqual([
        'src/index.ts',
        'src/nested/tools.ts',
      ])

      const byPath = new Map(result.items.map(item => [item.path, item]))
      expect(byPath.get('src/index.ts')?.matches.some(match => match.line === 2)).toBe(true)
      expect(byPath.get('src/nested/tools.ts')?.matches.some(match => match.line === 1)).toBe(true)
      expect(
        byPath
          .get('src/index.ts')
          ?.matches.some(match => match.matchedTerms.includes('callTool')),
      ).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not search ignored generated index directories', async () => {
    const root = await createTempRepo({
      '.code_index/ignored.ts': [
        'export const ignored = "startMcpServer"',
        '',
      ].join('\n'),
      'src/visible.ts': [
        'export const visible = "startMcpServer"',
        '',
      ].join('\n'),
    })

    try {
      const result = await searchSourceFiles({
        query: 'startMcpServer',
        rootDir: root,
      })

      expect(result.items.map(item => item.path)).toEqual(['src/visible.ts'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
