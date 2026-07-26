import process from 'node:process'
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
  getSymbolSource,
  readArtifactText,
  readSkeleton,
  resolveIndexOutputDir,
  SEARCH_TEXT_MODES,
  listSkeletons,
  searchEdges,
  searchModules,
  searchSymbols,
} from './artifacts.js'
import { errorMessage } from './utils/errors.js'
import { searchHistoryEntries } from './historySearch.js'
import { searchSourceFiles } from './sourceSearch.js'

const SERVER_VERSION = '0.1.1'

type ToolDefinition = {
  description: string
  inputSchema: {
    additionalProperties?: boolean
    anyOf?: Array<Record<string, unknown>>
    properties?: Record<string, object>
    required?: string[]
    type: 'object'
  }
  name: string
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'search',
    description:
      'Search raw source text directly. Use this for code content, symbols in context, call sites, config values, log strings, implementation details, and multi-term pattern queries like A|B|C. To minimize token usage, append "in <scope>" to restrict scope (e.g. "query in src/components") or set limit (default 10) and maxLinesPerFile (default 4). Do not use for filename-only fuzzy matching; use file search for that. Terms are regex patterns. Optional filters: caseSensitive, contextLines, pathGlob, excludeGlob, language, maxLinesPerFile.',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        outputDir: { type: 'string' },
        query: {
          type: 'string',
          description:
            'Regex terms separated by |. Example: describe\\(|startMcpServer|callTool in src',
        },
        limit: {
          type: 'number',
          minimum: 1,
          description: 'Maximum number of files to return',
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Match source terms with exact case instead of lowercasing first',
        },
        contextLines: {
          type: 'number',
          minimum: 0,
          description: 'Number of surrounding lines to include around each hit',
        },
        pathGlob: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional glob filters to include only matching file paths',
        },
        excludeGlob: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional glob filters to exclude matching file paths',
        },
        language: {
          type: 'string',
          description: 'Optional language filter such as typescript, python, or go',
        },
        maxLinesPerFile: {
          type: 'number',
          minimum: 1,
          description: 'Maximum number of distinct matched lines to include per file',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'search-history',
    description:
      'Search Codex chat history across rollout JSONL files under ~/.codex/sessions and ~/.codex/archived_sessions. The current conversation is searched first; if it matches, results are returned immediately without scanning older conversations. Terms are literal text joined with | and match visible user/assistant text only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Literal text terms separated by |.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          description: 'Maximum number of matching conversations to return',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
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
        engine: {
          type: 'string',
          enum: ['typescript', 'rust'],
          description: 'Optional build engine. Defaults to typescript; rust uses code-index-rs for large repositories.',
        },
        ignoredDirNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional directory names to ignore during discovery',
        },
        sourceStrategyKinds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional source strategy kinds to enable, such as webpack, esbuild, vite, or minified-js',
        },
        sourceStrategyPluginManifests: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional source strategy plugin manifest paths to load before indexing',
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
      'Search module records in modules.jsonl by path, language, parse mode, or free-text query. Use this for module-level metadata, not source text. queryMode controls whether query is contains, exact, prefix, suffix, or regex.',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        outputDir: { type: 'string' },
        query: { type: 'string' },
        queryMode: {
          type: 'string',
          enum: [...SEARCH_TEXT_MODES],
        },
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
      'Search symbol records in symbols.jsonl by symbol name, kind, path, or free-text query. Use this for indexed symbol metadata, not raw source text. queryMode controls whether query is contains, exact, prefix, suffix, or regex.',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        outputDir: { type: 'string' },
        query: { type: 'string' },
        queryMode: {
          type: 'string',
          enum: [...SEARCH_TEXT_MODES],
        },
        name: { type: 'string' },
        kind: { type: 'string' },
        path: { type: 'string' },
        limit: { type: 'number', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search-edges',
    description:
      'Search dependency/call edges in edges.jsonl by source, target, kind, symbol, and direction. Use this for incoming/outgoing file and symbol impact lookups without reading the full edge artifact.',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        outputDir: { type: 'string' },
        direction: {
          type: 'string',
          enum: ['incoming', 'outgoing', 'both'],
        },
        kind: { type: 'string' },
        source: { type: 'string' },
        sourceSymbol: { type: 'string' },
        target: { type: 'string' },
        limit: { type: 'number', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get-symbol-source',
    description:
      'Return the snippet for a matched symbol directly from the source artifact, including its line range. Use this after search-symbols to avoid a second manual read. Provide symbolId or qualifiedName, and optionally moduleId or path to narrow the lookup.',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        outputDir: { type: 'string' },
        moduleId: { type: 'string' },
        path: { type: 'string' },
        symbolId: { type: 'string' },
        qualifiedName: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list-skeletons',
    description:
      'List all skeleton files under the generated skeleton/ tree so callers do not need to guess paths.',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        outputDir: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read-skeleton',
    description:
      'Read a skeleton file by fuzzy path match inside the generated skeleton/ tree.',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        outputDir: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['path'],
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

function getStringArg(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') {
    return undefined
  }
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function getNumberArg(input: unknown, key: string): number | undefined {
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

function logLifecycle(event: string, details?: string): void {
  const suffix = details ? ` ${details}` : ''
  console.error(`[code-index:mcp] ${event}${suffix}`)
}

async function handleBuildIndex(
  args: unknown,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const rootDir = getStringArg(args, 'rootDir')
  const outputDir = getStringArg(args, 'outputDir')
  const result = await buildCodeIndex({
    rootDir,
    outputDir,
    engine: getStringArg(args, 'engine') as 'typescript' | 'rust' | undefined,
    maxFiles: getNumberArg(args, 'maxFiles'),
    maxFileBytes: getNumberArg(args, 'maxFileBytes'),
    workers: getNumberArg(args, 'workers'),
    ignoredDirNames: getStringArrayArg(args, 'ignoredDirNames'),
    sourceStrategyPluginManifests: getStringArrayArg(args, 'sourceStrategyPluginManifests'),
    sourceStrategyKinds: getStringArrayArg(args, 'sourceStrategyKinds'),
    signal,
  })

  return jsonResult({
    summary: formatStartupIndexSummary(result),
    result,
  })
}

async function handleReadArtifact(args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
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
    signal,
  })
  const content = await readArtifactText(outputDir, path)

  return jsonResult({
    content,
    outputDir,
    path,
  })
}

async function handleDescribeIndex(args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
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
      signal,
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
    if (signal?.aborted) {
      throw error
    }
    return errorResult(errorMessage(error))
  }
}

