import { readdir, readFile } from 'fs/promises'
import { join, resolve } from 'path'

export type HistorySearchQuery = {
  raw: string
  terms: string[]
}

export type HistorySearchMatch = {
  kind: 'user' | 'assistant'
  line: number
  path: string
  sessionId?: string
  text: string
  ts?: string
}

export type HistorySearchSessionResult = {
  count: number
  hitCount: number
  hits: HistorySearchMatch[]
  path: string
  sessionId?: string
  truncated: boolean
}

export type HistorySearchResult = {
  count: number
  hitCount: number
  outputDir: string
  query: HistorySearchQuery
  rootDir: string
  totalCount: number
  truncated: boolean
  items: HistorySearchSessionResult[]
}

export type HistorySearchOptions = {
  codexHome?: string
  query: string
  limit?: number
  rootDir?: string
  outputDir?: string
  currentSessionId?: string
  signal?: AbortSignal
}

type RolloutFileEntry = {
  path: string
  sessionId?: string
  ts?: string
}

type VisibleRecord = {
  kind: 'user' | 'assistant'
  line: number
  path: string
  sessionId?: string
  source: 'event_msg' | 'response_item'
  text: string
  ts?: string
}

const DEFAULT_HISTORY_SEARCH_LIMIT = 25
const USER_MESSAGE_BEGIN = '## My request for Codex:'

function clampLimit(limit: number | undefined, defaultLimit: number): number {
  if (!Number.isFinite(limit) || !limit || limit < 1) {
    return defaultLimit
  }
  return Math.min(Math.trunc(limit), 1000)
}

function normalizeQuery(query: string): HistorySearchQuery {
  const raw = query.trim()
  if (!raw) {
    throw new Error('search query cannot be empty')
  }

  const terms = raw
    .split('|')
    .map(term => term.trim())
    .filter(Boolean)

  if (terms.length === 0) {
    throw new Error('search query cannot be empty')
  }

  return { raw, terms }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compileTerm(term: string): RegExp {
  return new RegExp(escapeRegExp(term), 'iu')
}

function extractStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (!value || typeof value !== 'object') {
    return []
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => extractStrings(item))
  }

  const record = value as Record<string, unknown>
  const collected: string[] = []
  for (const key of ['text', 'message', 'summary', 'content']) {
    if (key in record) {
      collected.push(...extractStrings(record[key]))
    }
  }
  return collected
}

function stripUserPrefix(text: string): string {
  const idx = text.indexOf(USER_MESSAGE_BEGIN)
  return idx === -1 ? text.trim() : text.slice(idx + USER_MESSAGE_BEGIN.length).trim()
}

function normalizeCodexHome(codexHome?: string): string {
  const fallback = join(process.env.HOME ?? '', '.codex')
  return resolve(codexHome?.trim() ? codexHome : fallback)
}

function parseSessionIdFromFilename(fileName: string): string | undefined {
  const match = fileName.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/)
  return match?.[1]
}

