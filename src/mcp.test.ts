import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

async function createTempRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'code-index-mcp-'))
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content, 'utf8')
  }
  return root
}

function parseToolResult<T>(result: {
  content?: Array<{ text?: string; type: string }>
  toolResult?: unknown
  [key: string]: unknown
}): T {
  const text = result.content?.find(
    item => item.type === 'text' && typeof item.text === 'string',
  )?.text
  if (!text) {
    throw new Error('tool result did not include text content')
  }
  return JSON.parse(text) as T
}

describe('mcp server', () => {
  it('registers the history search tool and can search the current Codex session', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'code-index-codex-home-'))
    const currentSession = '019e3f73-30d8-7b52-b0b4-a0a0ea73bc1e'
    await mkdir(join(codexHome, 'sessions', '2026', '05', '19'), { recursive: true })
    await writeFile(
      join(
        codexHome,
        'sessions',
        '2026',
        '05',
        '19',
        `rollout-2026-05-19T16-00-00-${currentSession}.jsonl`,
      ),
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: currentSession, timestamp: '2026-05-19T08:56:14.312Z' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'target phrase current session',
          },
        }),
        '',
      ].join('\n'),
      'utf8',
    )

    const transport = new StdioClientTransport({
      command: 'bun',
      args: ['run', 'src/mcp.ts'],
      cwd: process.cwd(),
      stderr: 'pipe',
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_THREAD_ID: currentSession,
      },
    })
    const client = new Client({
      name: 'code-index-test',
      version: '0.0.0',
    })

    try {
      await client.connect(transport)

      const tools = await client.listTools()
      expect(tools.tools.map(tool => tool.name)).toContain('search-history')

      const result = await client.callTool({
        name: 'search-history',
        arguments: {
          query: 'target phrase current session',
          limit: 5,
        },
      })

      const parsed = parseToolResult<{
        count: number
        items: Array<{ sessionId?: string; hits: Array<{ text: string }> }>
      }>(result)

      expect(parsed.count).toBe(1)
      expect(parsed.items[0]?.sessionId).toBe(currentSession)
      expect(parsed.items[0]?.hits.map(hit => hit.text)).toEqual([
        'target phrase current session',
      ])
    } finally {
      await client.close()
      await transport.close()
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('registers the unified search tool and can execute it over source files', async () => {
    const root = await createTempRepo({
      'src/index.ts': [
        'export function startMcpServer() {',
        '  return callTool("tools/call")',
        '}',
        '',
      ].join('\n'),
      'src/other.ts': [
        'export const tools = [ListToolsRequestSchema, CallToolRequestSchema]',
        '',
      ].join('\n'),
    })

    const transport = new StdioClientTransport({
      command: 'bun',
      args: ['run', 'src/mcp.ts'],
      cwd: process.cwd(),
      stderr: 'pipe',
    })
    const client = new Client({
      name: 'code-index-test',
      version: '0.0.0',
    })

    try {
      await client.connect(transport)

      const tools = await client.listTools()
      expect(tools.tools.map(tool => tool.name)).toContain('search')
      expect(tools.tools.map(tool => tool.name)).toContain('search-modules')

      const result = await client.callTool({
        name: 'search',
        arguments: {
          rootDir: root,
          query:
            'startMcpServer|ListToolsRequestSchema|CallToolRequestSchema|callTool|tools/list|tools/call in src',
          limit: 10,
        },
      })

      const parsed = parseToolResult<{
        count: number
        items: Array<{ path: string }>
        query: { scope?: string }
      }>(result)

      expect(parsed.query.scope).toBe('src')
      expect(parsed.count).toBe(2)
      expect(parsed.items.map(item => item.path)).toEqual([
        'src/index.ts',
        'src/other.ts',
      ])
    } finally {
      await client.close()
      await transport.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('passes source strategy kinds to build-index', async () => {
    const root = await createTempRepo({
      'bundle.js': [
        '/******/ (() => { // webpackBootstrap',
        '/******/  var __webpack_modules__ = {};',
        '/******/  __webpack_require__.d = (exports, definition) => {};',
        '/******/  class BundledValue { value() { return 1 } }',
        '/******/ })();',
        '',
      ].join('\n'),
    })

    const transport = new StdioClientTransport({
      command: 'bun',
      args: ['run', 'src/mcp.ts'],
      cwd: process.cwd(),
      stderr: 'pipe',
    })
    const client = new Client({
      name: 'code-index-test',
      version: '0.0.0',
    })

    try {
      await client.connect(transport)

      const result = await client.callTool({
        name: 'build-index',
        arguments: {
          rootDir: root,
          sourceStrategyKinds: ['webpack'],
        },
      })

      const parsed = parseToolResult<{
        result: { manifest: { moduleCount: number } }
      }>(result)

      expect(parsed.result.manifest.moduleCount).toBe(1)
    } finally {
      await client.close()
      await transport.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('passes source strategy plugin manifests to build-index', async () => {
    const root = await createTempRepo({
      'bundle.js': [
        '/* __external_bundle__ */',
        "console.log('external bundle')",
        '',
      ].join('\n'),
    })
    const pluginRoot = await mkdtemp(join(tmpdir(), 'code-index-mcp-plugin-'))
    await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true })
    await writeFile(
      join(pluginRoot, '.codex-plugin', 'plugin.json'),
      JSON.stringify(
        {
          name: 'mcp-external-bundle-plugin',
          version: '0.0.0',
          sourceStrategyPluginEntry: './index.ts',
        },
        null,
        2,
      ),
      'utf8',
    )
    await writeFile(
      join(pluginRoot, 'index.ts'),
      [
        "export function getSourceStrategyPlugins() {",
        "  return [{",
        "    kind: 'external-bundle',",
        "    detect({ headText, tailText, hasSourceMapComment }) {",
        "      if (hasSourceMapComment) return null",
        "      return `${headText}\\n${tailText}`.includes('__external_bundle__')",
        "        ? { kind: 'external-bundle', confidence: 1, reason: 'external marker' }",
        "        : null",
        "    },",
        "    async expand({ file, tempRootDir }) {",
        "      const { mkdir, writeFile } = await import('fs/promises')",
        "      const { join } = await import('path')",
        "      const tempPath = join(tempRootDir, 'external-bundle', 'chunks', 'external.js')",
        "      await mkdir(join(tempRootDir, 'external-bundle', 'chunks'), { recursive: true })",
        "      await writeFile(tempPath, 'export const externalValue = 123\\n', 'utf8')",
        "      return {",
        "        cleanupPaths: [join(tempRootDir, 'external-bundle')],",
        "        units: [{",
        "          file: {",
        "            absolutePath: tempPath,",
        "            relativePath: 'chunks/external.js',",
        "            language: file.language,",
        "            originPath: file.relativePath,",
        "            originStartLine: 1,",
        "            originStartCharacter: 1,",
        "          },",
        "          originFile: file,",
        "          fingerprintPath: tempPath,",
        "          strategyKind: 'external-bundle',",
        "        }],",
        "      }",
        "    },",
        "  }]",
        "}",
        '',
      ].join('\n'),
      'utf8',
    )

    const transport = new StdioClientTransport({
      command: 'bun',
      args: ['run', 'src/mcp.ts'],
      cwd: process.cwd(),
      stderr: 'pipe',
    })
    const client = new Client({
      name: 'code-index-test',
      version: '0.0.0',
    })

    try {
      await client.connect(transport)

      const result = await client.callTool({
        name: 'build-index',
        arguments: {
          rootDir: root,
          sourceStrategyKinds: ['external-bundle'],
          sourceStrategyPluginManifests: [join(pluginRoot, '.codex-plugin', 'plugin.json')],
        },
      })

      const parsed = parseToolResult<{
        result: { manifest: { moduleCount: number } }
      }>(result)

      expect(parsed.result.manifest.moduleCount).toBe(1)
    } finally {
      await client.close()
      await transport.close()
      await rm(root, { recursive: true, force: true })
      await rm(pluginRoot, { recursive: true, force: true })
    }
  })

  it('passes the rust engine option to build-index', async () => {
    const root = await createTempRepo({
      'src/lib.rs': [
        'pub struct Widget;',
        '',
        'impl Widget {',
        '  pub fn new() -> Self {',
        '    Widget',
        '  }',
        '}',
        '',
      ].join('\n'),
    })

    const transport = new StdioClientTransport({
      command: 'bun',
      args: ['run', 'src/mcp.ts'],
      cwd: process.cwd(),
      stderr: 'pipe',
      env: {
        ...process.env,
        CODE_INDEX_RS_BIN: '/root/projects/code-index-rs/target/release/code-index-rs',
      },
    })
    const client = new Client({
      name: 'code-index-test',
      version: '0.0.0',
    })

    try {
      await client.connect(transport)
      const tools = await client.listTools()
      const buildTool = tools.tools.find(tool => tool.name === 'build-index')
      expect(
        (buildTool?.inputSchema as { properties?: Record<string, unknown> } | undefined)
          ?.properties?.engine,
      ).toBeTruthy()

      const result = await client.callTool({
        name: 'build-index',
        arguments: {
          rootDir: root,
          engine: 'rust',
          workers: 8,
        },
      })

      const parsed = parseToolResult<{
        result: {
          engine: string
          manifest: { moduleCount: number; languages: Record<string, number> }
          parseWorkers: number
          skillsWritten?: boolean
        }
      }>(result)

      expect(parsed.result.engine).toBe('rust')
      expect(parsed.result.parseWorkers).toBe(8)
      expect(parsed.result.skillsWritten).toBe(false)
      expect(parsed.result.manifest.moduleCount).toBe(1)
      expect(parsed.result.manifest.languages.rust).toBe(1)
    } finally {
      await client.close()
      await transport.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('exposes edge, symbol source, and skeleton tools', async () => {
    const root = await createTempRepo({
      'src/a.ts': [
        'export function foo() {',
        '  return 1',
        '}',
        '',
      ].join('\n'),
      'src/b.ts': [
        'import { foo } from "./a"',
        'export function bar() {',
        '  return foo()',
        '}',
        '',
      ].join('\n'),
    })

    const transport = new StdioClientTransport({
      command: 'bun',
      args: ['run', 'src/mcp.ts'],
      cwd: process.cwd(),
      stderr: 'pipe',
    })
    const client = new Client({
      name: 'code-index-test',
      version: '0.0.0',
    })

    try {
      await client.connect(transport)

      const tools = await client.listTools()
      const toolNames = tools.tools.map(tool => tool.name)
      expect(toolNames).toContain('search-edges')
      expect(toolNames).toContain('get-symbol-source')
      expect(toolNames).toContain('list-skeletons')
      expect(toolNames).toContain('read-skeleton')
      const symbolSourceTool = tools.tools.find(
        tool => tool.name === 'get-symbol-source',
      )
      expect(symbolSourceTool?.inputSchema).toBeTruthy()
      expect(
        (symbolSourceTool?.inputSchema as Record<string, unknown> | undefined)?.anyOf,
      ).toBeUndefined()
      expect(
        Object.keys(
          (symbolSourceTool?.inputSchema as {
            properties?: Record<string, unknown>
          } | undefined)?.properties ?? {},
        ),
      ).toEqual(
        expect.arrayContaining(['moduleId', 'path', 'qualifiedName', 'rootDir', 'symbolId']),
      )

      const edges = await client.callTool({
        name: 'search-edges',
        arguments: {
          rootDir: root,
          direction: 'incoming',
          target: 'src/a.ts',
          limit: 10,
        },
      })
      const parsedEdges = parseToolResult<{
        count: number
        items: Array<{ edgeId: string; targetModulePath?: string }>
      }>(edges)
      expect(parsedEdges.count).toBeGreaterThanOrEqual(1)
      expect(parsedEdges.items.some(item => item.targetModulePath === 'src/a.ts')).toBe(true)

      const symbols = await client.callTool({
        name: 'search-symbols',
        arguments: {
          rootDir: root,
          query: 'foo',
          limit: 10,
        },
      })
      const parsedSymbols = parseToolResult<{
        items: Array<{
          item: { module_id: string; qualified_name: string; symbol_id: string }
          score: number
        }>
      }>(symbols)
      const fooSymbol =
        parsedSymbols.items.find(item =>
          item.item.qualified_name.includes('foo'),
        ) ?? parsedSymbols.items[0]
      expect(fooSymbol).toBeTruthy()

      const symbolSource = await client.callTool({
        name: 'get-symbol-source',
        arguments: {
          rootDir: root,
          symbolId: fooSymbol?.item.symbol_id,
        },
      })
      const parsedSymbolSource = parseToolResult<{
        sourcePath: string
        snippet: string
      }>(symbolSource)
      expect(parsedSymbolSource.sourcePath).toBe('src/a.ts')
      expect(parsedSymbolSource.snippet).toContain('export function foo()')

      const listSkeletons = await client.callTool({
        name: 'list-skeletons',
        arguments: {
          rootDir: root,
        },
      })
      const parsedSkeletons = parseToolResult<{
        items: Array<{ path: string }>
      }>(listSkeletons)
      expect(parsedSkeletons.items.some(item => item.path.endsWith('a.py'))).toBe(true)

      const readSkeleton = await client.callTool({
        name: 'read-skeleton',
        arguments: {
          rootDir: root,
          path: 'a',
        },
      })
      const parsedSkeleton = parseToolResult<{
        path: string
        content: string
      }>(readSkeleton)
      expect(parsedSkeleton.path).toContain('skeleton')
      expect(parsedSkeleton.content).toContain('def foo')
    } finally {
      await client.close()
      await transport.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
