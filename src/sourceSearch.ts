import { discoverSourceFiles } from './indexing/discovery.js'
import { resolveCodeIndexConfig } from './indexing/config.js'
import { computeLineStarts, offsetToLine } from './indexing/parserUtils.js'
import { createYieldState, maybeYieldToEventLoop } from './indexing/runtime.js'
import { readSourceTextForSearch } from './indexing/source.js'
import type { CodeLanguage } from './indexing/ir.js'

type SearchTerm = {
  raw: string
  regex: RegExp
}

export type ParsedSourceSearchQuery = {
  raw: string
  scope?: string
  terms: string[]
}

export type SourceSearchLineMatch = {
  line: number
  context?: Array<{
    line: number
    text: string
  }>
  matchedTerms: string[]
  snippet: string
}

export type SourceSearchFileMatch = {
  language: CodeLanguage
  lineCount: number
  matchCount: number
  path: string
  score: number
  matches: SourceSearchLineMatch[]
  truncated: boolean
}

export type SourceSearchResult = {
  count: number
  hitCount: number
  outputDir: string
  query: ParsedSourceSearchQuery
  rootDir: string
  totalCount: number
  truncated: boolean
  items: SourceSearchFileMatch[]
}

export type SourceSearchOptions = {
  caseSensitive?: boolean
  contextLines?: number
  limit?: number
  outputDir?: string
  excludeGlob?: string[]
  language?: string
  maxLinesPerFile?: number
  query: string
  pathGlob?: string[]
  rootDir?: string
  signal?: AbortSignal
}

const DEFAULT_SOURCE_SEARCH_LIMIT = 10
const DEFAULT_SOURCE_SEARCH_LINE_LIMIT = 4
const SOURCE_SNIPPET_WIDTH = 160

function clampLimit(limit: number | undefined, defaultLimit: number): number {
  if (!Number.isFinite(limit) || !limit || limit < 1) {
    return defaultLimit
  }
  return Math.min(Math.trunc(limit), 1000)
}

function clampContextLines(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined || limit < 0) {
    return 0
  }
  return Math.min(Math.trunc(limit), 20)
}

function normalizeScopePath(value: string): string {
  const normalized = value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/g, '')

  if (!normalized) {
    throw new Error('search scope cannot be empty')
  }

  if (
    normalized.startsWith('/') ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized === '..'
  ) {
    throw new Error(`search scope escapes the repository: ${value}`)
  }

  return normalized
}

function normalizeGlobPattern(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/')
  if (!normalized) {
    throw new Error('glob pattern cannot be empty')
  }
  return normalized
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeGlobPattern(pattern)
  let regex = '^'

  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index] ?? ''
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index++
        if (normalized[index + 1] === '/') {
          index++
          regex += '(?:.*\\/)?'
        } else {
          regex += '.*'
        }
      } else {
        regex += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      regex += '[^/]'
      continue
    }
    regex += escapeRegexLiteral(char)
  }

  regex += '$'
  return new RegExp(regex)
}

function compileGlobMatchers(patterns?: readonly string[]): RegExp[] {
  return (patterns ?? [])
    .map(pattern => pattern.trim())
    .filter(Boolean)
    .map(pattern => globToRegExp(pattern))
}

function matchesAnyGlob(value: string, matchers: readonly RegExp[]): boolean {
  if (matchers.length === 0) {
    return true
  }
  const normalized = value.replaceAll('\\', '/')
  return matchers.some(regex => regex.test(normalized))
}

function splitTopLevelOrClauses(query: string): string[] {
  const segments: string[] = []
  let current = ''
  let escaped = false
  let parenDepth = 0
  let braceDepth = 0
  let bracketDepth = 0

  for (const char of query) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === '\\') {
      current += char
      escaped = true
      continue
    }

    if (char === '[') {
      bracketDepth++
      current += char
      continue
    }

    if (char === ']' && bracketDepth > 0) {
      bracketDepth--
      current += char
      continue
    }

    if (bracketDepth === 0) {
      if (char === '(') {
        parenDepth++
        current += char
        continue
      }

      if (char === ')' && parenDepth > 0) {
        parenDepth--
        current += char
        continue
      }

      if (char === '{') {
        braceDepth++
        current += char
        continue
      }

      if (char === '}' && braceDepth > 0) {
        braceDepth--
        current += char
        continue
      }

      if (char === '|' && parenDepth === 0 && braceDepth === 0) {
        segments.push(current)
        current = ''
        continue
      }
    }

    current += char
  }

  if (escaped) {
    current += '\\'
  }

  segments.push(current)
  return segments
}

