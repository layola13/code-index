import { readFile, stat } from 'fs/promises'
import { resolve, sep } from 'path'

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

function containsText(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

function clampLimit(limit: number | undefined, defaultLimit: number): number {
  if (!Number.isFinite(limit) || !limit || limit < 1) {
    return defaultLimit
  }
  return Math.min(Math.trunc(limit), 1000)
}

export async function searchModules(
  outputDir: string,
  args: {
    language?: string
    limit?: number
    parseMode?: string
    path?: string
    query?: string
  },
): Promise<SearchMatch<ModuleIndexRecord>[]> {
  const modules = await readModuleIndex(outputDir)
  const query = args.query?.trim()
  const path = args.path?.trim()
  const language = args.language?.trim().toLowerCase()
  const parseMode = args.parseMode?.trim().toLowerCase()
  const limit = clampLimit(args.limit, 25)

  const matches = modules
    .map(module => {
      let score = 0
      if (query) {
        const haystack = [
          module.module_id,
          module.path,
          module.lang,
          module.parse_mode,
          ...(module.notes ?? []),
          ...(module.errors ?? []),
        ].join('\n')
        if (!containsText(haystack, query)) {
          return null
        }
        score += haystack.toLowerCase().includes(query.toLowerCase()) ? 1 : 0
      }
      if (path && !containsText(module.path, path)) {
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
  },
): Promise<Array<SearchMatch<SymbolIndexRecord & { module_path?: string }>>> {
  const symbols = await readSymbolIndex(outputDir)
  const modules = await readModuleIndex(outputDir)
  const modulePathById = new Map(modules.map(module => [module.module_id, module.path]))
  const query = args.query?.trim()
  const name = args.name?.trim()
  const path = args.path?.trim()
  const kind = args.kind?.trim().toLowerCase()
  const limit = clampLimit(args.limit, 25)

  const matches = symbols
    .map(symbol => {
      const modulePath = modulePathById.get(symbol.module_id)
      let score = 0

      if (query) {
        const haystack = [
          symbol.symbol_id,
          symbol.module_id,
          symbol.kind,
          symbol.qualified_name,
          symbol.signature,
          modulePath ?? '',
        ].join('\n')
        if (!containsText(haystack, query)) {
          return null
        }
        score += 1
      }

      if (name && !containsText(symbol.qualified_name, name) && !containsText(symbol.signature, name)) {
        return null
      }

      if (path) {
        if (!modulePath || !containsText(modulePath, path)) {
          return null
        }
        if (modulePath.toLowerCase() === path.toLowerCase()) {
          score += 10
        }
      }

      if (kind && symbol.kind.toLowerCase() !== kind) {
        return null
      }

      if (name && containsText(symbol.qualified_name, name)) {
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
      ): match is SearchMatch<SymbolIndexRecord & { module_path?: string }> =>
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