function parseTimestampFromFilename(fileName: string): string | undefined {
  const match = fileName.match(
    /^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-/,
  )
  if (!match) {
    return undefined
  }
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}`
}

async function listRolloutFiles(
  root: string,
  wantedSessionId?: string,
): Promise<RolloutFileEntry[]> {
  try {
    const yearDirs = (await readdir(root, { withFileTypes: true }))
      .filter(dirent => dirent.isDirectory() && /^\d{4}$/.test(dirent.name))
      .map(dirent => dirent.name)
      .sort((left, right) => right.localeCompare(left))

    const files: RolloutFileEntry[] = []
    for (const year of yearDirs) {
      const yearPath = join(root, year)
      const monthDirs = (await readdir(yearPath, { withFileTypes: true }))
        .filter(dirent => dirent.isDirectory() && /^\d{2}$/.test(dirent.name))
        .map(dirent => dirent.name)
        .sort((left, right) => right.localeCompare(left))

      for (const month of monthDirs) {
        const monthPath = join(yearPath, month)
        const dayDirs = (await readdir(monthPath, { withFileTypes: true }))
          .filter(dirent => dirent.isDirectory() && /^\d{2}$/.test(dirent.name))
          .map(dirent => dirent.name)
          .sort((left, right) => right.localeCompare(left))

        for (const day of dayDirs) {
          const dayPath = join(monthPath, day)
          const dayFiles = (await readdir(dayPath, { withFileTypes: true }))
            .filter(
              dirent =>
                dirent.isFile() &&
                dirent.name.startsWith('rollout-') &&
                dirent.name.endsWith('.jsonl'),
            )
            .map(dirent => dirent.name)
            .sort((left, right) => right.localeCompare(left))

          for (const fileName of dayFiles) {
            const sessionId = parseSessionIdFromFilename(fileName)
            if (wantedSessionId && sessionId !== wantedSessionId) {
              continue
            }
            files.push({
              path: join(dayPath, fileName),
              sessionId,
              ts: parseTimestampFromFilename(fileName),
            })
          }
        }
      }
    }

    return files
  } catch (error) {
    const code =
      typeof error === 'object' && error && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined
    if (code === 'ENOENT') {
      return []
    }
    throw error
  }
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function canonicalKindFromEvent(type: string): 'user' | 'assistant' | undefined {
  if (type === 'user_message') {
    return 'user'
  }
  if (type === 'agent_message') {
    return 'assistant'
  }
  return undefined
}

function canonicalKindFromRole(role: string): 'user' | 'assistant' | undefined {
  if (role === 'user') {
    return 'user'
  }
  if (role === 'assistant') {
    return 'assistant'
  }
  return undefined
}

function collectVisibleRecords(
  line: Record<string, unknown>,
  lineNumber: number,
  path: string,
  sessionId?: string,
  ts?: string,
): VisibleRecord[] {
  const type = typeof line.type === 'string' ? line.type : ''
  const payload = line.payload
  if (!payload || typeof payload !== 'object') {
    return []
  }

  const payloadRecord = payload as Record<string, unknown>
  const payloadType = typeof payloadRecord.type === 'string' ? payloadRecord.type : ''

  if (type === 'event_msg') {
    const kind = canonicalKindFromEvent(payloadType)
    if (!kind) {
      return []
    }
    return extractStrings(payloadRecord.message)
      .map(text => (kind === 'user' ? stripUserPrefix(text) : text.trim()))
      .filter(Boolean)
      .map(text => ({
        kind,
        line: lineNumber,
        path,
        sessionId,
        source: 'event_msg' as const,
        text,
        ts,
      }))
  }

  if (type !== 'response_item' || payloadType !== 'message') {
    return []
  }

  const role = typeof payloadRecord.role === 'string' ? payloadRecord.role : ''
  const kind = canonicalKindFromRole(role)
  if (!kind) {
    return []
  }

  return extractStrings(payloadRecord.content)
    .map(text => (kind === 'user' ? stripUserPrefix(text) : text.trim()))
    .filter(Boolean)
    .map(text => ({
      kind,
      line: lineNumber,
      path,
      sessionId,
      source: 'response_item' as const,
      text,
      ts,
    }))
}

function compileVisibleRecords(
  entry: RolloutFileEntry,
  content: string,
): VisibleRecord[] {
  const lines = content.split('\n')
  const records: VisibleRecord[] = []

  for (let index = 0; index < lines.length; index++) {
    const trimmed = (lines[index] ?? '').trim()
    if (!trimmed) {
      continue
    }
    const parsed = parseJsonLine(trimmed)
    if (!parsed) {
      continue
    }
    records.push(
      ...collectVisibleRecords(
        parsed,
        index + 1,
        entry.path,
        entry.sessionId,
        entry.ts,
      ),
    )
  }

  return records
}

function dedupeMirroredRecords(records: readonly VisibleRecord[]): VisibleRecord[] {
  const eventLinesByKey = new Map<string, number[]>()

  for (const record of records) {
    if (record.source !== 'event_msg') {
      continue
    }
    const key = `${record.kind}:${record.text}`
    const lines = eventLinesByKey.get(key) ?? []
    lines.push(record.line)
    eventLinesByKey.set(key, lines)
  }

  return records.filter(record => {
    if (record.source !== 'response_item') {
      return true
    }

    const key = `${record.kind}:${record.text}`
    const eventLines = eventLinesByKey.get(key)
    if (!eventLines) {
      return true
    }

    return !eventLines.some(line => Math.abs(line - record.line) <= 2)
  })
}

function buildSessionHits(
  entry: RolloutFileEntry,
  records: readonly VisibleRecord[],
  compiledTerms: readonly RegExp[],
): HistorySearchMatch[] {
  const hits: HistorySearchMatch[] = []

  for (const record of records) {
    if (!compiledTerms.some(term => term.test(record.text))) {
      continue
    }
    hits.push({
      kind: record.kind,
      line: record.line,
      path: entry.path,
      sessionId: entry.sessionId,
      text: record.text,
      ts: record.ts,
    })
  }

  return hits
}

async function searchEntry(
  entry: RolloutFileEntry,
  compiledTerms: readonly RegExp[],
  signal?: AbortSignal,
): Promise<HistorySearchSessionResult | null> {
  const content = await readFile(entry.path, 'utf8')
  signal?.throwIfAborted?.()

  const parsedRecords = compileVisibleRecords(entry, content)
  const dedupedRecords = dedupeMirroredRecords(parsedRecords)
  const hits = buildSessionHits(entry, dedupedRecords, compiledTerms)

  if (hits.length === 0) {
    return null
  }

  return {
    count: hits.length,
    hitCount: hits.length,
    hits,
    path: entry.path,
    sessionId: entry.sessionId,
    truncated: false,
  }
}

function partitionEntries(
  entries: readonly RolloutFileEntry[],
  currentSessionId?: string,
): {
  current: RolloutFileEntry[]
  others: RolloutFileEntry[]
} {
  if (!currentSessionId) {
    return {
      current: [],
      others: [...entries],
    }
  }

  const current: RolloutFileEntry[] = []
  const others: RolloutFileEntry[] = []
  for (const entry of entries) {
    if (entry.sessionId === currentSessionId) {
      current.push(entry)
    } else {
      others.push(entry)
    }
  }

  return { current, others }
}

async function searchEntries(
  entries: readonly RolloutFileEntry[],
  compiledTerms: readonly RegExp[],
  signal?: AbortSignal,
): Promise<HistorySearchSessionResult[]> {
  const items: HistorySearchSessionResult[] = []

  for (const entry of entries) {
    signal?.throwIfAborted?.()
    const result = await searchEntry(entry, compiledTerms, signal)
    if (!result) {
      continue
    }
    items.push(result)
  }

  return items
}

export async function searchHistoryEntries(
  options: HistorySearchOptions,
): Promise<HistorySearchResult> {
  const query = normalizeQuery(options.query)
  const compiledTerms = query.terms.map(compileTerm)
  const codexHome = normalizeCodexHome(options.codexHome ?? process.env.CODEX_HOME)
  const envCurrentSessionId = process.env.CODEX_THREAD_ID?.trim()
  const currentSessionId =
    options.currentSessionId ?? (envCurrentSessionId ? envCurrentSessionId : undefined)
  const limit = clampLimit(options.limit, DEFAULT_HISTORY_SEARCH_LIMIT)

  const currentResults = await searchEntries(
    [
      ...(await listRolloutFiles(join(codexHome, 'sessions'), currentSessionId)),
      ...(await listRolloutFiles(join(codexHome, 'archived_sessions'), currentSessionId)),
    ],
    compiledTerms,
    options.signal,
  )
  if (currentResults.length > 0) {
    const hitCount = currentResults.reduce((total, item) => total + item.hitCount, 0)
    const selected = currentResults.slice(0, limit)
    return {
      count: selected.length,
      hitCount,
      outputDir: codexHome,
      query,
      rootDir: options.rootDir ?? process.cwd(),
      totalCount: currentResults.length,
      truncated: currentResults.length > selected.length,
      items: selected,
    }
  }

  const sessionsRoot = await listRolloutFiles(join(codexHome, 'sessions'))
  const archivedRoot = await listRolloutFiles(join(codexHome, 'archived_sessions'))
  const entries = [...sessionsRoot, ...archivedRoot]
  const { others } = partitionEntries(entries, currentSessionId)
  const otherResults = await searchEntries(
    others,
    compiledTerms,
    options.signal,
  )
  const hitCount = otherResults.reduce((total, item) => total + item.hitCount, 0)
  const selected = otherResults.slice(0, limit)

  return {
    count: selected.length,
    hitCount,
    outputDir: codexHome,
    query,
    rootDir: options.rootDir ?? process.cwd(),
    totalCount: otherResults.length,
    truncated: otherResults.length > selected.length,
    items: selected,
  }
}