function parseScopeFromTail(segment: string): { scope?: string; term: string } {
  const match = segment.match(/^(.*?)(?:\s+in\s+([^\s|]+))\s*$/i)
  if (!match) {
    return { term: segment.trim() }
  }

  const term = (match[1] ?? '').trim()
  const scope = (match[2] ?? '').trim()

  if (!term || !scope) {
    return { term: segment.trim() }
  }

  return {
    scope: normalizeScopePath(scope),
    term,
  }
}

export function parseSourceSearchQuery(query: string): ParsedSourceSearchQuery {
  const raw = query.trim()
  if (!raw) {
    throw new Error('search query cannot be empty')
  }

  const segments = splitTopLevelOrClauses(raw)
  let scope: string | undefined
  const terms: string[] = []

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index] ?? ''
    const isTail = index === segments.length - 1
    if (isTail) {
      const parsedTail = parseScopeFromTail(segment)
      if (parsedTail.scope) {
        scope = parsedTail.scope
      }
      if (parsedTail.term) {
        terms.push(parsedTail.term)
      }
      continue
    }

    const term = segment.trim()
    if (term) {
      terms.push(term)
    }
  }

  if (terms.length === 0) {
    throw new Error('search query cannot be empty')
  }

  return { raw, scope, terms }
}