async function handleSearch(args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
  const query = getStringArg(args, 'query')
  if (!query) {
    return errorResult('Missing required argument: query')
  }

  const rootDir = getStringArg(args, 'rootDir') ?? process.cwd()
  const outputDir = getStringArg(args, 'outputDir')
  const result = await searchSourceFiles({
    query,
    limit: getNumberArg(args, 'limit'),
    outputDir,
    contextLines: getNumberArg(args, 'contextLines'),
    caseSensitive: (args as Record<string, unknown>)?.caseSensitive === true,
    language: getStringArg(args, 'language'),
    maxLinesPerFile: getNumberArg(args, 'maxLinesPerFile'),
    pathGlob: getStringArrayArg(args, 'pathGlob'),
    excludeGlob: getStringArrayArg(args, 'excludeGlob'),
    rootDir,
    signal,
  })

  return jsonResult(result)
}

async function handleSearchHistory(
  args: unknown,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const query = getStringArg(args, 'query')
  if (!query) {
    return errorResult('Missing required argument: query')
  }

  try {
    const result = await searchHistoryEntries({
      query,
      limit: getNumberArg(args, 'limit'),
      rootDir: getStringArg(args, 'rootDir'),
      outputDir: getStringArg(args, 'outputDir'),
      signal,
    })
    return jsonResult(result)
  } catch (error) {
    return errorResult(errorMessage(error))
  }
}

