import { readFile, readdir, stat } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { readSourceTextForSearch } from './indexing/source.js'

export function resolveIndexOutputDir(
  rootDir: string,
  outputDir?: string,
): string {
  return resolve(rootDir, outputDir ?? '.code_index')
}

function normalizeRelativePath(value: string): string {
  const trimmed = value.trim().replaceAll('\\', '/')
  if (!trimmed) {
    throw new Error('Artifact path cannot be empty')
  }

  const withoutDotPrefix = trimmed.startsWith('./')
    ? trimmed.slice(2)
    : trimmed
  const normalized = withoutDotPrefix.replace(/\/+$/g, '')
  if (!normalized) {
    throw new Error('Artifact path cannot be empty')
  }
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized === '..'
  ) {
    throw new Error(`Artifact path escapes output directory: ${value}`)
  }
  return normalized
}

export function resolveArtifactPath(
  outputDir: string,
  relativePath: string,
): string {
  const normalized = normalizeRelativePath(relativePath)
  const resolvedOutputDir = resolve(outputDir)
  const resolvedPath = resolve(resolvedOutputDir, normalized)
  const outputPrefix = resolvedOutputDir.endsWith(sep)
    ? resolvedOutputDir
    : `${resolvedOutputDir}${sep}`

  if (
    resolvedPath !== resolvedOutputDir &&
    !resolvedPath.startsWith(outputPrefix)
  ) {
    throw new Error(`Artifact path escapes output directory: ${relativePath}`)
  }

  return resolvedPath
}

export async function readArtifactText(
  outputDir: string,
  relativePath: string,
): Promise<string> {
  return readFile(resolveArtifactPath(outputDir, relativePath), 'utf8')
}

export type ModuleIndexRecord = {
  classes_count: number
  errors?: string[]
  functions_count: number
  imports_count: number
  lang: string
  methods_count: number
  module_id: string
  origin_path?: string
  origin_start_character?: number
  origin_start_line?: number
  notes?: string[]
  parse_mode: string
  path: string
  truncated: boolean
}

export type SymbolIndexRecord = {
  kind: 'class' | 'method' | 'function'
  module_id: string
  qualified_name: string
  signature: string
  source_lines: {
    end: number
    start: number
  }
  symbol_id: string
}

export type EdgeIndexRecord = {
  edgeId: string
  kind: string
  lineEnd?: number
  lineStart?: number
  source: string
  sourceFile: string
  sourceSymbol?: string
  target: string
  targetFile?: string
}

export type EdgeSearchDirection = 'incoming' | 'outgoing' | 'both'

export type EdgeSearchRecord = EdgeIndexRecord & {
  sourceModulePath?: string
  targetModulePath?: string
}

export type SymbolSourceRecord = {
  endLine: number
  moduleId: string
  path: string
  qualifiedName: string
  snippet: string
  sourcePath: string
  startLine: number
  symbolId: string
}

export type SkeletonIndexRecord = {
  content?: string
  path: string
}

export type EdgeSearchResult = {
  count: number
  items: EdgeSearchRecord[]
  totalCount: number
}

export type SymbolSourceResult = {
  endLine: number
  moduleId: string
  outputDir: string
  path: string
  qualifiedName: string
  snippet: string
  sourcePath: string
  startLine: number
  symbolId: string
}

async function readJsonLines<T>(
  outputDir: string,
  relativePath: string,
): Promise<T[]> {
  const content = await readArtifactText(outputDir, relativePath)
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T)
}

export async function readModuleIndex(
  outputDir: string,
): Promise<ModuleIndexRecord[]> {
  return readJsonLines<ModuleIndexRecord>(outputDir, 'index/modules.jsonl')
}

export async function readSymbolIndex(
  outputDir: string,
): Promise<SymbolIndexRecord[]> {
  return readJsonLines<SymbolIndexRecord>(outputDir, 'index/symbols.jsonl')
}

export async function readEdgeIndex(
  outputDir: string,
): Promise<EdgeIndexRecord[]> {
  return readJsonLines<EdgeIndexRecord>(outputDir, 'index/edges.jsonl')
}

export type SearchMatch<T> = {
  item: T
  score: number
}

export const SEARCH_TEXT_MODES = [
  'contains',
  'exact',
  'prefix',
  'suffix',
  'regex',
] as const

export type SearchTextMode = (typeof SEARCH_TEXT_MODES)[number]

