import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js'
import { buildCodeIndex } from './indexing/build.js'
import { ensureIndexArtifacts } from './indexing/ensureIndex.js'
import { formatStartupIndexSummary } from './indexing/startupIndex.js'
import {
  getIndexArtifactSummary,
  readArtifactText,
  resolveIndexOutputDir,
  searchModules,
  searchSymbols,
} from './artifacts.js'
import { errorMessage } from './utils/errors.js'

const SERVER_VERSION = '0.1.0'

type ToolDefinition = {
  description: string
  inputSchema: Record<string, unknown>
  name: string
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'build-index',
    description:
      'Build or refresh a code index at the given root directory. Returns the standard code-index artifacts and summary information.',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string', description: 'Project root to index' },
        outputDir: {
          type: 'string',
          description: 'Output directory for generated code-index artifacts',
        },
        maxFiles: {
          type: 'number',
          minimum: 1,
          description: 'Optional maximum number of files to index',
        },
        maxFileBytes: {
          type: 'number',
          minimum: 1,
          description: 'Optional per-file byte limit before truncation',
        },
        workers: {
          type: 'number',
          minimum: 1,
          description: 'Optional number of parse workers to use',
        },
        ignoredDirNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional directory names to ignore during discovery',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read-artifact',
    description:
      'Read a generated code-index artifact from the output directory, such as summary.md, manifest.json, architecture.dot, modules.jsonl, symbols.jsonl, edges.jsonl, or skeleton files.',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: {
          type: 'string',
          description: 'Project root containing the code index',
        },
        outputDir: {
          type: 'string',
          description: 'Output directory for generated code-index artifacts',
        },
        path: {
          type: 'string',
          description: 'Relative path inside the output directory',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search-modules',
    description:
      'Search module records in modules.jsonl by path, language, parse mode, or free-text query.',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        outputDir: { type: 'string' },
        query: { type: 'string' },
        path: { type: 'string' },
        language: { type: 'string' },
        parseMode: { type: 'string' },
        limit: { type: 'number', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search-symbols',
    description:
      'Search symbol records in symbols.jsonl by symbol name, kind, path, or free-text query.',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        outputDir: { type: 'string' },
        query: { type: 'string' },
        name: { type: 'string' },
        kind: { type: 'string' },
        path: { type: 'string' },
        limit: { type: 'number', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'describe-index',
    description:
      'Return a compact summary of the built code index, including manifest counts and the summary artifact content.',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        outputDir: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
]

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  }
}

function textResult(text: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  }
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
  }
}

