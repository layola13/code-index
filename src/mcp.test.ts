import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
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
})