type SearchTextQuery = {
  caseSensitive: boolean
  mode: SearchTextMode
  text: string
  regex?: RegExp
}

function containsText(
  haystack: string,
  needle: string,
  caseSensitive: boolean,
): boolean {
  return caseSensitive
    ? haystack.includes(needle)
    : haystack.toLowerCase().includes(needle.toLowerCase())
}

function clampLimit(limit: number | undefined, defaultLimit: number): number {
  if (!Number.isFinite(limit) || !limit || limit < 1) {
    return defaultLimit
  }
  return Math.min(Math.trunc(limit), 1000)
}

function normalizeSearchMode(mode?: string): SearchTextMode {
  const normalized = mode?.trim().toLowerCase()
  if (!normalized) {
    return 'contains'
  }
  if ((SEARCH_TEXT_MODES as readonly string[]).includes(normalized)) {
    return normalized as SearchTextMode
  }
  throw new Error(`unsupported queryMode: ${mode}`)
}

function compileRegexQuery(query: string, caseSensitive: boolean): RegExp {
  try {
    return new RegExp(query, caseSensitive ? 'gu' : 'giu')
  } catch (error) {
    throw new Error(
      `invalid regex query ${JSON.stringify(query)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function buildSearchTextQuery(
  query: string | undefined,
  queryMode?: string,
  caseSensitive = false,
): SearchTextQuery | null {
  const mode = normalizeSearchMode(queryMode)
  const text = query?.trim()
  if (!text) {
    return null
  }
  return mode === 'regex'
    ? {
        caseSensitive,
        mode,
        text,
        regex: compileRegexQuery(text, caseSensitive),
      }
    : {
        caseSensitive,
        mode,
        text,
      }
}

function scoreTextField(field: string, query: SearchTextQuery): number {
  const haystack = query.caseSensitive ? field : field.toLowerCase()
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase()

  switch (query.mode) {
    case 'contains':
      return haystack.includes(needle) ? 1 : 0
    case 'exact':
      return haystack === needle ? 4 : 0
    case 'prefix':
      return haystack.startsWith(needle) ? 3 : 0
    case 'suffix':
      return haystack.endsWith(needle) ? 2 : 0
    case 'regex':
      return query.regex?.test(field) ? 1 : 0
  }
}

function normalizeDirection(direction?: string): EdgeSearchDirection {
  const normalized = direction?.trim().toLowerCase()
  if (!normalized || normalized === 'outgoing') {
    return 'outgoing'
  }
  if (normalized === 'incoming' || normalized === 'both') {
    return normalized
  }
  throw new Error(`unsupported direction: ${direction}`)
}

function bestFieldMatchScore(
  fields: readonly string[],
  query: SearchTextQuery,
): number | null {
  let bestScore = 0
  for (const field of fields) {
    if (!field) {
      continue
    }
    bestScore = Math.max(bestScore, scoreTextField(field, query))
  }
  return bestScore > 0 ? bestScore : null
}

function moduleSearchFields(module: ModuleIndexRecord): string[] {
  return [
    module.module_id,
    module.path,
    module.lang,
    module.parse_mode,
    ...(module.notes ?? []),
    ...(module.errors ?? []),
  ]
}

function symbolSearchFields(
  symbol: SymbolIndexRecord,
  modulePath: string | undefined,
): string[] {
  return [
    symbol.symbol_id,
    symbol.module_id,
    symbol.kind,
    symbol.qualified_name,
    symbol.signature,
    modulePath ?? '',
  ]
}

function edgeSearchFields(
  edge: EdgeIndexRecord,
  modulePathById: ReadonlyMap<string, string | undefined>,
): string[] {
  return [
    edge.edgeId,
    edge.kind,
    edge.source,
    edge.sourceFile,
    edge.sourceSymbol ?? '',
    edge.target,
    edge.targetFile ?? '',
    modulePathById.get(edge.source) ?? '',
    modulePathById.get(edge.target) ?? '',
  ]
}

function buildModulePathById(modules: readonly ModuleIndexRecord[]): ReadonlyMap<string, string> {
  return new Map(modules.map(module => [module.module_id, module.path]))
}

function buildSymbolIndexByQualifiedName(
  symbols: readonly SymbolIndexRecord[],
): ReadonlyMap<string, SymbolIndexRecord> {
  return new Map(symbols.map(symbol => [symbol.qualified_name, symbol]))
}

function buildSymbolIndexById(
  symbols: readonly SymbolIndexRecord[],
): ReadonlyMap<string, SymbolIndexRecord> {
  return new Map(symbols.map(symbol => [symbol.symbol_id, symbol]))
}

function normalizeSymbolQueryValue(value: string | undefined): string {
  return value?.trim().replaceAll('\\', '/').toLowerCase() ?? ''
}

function normalizeArtifactSearchValue(value: string): string {
  return value.trim().replaceAll('\\', '/').toLowerCase()
}

function resolveSymbolSourcePath(
  symbol: SymbolIndexRecord,
  modulePathById: ReadonlyMap<string, string>,
  moduleById: ReadonlyMap<string, ModuleIndexRecord>,
): string | null {
  const module = moduleById.get(symbol.module_id)
  if (!module) {
    return null
  }

  return (
    module.origin_path ??
    module.path ??
    modulePathById.get(symbol.module_id) ??
    null
  )
}

function resolveSourceFilePath(rootDir: string, sourcePath: string): string {
  return resolve(rootDir, sourcePath)
}

function sliceSourceByLineRange(content: string, startLine: number, endLine: number): string {
  const lines = content.split('\n')
  return lines.slice(Math.max(0, startLine - 1), Math.max(0, endLine)).join('\n')
}

function matchTextFilter(
  value: string | undefined,
  query: SearchTextQuery | null,
): number | null {
  if (!query) {
    return 0
  }
  if (!value) {
    return null
  }
  return scoreTextField(value, query) > 0 ? scoreTextField(value, query) : null
}

function matchTextFilters(
  values: readonly string[],
  query: SearchTextQuery | null,
): number | null {
  if (!query) {
    return 0
  }
  let bestScore = 0
  for (const value of values) {
    if (!value) {
      continue
    }
    bestScore = Math.max(bestScore, scoreTextField(value, query))
  }
  return bestScore > 0 ? bestScore : null
}

export async function searchModules(
  outputDir: string,
  args: {
    language?: string
    limit?: number
    parseMode?: string
    path?: string
    query?: string
    queryMode?: string
  },
): Promise<SearchMatch<ModuleIndexRecord>[]> {
  const modules = await readModuleIndex(outputDir)
  const query = buildSearchTextQuery(args.query, args.queryMode)
  const path = args.path?.trim()
  const language = args.language?.trim().toLowerCase()
  const parseMode = args.parseMode?.trim().toLowerCase()
  const limit = clampLimit(args.limit, 25)

  const matches = modules
    .map(module => {
      let score = 0
      if (query) {
        const queryScore = bestFieldMatchScore(moduleSearchFields(module), query)
        if (queryScore === null) {
          return null
        }
        score += queryScore
      }
      if (path && !containsText(module.path, path, false)) {
        return null
      }
      if (language && module.lang.toLowerCase() !== language) {
        return null
      }
      if (parseMode && module.parse_mode.toLowerCase() !== parseMode) {
        return null
      }
      if (path && module.path.toLowerCase() === path.toLowerCase()) {
        score += 10
      }
      return {
        item: module,
        score,
      }
    })
    .filter((match): match is SearchMatch<ModuleIndexRecord> => Boolean(match))
    .sort((left, right) => {
      const scoreDelta = right.score - left.score
      if (scoreDelta !== 0) {
        return scoreDelta
      }
      return left.item.path.localeCompare(right.item.path)
    })

  return matches.slice(0, limit)
}

export async function searchSymbols(
  outputDir: string,
  args: {
    kind?: string
    limit?: number
    name?: string
    path?: string
    query?: string
    queryMode?: string
  },
): Promise<Array<SearchMatch<SymbolIndexRecord & { module_path: string | undefined }>>> {
  const symbols = await readSymbolIndex(outputDir)
  const modules = await readModuleIndex(outputDir)
  const modulePathById = new Map(modules.map(module => [module.module_id, module.path]))
  const query = buildSearchTextQuery(args.query, args.queryMode)
  const name = args.name?.trim()
  const path = args.path?.trim()
  const kind = args.kind?.trim().toLowerCase()
  const limit = clampLimit(args.limit, 25)

  const matches = symbols
    .map(symbol => {
      const modulePath = modulePathById.get(symbol.module_id)
      let score = 0

      if (query) {
        const queryScore = bestFieldMatchScore(
          symbolSearchFields(symbol, modulePath),
          query,
        )
        if (queryScore === null) {
          return null
        }
        score += queryScore
      }

      if (
        name &&
        !containsText(symbol.qualified_name, name, false) &&
        !containsText(symbol.signature, name, false)
      ) {
        return null
      }

      if (path) {
        if (!modulePath || !containsText(modulePath, path, false)) {
          return null
        }
        if (modulePath.toLowerCase() === path.toLowerCase()) {
          score += 10
        }
      }

      if (kind && symbol.kind.toLowerCase() !== kind) {
        return null
      }

      if (name && containsText(symbol.qualified_name, name, false)) {
        score += 5
      }

      return {
        item: {
          ...symbol,
          module_path: modulePath,
        },
        score,
      }
    })
    .filter(
      (
        match,
      ): match is SearchMatch<
        SymbolIndexRecord & { module_path: string | undefined }
      > =>
        Boolean(match),
    )
    .sort((left, right) => {
      const scoreDelta = right.score - left.score
      if (scoreDelta !== 0) {
        return scoreDelta
      }
      return left.item.qualified_name.localeCompare(right.item.qualified_name)
    })

  return matches.slice(0, limit)
}

function normalizeEdgeSourceFields(edge: EdgeIndexRecord): string[] {
  return [
    edge.source,
    edge.sourceFile,
    edge.sourceSymbol ?? '',
  ]
}

function normalizeEdgeTargetFields(edge: EdgeIndexRecord): string[] {
  return [
    edge.target,
    edge.targetFile ?? '',
  ]
}

function buildEdgeMatchScore(args: {
  edge: EdgeIndexRecord
  direction: EdgeSearchDirection
  kindQuery: SearchTextQuery | null
  sourceQuery: SearchTextQuery | null
  targetQuery: SearchTextQuery | null
  modulePathById: ReadonlyMap<string, string>
}): number | null {
  const edge = args.edge
  let score = 0
  const includeSource = args.direction !== 'incoming'
  const includeTarget = args.direction !== 'outgoing'

  if (args.kindQuery) {
    const kindScore = scoreTextField(edge.kind, args.kindQuery)
    if (kindScore === 0) {
      return null
    }
    score += kindScore
  }

  if (args.sourceQuery) {
    if (!includeSource) {
      return null
    }
    const sourceScore = bestFieldMatchScore(
      normalizeEdgeSourceFields(edge),
      args.sourceQuery,
    )
    if (sourceScore === null) {
      return null
    }
    score += sourceScore
  }

  if (args.targetQuery) {
    if (!includeTarget) {
      return null
    }
    const targetFields = [
      ...normalizeEdgeTargetFields(edge),
      args.modulePathById.get(edge.target) ?? '',
    ]
    const targetScore = bestFieldMatchScore(targetFields, args.targetQuery)
    if (targetScore === null) {
      return null
    }
    score += targetScore
  }

  return score
}

export async function searchEdges(
  outputDir: string,
  args: {
    direction?: string
    kind?: string
    limit?: number
    source?: string
    sourceSymbol?: string
    target?: string
  },
): Promise<EdgeSearchResult> {
  const edges = await readEdgeIndex(outputDir)
  const modules = await readModuleIndex(outputDir)
  const modulePathById = buildModulePathById(modules)
  const direction = normalizeDirection(args.direction)
  const kindQuery = buildSearchTextQuery(args.kind, 'contains')
  const sourceQuery = buildSearchTextQuery(args.source, 'contains')
  const targetQuery = buildSearchTextQuery(args.target, 'contains')
  const sourceSymbolQuery = buildSearchTextQuery(args.sourceSymbol, 'contains')
  const limit = clampLimit(args.limit, 25)

  const matches = edges
    .map(edge => {
      const targetPath = edge.targetFile ?? modulePathById.get(edge.target)
      const item: EdgeSearchRecord = {
        ...edge,
        sourceModulePath: modulePathById.get(edge.source) ?? edge.sourceFile,
        targetModulePath: targetPath,
      }
      let score = buildEdgeMatchScore({
        edge,
        direction,
        kindQuery,
        modulePathById,
        sourceQuery,
        targetQuery,
      })

      if (score === null) {
        return null
      }

      if (sourceSymbolQuery) {
        const sourceSymbolScore = edge.sourceSymbol
          ? scoreTextField(edge.sourceSymbol, sourceSymbolQuery)
          : 0
        if (sourceSymbolScore === 0) {
          return null
        }
        score += sourceSymbolScore
      }

      return {
        item,
        score,
      }
    })
    .filter((match): match is SearchMatch<EdgeSearchRecord> => Boolean(match))
    .sort((left, right) => {
      const scoreDelta = right.score - left.score
      if (scoreDelta !== 0) {
        return scoreDelta
      }
      return left.item.edgeId.localeCompare(right.item.edgeId)
    })

  return {
    count: Math.min(limit, matches.length),
    items: matches.slice(0, limit).map(match => match.item),
    totalCount: matches.length,
  }
}

export async function listSkeletons(
  outputDir: string,
): Promise<Array<{ path: string }>> {
  async function walk(relativeDir: string): Promise<Array<{ path: string }>> {
    const absoluteDir = resolveArtifactPath(outputDir, relativeDir)
    const entries = await readdir(absoluteDir, { withFileTypes: true })
    const items: Array<{ path: string }> = []
    for (const entry of entries) {
      const childRelative = relativeDir ? join(relativeDir, entry.name) : entry.name
      if (entry.isDirectory()) {
        items.push(...(await walk(childRelative)))
        continue
      }
      if (entry.isFile() && childRelative.replaceAll('\\', '/').endsWith('.py')) {
        items.push({ path: childRelative.replaceAll('\\', '/') })
      }
    }
    return items
  }

  return (await walk('skeleton')).sort((left, right) =>
    left.path.localeCompare(right.path),
  )
}

export async function readSkeleton(
  outputDir: string,
  args: {
    path?: string
  },
): Promise<SkeletonIndexRecord> {
  const query = normalizeSymbolQueryValue(args.path)
  if (!query) {
    throw new Error('skeleton path cannot be empty')
  }

  const skeletons = await listSkeletons(outputDir)
  const match = skeletons.find(item => normalizeArtifactSearchValue(item.path).includes(query))
  if (!match) {
    throw new Error(`skeleton not found: ${args.path}`)
  }

  return {
    path: match.path,
    content: await readArtifactText(outputDir, match.path),
  }
}

export async function getSymbolSource(
  outputDir: string,
  args: {
    rootDir?: string
    moduleId?: string
    path?: string
    symbolId?: string
    qualifiedName?: string
  },
): Promise<SymbolSourceResult> {
  const modules = await readModuleIndex(outputDir)
  const moduleById = new Map(modules.map(module => [module.module_id, module]))
  const modulePathById = buildModulePathById(modules)
  const symbols = await readSymbolIndex(outputDir)
  const byQualifiedName = buildSymbolIndexByQualifiedName(symbols)
  const byId = buildSymbolIndexById(symbols)

  const selectedSymbol =
    (args.symbolId ? byId.get(args.symbolId) : undefined) ??
    (args.qualifiedName ? byQualifiedName.get(args.qualifiedName) : undefined)
  if (!selectedSymbol) {
    throw new Error('symbol not found')
  }

  if (args.moduleId && selectedSymbol.module_id !== args.moduleId) {
    throw new Error('symbol not found in module')
  }

  const module = moduleById.get(selectedSymbol.module_id)
  if (!module) {
    throw new Error('module not found for symbol')
  }

  if (args.path && module.path !== args.path) {
    throw new Error('symbol not found at path')
  }

  const sourcePath = resolveSymbolSourcePath(selectedSymbol, modulePathById, moduleById)
  if (!sourcePath) {
    throw new Error('source path unavailable for symbol')
  }

  const sourceRoot = args.rootDir ?? resolve(outputDir, '..')
  const content = await readSourceTextForSearch(resolve(sourceRoot, sourcePath))
  const startLine = selectedSymbol.source_lines.start
  const endLine = selectedSymbol.source_lines.end
  const snippet = sliceSourceByLineRange(content, startLine, endLine)

  return {
    endLine,
    moduleId: selectedSymbol.module_id,
    outputDir,
    path: module.path,
    qualifiedName: selectedSymbol.qualified_name,
    snippet,
    sourcePath,
    startLine,
    symbolId: selectedSymbol.symbol_id,
  }
}

export type IndexArtifactSummary = {
  edgeCount: number
  moduleCount: number
  outputDir: string
  symbolCount: number
}

export async function getIndexArtifactSummary(
  outputDir: string,
): Promise<IndexArtifactSummary> {
  const modules = await readModuleIndex(outputDir)
  const symbols = await readSymbolIndex(outputDir)
  const edges = await readEdgeIndex(outputDir)
  return {
    edgeCount: edges.length,
    moduleCount: modules.length,
    outputDir,
    symbolCount: symbols.length,
  }
}