async function handleSearchModules(args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
  const rootDir = getStringArg(args, 'rootDir') ?? process.cwd()
  const outputDir = resolveIndexOutputDir(rootDir, getStringArg(args, 'outputDir'))
  await ensureIndexArtifacts({
    outputDir,
    requiredArtifacts: ['index/manifest.json', 'index/modules.jsonl'],
    rootDir,
    signal,
  })

  const matches = await searchModules(outputDir, {
    query: getStringArg(args, 'query'),
    queryMode: getStringArg(args, 'queryMode'),
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

async function handleSearchSymbols(args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
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
    signal,
  })

  const matches = await searchSymbols(outputDir, {
    query: getStringArg(args, 'query'),
    queryMode: getStringArg(args, 'queryMode'),
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

async function handleSearchEdges(args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
  const rootDir = getStringArg(args, 'rootDir') ?? process.cwd()
  const outputDir = resolveIndexOutputDir(rootDir, getStringArg(args, 'outputDir'))
  await ensureIndexArtifacts({
    outputDir,
    requiredArtifacts: [
      'index/manifest.json',
      'index/modules.jsonl',
      'index/edges.jsonl',
    ],
    rootDir,
    signal,
  })

  const result = await searchEdges(outputDir, {
    direction: getStringArg(args, 'direction'),
    kind: getStringArg(args, 'kind'),
    source: getStringArg(args, 'source'),
    sourceSymbol: getStringArg(args, 'sourceSymbol'),
    target: getStringArg(args, 'target'),
    limit: getNumberArg(args, 'limit'),
  })

  return jsonResult({
    outputDir,
    ...result,
  })
}

async function handleGetSymbolSource(args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
  const rootDir = getStringArg(args, 'rootDir') ?? process.cwd()
  const outputDir = resolveIndexOutputDir(rootDir, getStringArg(args, 'outputDir'))
  const symbolId = getStringArg(args, 'symbolId')
  const qualifiedName = getStringArg(args, 'qualifiedName')
  if (!symbolId && !qualifiedName) {
    return errorResult('Missing required argument: symbolId or qualifiedName')
  }
  await ensureIndexArtifacts({
    outputDir,
    requiredArtifacts: [
      'index/manifest.json',
      'index/modules.jsonl',
      'index/symbols.jsonl',
    ],
    rootDir,
    signal,
  })

  const result = await getSymbolSource(outputDir, {
    rootDir,
    moduleId: getStringArg(args, 'moduleId'),
    path: getStringArg(args, 'path'),
    symbolId,
    qualifiedName,
  })

  return jsonResult({
    outputDir,
    ...result,
  })
}

async function handleListSkeletons(args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
  const rootDir = getStringArg(args, 'rootDir') ?? process.cwd()
  const outputDir = resolveIndexOutputDir(rootDir, getStringArg(args, 'outputDir'))
  await ensureIndexArtifacts({
    outputDir,
    requiredArtifacts: ['index/manifest.json', 'skeleton/__root__.py'],
    rootDir,
    signal,
  })

  const items = await listSkeletons(outputDir)
  return jsonResult({
    count: items.length,
    items,
    outputDir,
  })
}

async function handleReadSkeleton(args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
  const path = getStringArg(args, 'path')
  if (!path) {
    return errorResult('Missing required argument: path')
  }

  const rootDir = getStringArg(args, 'rootDir') ?? process.cwd()
  const outputDir = resolveIndexOutputDir(rootDir, getStringArg(args, 'outputDir'))
  await ensureIndexArtifacts({
    outputDir,
    requiredArtifacts: ['index/manifest.json', 'skeleton/__root__.py'],
    rootDir,
    signal,
  })

  const item = await readSkeleton(outputDir, { path })
  return jsonResult({
    outputDir,
    ...item,
  })
}

export async function startMcpServer(): Promise<void> {
  logLifecycle('starting')
  let shuttingDown = false
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

  server.onerror = error => {
    logLifecycle('server-error', error instanceof Error ? error.message : String(error))
  }
  server.onclose = () => {
    logLifecycle('server-close')
  }

  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
    return {
      tools: TOOLS.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra): Promise<CallToolResult> => {
    const { name, arguments: args } = params
    logLifecycle('tool-start', `${name} request=${String(extra?.requestId)}`)

    try {
      switch (name) {
        case 'search':
          return await handleSearch(args, extra?.signal)
        case 'search-history':
          return await handleSearchHistory(args, extra?.signal)
        case 'build-index':
          return await handleBuildIndex(args, extra?.signal)
        case 'read-artifact':
          return await handleReadArtifact(args, extra?.signal)
        case 'search-modules':
          return await handleSearchModules(args, extra?.signal)
        case 'search-symbols':
          return await handleSearchSymbols(args, extra?.signal)
        case 'search-edges':
          return await handleSearchEdges(args, extra?.signal)
        case 'get-symbol-source':
          return await handleGetSymbolSource(args, extra?.signal)
        case 'list-skeletons':
          return await handleListSkeletons(args, extra?.signal)
        case 'read-skeleton':
          return await handleReadSkeleton(args, extra?.signal)
        case 'describe-index':
          return await handleDescribeIndex(args, extra?.signal)
        default:
          return errorResult(`Unknown tool: ${name}`)
      }
    } catch (error) {
      const reason = errorMessage(error)
      if (extra?.signal?.aborted) {
        logLifecycle('tool-cancelled', `${name} ${reason}`)
      } else {
        logLifecycle('tool-failed', `${name} ${reason}`)
      }
      return errorResult(reason)
    } finally {
      logLifecycle('tool-finish', `${name} aborted=${Boolean(extra?.signal?.aborted)}`)
    }
  })

  const transport = new StdioServerTransport()
  transport.onclose = () => {
    logLifecycle('stdio-close')
    void shutdown(0, 'stdio-close')
  }
  transport.onerror = error => {
    logLifecycle('stdio-error', error instanceof Error ? error.message : String(error))
  }

  async function shutdown(exitCode: number, reason: string): Promise<void> {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    logLifecycle('shutdown', `${reason} exit=${exitCode}`)
    try {
      await server.close()
    } catch (error) {
      logLifecycle('shutdown-error', error instanceof Error ? error.message : String(error))
    } finally {
      process.exit(exitCode)
    }
  }

  process.once('exit', code => {
    logLifecycle('process-exit', `code=${code}`)
  })
  process.once('SIGINT', () => {
    void shutdown(0, 'SIGINT')
  })
  process.once('SIGTERM', () => {
    void shutdown(0, 'SIGTERM')
  })
  process.once('uncaughtException', error => {
    void shutdown(
      1,
      `uncaughtException ${error instanceof Error ? error.message : String(error)}`,
    )
  })
  process.once('unhandledRejection', reason => {
    void shutdown(
      1,
      `unhandledRejection ${reason instanceof Error ? reason.message : String(reason)}`,
    )
  })

  await server.connect(transport)
  logLifecycle('connected')
}

if (import.meta.main) {
  await startMcpServer()
}