function compileSearchTerm(term: string, caseSensitive: boolean): SearchTerm {
  try {
    return {
      raw: term,
      regex: new RegExp(term, caseSensitive ? 'gu' : 'giu'),
    }
  } catch (error) {
    throw new Error(
      `invalid search term ${JSON.stringify(term)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function matchesScope(relativePath: string, scope: string): boolean {
  const normalizedPath = relativePath.replaceAll('\\', '/')
  return (
    normalizedPath === scope || normalizedPath.startsWith(`${scope}/`)
  )
}

function getLineBounds(
  lineStarts: readonly number[],
  lineNumber: number,
  textLength: number,
): { end: number; start: number } {
  const start = lineStarts[lineNumber - 1] ?? 0
  const end = lineStarts[lineNumber] ?? textLength
  return { end, start }
}

function buildSnippet(
  lineText: string,
  matchIndexInLine: number,
  matchLength: number,
): string {
  const text = lineText.trimEnd()
  if (text.length <= SOURCE_SNIPPET_WIDTH) {
    return text
  }

  const center = Math.max(0, matchIndexInLine + Math.floor(matchLength / 2))
  const windowSize = SOURCE_SNIPPET_WIDTH - 1
  const start = Math.max(
    0,
    Math.min(
      text.length - windowSize,
      Math.max(0, center - Math.floor(windowSize / 2)),
    ),
  )
  const end = Math.min(text.length, start + windowSize)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

function buildContextWindow(args: {
  contextLines: number
  lines: readonly string[]
  matchedLine: number
}): Array<{
  line: number
  text: string
}> {
  if (args.contextLines <= 0) {
    return []
  }
  const startLine = Math.max(1, args.matchedLine - args.contextLines)
  const endLine = Math.min(args.lines.length, args.matchedLine + args.contextLines)
  const context: Array<{ line: number; text: string }> = []

  for (let line = startLine; line <= endLine; line++) {
    context.push({
      line,
      text: args.lines[line - 1]?.trimEnd() ?? '',
    })
  }

  return context
}

function scoreMatch(args: {
  hitCount: number
  lineCount: number
  termCount: number
  firstLine: number
}): number {
  return args.termCount * 1000 + args.hitCount * 10 - args.firstLine + args.lineCount
}

function finalizeLineHit(hit: {
  line: number
  matchedTerms: Set<string>
  snippet: string
  context: Array<{
    line: number
    text: string
  }>
}): SourceSearchLineMatch {
  const res: SourceSearchLineMatch = {
    line: hit.line,
    matchedTerms: [...hit.matchedTerms].sort((left, right) =>
      left.localeCompare(right),
    ),
    snippet: hit.snippet,
  }
  if (hit.context && hit.context.length > 0) {
    res.context = hit.context
  }
  return res
}

export async function searchSourceFiles(
  options: SourceSearchOptions,
): Promise<SourceSearchResult> {
  const parsed = parseSourceSearchQuery(options.query)
  const caseSensitive = options.caseSensitive ?? false
  const compiledTerms = parsed.terms.map(term =>
    compileSearchTerm(term, caseSensitive),
  )
  const config = resolveCodeIndexConfig({
    rootDir: options.rootDir,
    outputDir: options.outputDir,
  })
  const discovery = await discoverSourceFiles(config)
  const yieldState = createYieldState()
  const limit = clampLimit(options.limit, DEFAULT_SOURCE_SEARCH_LIMIT)
  const maxLinesPerFile = clampLimit(
    options.maxLinesPerFile,
    DEFAULT_SOURCE_SEARCH_LINE_LIMIT,
  )
  const contextLines = clampContextLines(options.contextLines)
  const pathGlobs = compileGlobMatchers(options.pathGlob)
  const excludeGlobs = compileGlobMatchers(options.excludeGlob)
  const language = options.language?.trim().toLowerCase()
  const items: SourceSearchFileMatch[] = []
  let hitCount = 0

  for (const file of discovery.files) {
    options.signal?.throwIfAborted?.()
    await maybeYieldToEventLoop(yieldState)
    options.signal?.throwIfAborted?.()

    if (parsed.scope && !matchesScope(file.relativePath, parsed.scope)) {
      continue
    }
    if (pathGlobs.length > 0 && !matchesAnyGlob(file.relativePath, pathGlobs)) {
      continue
    }
    if (excludeGlobs.length > 0 && matchesAnyGlob(file.relativePath, excludeGlobs)) {
      continue
    }
    if (language && file.language.toLowerCase() !== language) {
      continue
    }

    const text = await readSourceTextForSearch(file.absolutePath)
    options.signal?.throwIfAborted?.()
    const lineStarts = computeLineStarts(text)
    const sourceLines = text.split('\n')
    const lineHits = new Map<
      number,
      {
        line: number
        matchedTerms: Set<string>
        snippet: string
        context: Array<{
          line: number
          text: string
        }>
      }
    >()
    let fileHitCount = 0

    for (const term of compiledTerms) {
      const regex = term.regex
      regex.lastIndex = 0
      for (const match of text.matchAll(regex)) {
        options.signal?.throwIfAborted?.()
        const matchIndex = match.index ?? 0
        const line = offsetToLine(lineStarts, matchIndex)
        const { start, end } = getLineBounds(lineStarts, line, text.length)
        const lineText = text.slice(start, end)
        const existing = lineHits.get(line)
        const matchIndexInLine = matchIndex - start
        const matchLength = match[0]?.length ?? 0

        fileHitCount++
        hitCount++
        if (existing) {
          existing.matchedTerms.add(term.raw)
          existing.context = buildContextWindow({
            contextLines,
            lines: sourceLines,
            matchedLine: line,
          })
          if (existing.snippet.length > SOURCE_SNIPPET_WIDTH) {
            existing.snippet = buildSnippet(
              lineText,
              matchIndexInLine,
              matchLength,
            )
          }
          continue
        }

        lineHits.set(line, {
          line,
          matchedTerms: new Set([term.raw]),
          context: buildContextWindow({
            contextLines,
            lines: sourceLines,
            matchedLine: line,
          }),
          snippet: buildSnippet(lineText, matchIndexInLine, matchLength),
        })
      }
    }

    if (lineHits.size === 0) {
      continue
    }

    const hits = [...lineHits.values()].sort(
      (left, right) => left.line - right.line,
    )
    const displayedLines = hits.slice(0, maxLinesPerFile)
    const truncated = hits.length > displayedLines.length
    const distinctTerms = new Set<string>()
    for (const hit of hits) {
      for (const term of hit.matchedTerms) {
        distinctTerms.add(term)
      }
    }

    items.push({
      language: file.language,
      lineCount: hits.length,
      matchCount: fileHitCount,
      path: file.relativePath,
      score: scoreMatch({
        firstLine: hits[0]?.line ?? Number.MAX_SAFE_INTEGER,
        hitCount: fileHitCount,
        lineCount: hits.length,
        termCount: distinctTerms.size,
      }),
      matches: displayedLines.map(finalizeLineHit),
      truncated,
    })
  }

  items.sort((left, right) => {
    const scoreDelta = right.score - left.score
    if (scoreDelta !== 0) {
      return scoreDelta
    }
    const matchDelta = right.matchCount - left.matchCount
    if (matchDelta !== 0) {
      return matchDelta
    }
    return left.path.localeCompare(right.path)
  })

  const totalCount = items.length
  const selected = items.slice(0, limit)

  return {
    count: selected.length,
    hitCount,
    outputDir: config.outputDir,
    query: parsed,
    rootDir: config.rootDir,
    totalCount,
    truncated: totalCount > selected.length,
    items: selected,
  }
}