function getStringArg(
  input: unknown,
  key: string,
): string | undefined {
  if (!input || typeof input !== 'object') {
    return undefined
  }
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function getNumberArg(
  input: unknown,
  key: string,
): number | undefined {
  if (!input || typeof input !== 'object') {
    return undefined
  }
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getStringArrayArg(
  input: unknown,
  key: string,
): string[] | undefined {
  if (!input || typeof input !== 'object') {
    return undefined
  }
  const value = (input as Record<string, unknown>)[key]
  if (!Array.isArray(value)) {
    return undefined
  }
  return value.filter((item): item is string => typeof item === 'string')
}

async function handleBuildIndex(args: unknown): Promise<CallToolResult> {
  const rootDir = getStringArg(args, 'rootDir')
  const outputDir = getStringArg(args, 'outputDir')
  const result = await buildCodeIndex({
    rootDir,
    outputDir,
    maxFiles: getNumberArg(args, 'maxFiles'),
    maxFileBytes: getNumberArg(args, 'maxFileBytes'),
    workers: getNumberArg(args, 'workers'),
    ignoredDirNames: getStringArrayArg(args, 'ignoredDirNames'),
  })

  return jsonResult({
    summary: formatStartupIndexSummary(result),
    result,
  })
}

async function handleReadArtifact(args: unknown): Promise<CallToolResult> {
  const path = getStringArg(args, 'path')
  if (!path) {
    return errorResult('Missing required argument: path')
  }

  const rootDir = getStringArg(args, 'rootDir') ?? process.cwd()
  const outputDir = resolveIndexOutputDir(rootDir, getStringArg(args, 'outputDir'))
  await ensureIndexArtifacts({
    outputDir,
    requiredArtifacts: ['index/manifest.json'],
    rootDir,
  })
  const content = await readArtifactText(outputDir, path)

  return jsonResult({
    content,
    outputDir,
    path,
  })
}

async function handleDescribeIndex(args: unknown): Promise<CallToolResult> {
  const rootDir = getStringArg(args, 'rootDir') ?? process.cwd()
  const outputDir = resolveIndexOutputDir(rootDir, getStringArg(args, 'outputDir'))

  try {
    await ensureIndexArtifacts({
      outputDir,
      requiredArtifacts: [
        'index/manifest.json',
        'index/summary.md',
        'index/modules.jsonl',
        'index/symbols.jsonl',
        'index/edges.jsonl',
      ],
      rootDir,
    })
    const summary = await getIndexArtifactSummary(outputDir)
    const summaryText = await readArtifactText(outputDir, 'index/summary.md')
    const manifestText = await readArtifactText(outputDir, 'index/manifest.json')

    return jsonResult({
      outputDir,
      summary,
      summaryText,
      manifest: JSON.parse(manifestText) as Record<string, unknown>,
    })
  } catch (error) {
    return errorResult(errorMessage(error))
  }
}

async function handleSearchModules(args: unknown): Promise<CallToolResult> {
  const rootDir = getStringArg(args, 'rootDir') ?? process.cwd()
  const outputDir = resolveIndexOutputDir(rootDir, getStringArg(args, 'outputDir'))
  await ensureIndexArtifacts({
    outputDir,
    requiredArtifacts: ['index/manifest.json', 'index/modules.jsonl'],
    rootDir,
  })

  const matches = await searchModules(outputDir, {
    query: getStringArg(args, 'query'),
    path: getStringArg(args, 'path'),
    language: getStringArg(args, 'language'),
    parseMode: getStringArg(args, 'parseMode'),
    limit: getNumberArg(args, 'limit'),
  })

  return jsonResult({
    count: matches.length,
    items: matches,
    outputDir,
  })
}

async function handleSearchSymbols(args: unknown): Promise<CallToolResult> {
  const rootDir = getStringArg(args, 'rootDir') ?? process.cwd()
  const outputDir = resolveIndexOutputDir(rootDir, getStringArg(args, 'outputDir'))
  await ensureIndexArtifacts({
    outputDir,
    requiredArtifacts: [
      'index/manifest.json',
      'index/modules.jsonl',
      'index/symbols.jsonl',
    ],
    rootDir,
  })

  const matches = await searchSymbols(outputDir, {
    query: getStringArg(args, 'query'),
    name: getStringArg(args, 'name'),
    kind: getStringArg(args, 'kind'),
    path: getStringArg(args, 'path'),
    limit: getNumberArg(args, 'limit'),
  })

  return jsonResult({
    count: matches.length,
    items: matches,
    outputDir,
  })
}

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    {
      name: 'code-index',
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
    return {
      tools: TOOLS.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async ({ params }): Promise<CallToolResult> => {
    const { name, arguments: args } = params

    try {
      switch (name) {
        case 'build-index':
          return await handleBuildIndex(args)
        case 'read-artifact':
          return await handleReadArtifact(args)
        case 'search-modules':
          return await handleSearchModules(args)
        case 'search-symbols':
          return await handleSearchSymbols(args)
        case 'describe-index':
          return await handleDescribeIndex(args)
        default:
          return errorResult(`Unknown tool: ${name}`)
      }
    } catch (error) {
      return errorResult(errorMessage(error))
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

if (import.meta.main) {
  await startMcpServer()
}
