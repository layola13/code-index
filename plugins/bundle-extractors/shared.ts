import { mkdir, writeFile } from 'fs/promises'
import { basename, join, posix } from 'path'
import { normalizeCommentPath, writeTempChunk } from '../../src/indexing/extractorUtils.js'
import { isGeneratedBundlePath } from '../../src/indexing/sourceStrategyUtils.js'
import type { DiscoveredSourceFile } from '../../src/indexing/discovery.js'
import type { SourceExpansionResult } from '../../src/indexing/strategyTypes.js'

export const DEFAULT_SAMPLE_BYTES = 1000

export function stripTrailingSourceMapComment(text: string): string {
  return text.replace(
    /(?:\n|\r\n?)\s*(?:\/\/[#@]\s*sourceMappingURL=[^\s]+|\/\*#\s*sourceMappingURL=[^*]+\*\/)\s*$/,
    '',
  )
}

export function hasSourceMapComment(text: string): boolean {
  return /(?:\/\/[#@]\s*sourceMappingURL=([^\s]+))|(?:\/\*#\s*sourceMappingURL=([^*]+)\*\/)/m.test(
    text,
  )
}

export function hasInlineSourceMap(text: string): boolean {
  return /sourceMappingURL=data:application\/json/i.test(text)
}

export function normalizeSampleText(sample: {
  headText: string
  tailText: string
}): string {
  if (!sample.headText) {
    return sample.tailText
  }
  if (!sample.tailText) {
    return sample.headText
  }
  return `${sample.headText}\n${sample.tailText}`
}

export function hasBundleMarker(text: string): boolean {
  return (
    /__webpack_require__|webpackBootstrap|\/\*\s*harmony export\s*\*\//.test(text) ||
    /__commonJS|__export|__toESM|__name/.test(text) ||
    /__vitePreload|__vite__|__vite_ssr_import_/.test(text) ||
    /createRequire\s+as\s+_createRequire|fileURLToPath\s+as\s+_fileURLToPath|import\.meta\.url|__filename|__dirname/.test(
      text,
    )
  )
}

export function isLikelyMinifiedText(text: string): boolean {
  const sample = stripTrailingSourceMapComment(text).slice(0, DEFAULT_SAMPLE_BYTES).trim()
  if (!sample || sample.length < 40) {
    return false
  }
  const lineCount = sample.split('\n').length
  if (lineCount > 32) {
    return false
  }
  const whitespaceCount = (sample.match(/\s/g) ?? []).length
  if (whitespaceCount / sample.length > 0.15) {
    return false
  }
  const punctuationCount = (sample.match(/[{}()[\];,:]/g) ?? []).length
  if (punctuationCount / sample.length < 0.08) {
    return false
  }
  if (/^\s*#!/.test(sample)) {
    return true
  }
  const longLineCount = sample.split('\n').filter(line => line.trim().length > 120).length
  if (lineCount > 1 && longLineCount === 0) {
    return false
  }
  return /function\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\(|function\s*\(|=>|var\s+[A-Za-z_$][A-Za-z0-9_$]*=|let\s+[A-Za-z_$][A-Za-z0-9_$]*=|const\s+[A-Za-z_$][A-Za-z0-9_$]*=/.test(
    sample,
  )
}

export function isBundleLikeText(args: {
  relativePath?: string
  text: string
}): boolean {
  if (args.relativePath && isGeneratedBundlePath(args.relativePath)) {
    return true
  }

  const normalized = stripTrailingSourceMapComment(args.text)
  return hasBundleMarker(normalized) || isLikelyMinifiedText(normalized)
}

export function computeLineStarts(text: string): number[] {
  const lineStarts = [0]
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      lineStarts.push(index + 1)
    }
  }
  return lineStarts
}

export function lineAndColumnForOffset(
  lineStarts: readonly number[],
  offset: number,
): { line: number; column: number } {
  let low = 0
  let high = lineStarts.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const value = lineStarts[mid] ?? 0
    if (value <= offset) {
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  const lineIndex = Math.max(0, high)
  const lineStart = lineStarts[lineIndex] ?? 0
  return {
    line: lineIndex + 1,
    column: offset - lineStart + 1,
  }
}

export function leadingWhitespaceColumn(line: string): number {
  let index = 0
  while (index < line.length && /\s/.test(line[index] ?? '')) {
    index++
  }
  return index + 1
}

export function createLeadingPadding(startLine: number, startColumn: number): string {
  return `${'\n'.repeat(Math.max(0, startLine - 1))}${' '.repeat(Math.max(0, startColumn - 1))}`
}

function extractModuleMarkerPath(line: string): string | null {
  const trimmed = line.trim()
  const commentMatch = trimmed.match(/^(?:;?\s*)?\/\/\s*(.+)$/)
  if (!commentMatch?.[1]) {
    return null
  }

  const candidate = commentMatch[1].trim()
  if (!candidate || /sourceMappingURL/i.test(candidate)) {
    return null
  }

  return candidate
}

function extractWebpackModulePath(line: string): string | null {
  const trimmed = line.trim()
  const match =
    trimmed.match(/^\/\*!+\s*(.+?)\s+\*!\/$/) ??
    trimmed.match(/^!\*{3}\s*(.+?)\s+\*{3}!$/)
  if (!match?.[1]) {
    return null
  }

  const candidate = match[1].trim()
  if (!candidate || /webpackBootstrap/i.test(candidate)) {
    return null
  }

  return candidate
}

function isBundleFooterLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) {
    return false
  }

  const normalized = trimmed.replace(/^\/\*+\/?\s*/, '').replace(/^;+\s*/, '')
  return /^\}\)\(\);?$/.test(normalized)
}

function firstNonEmptyLineAfter(lines: readonly string[], startLine: number): number {
  for (let lineIndex = startLine - 1; lineIndex < lines.length; lineIndex++) {
    if ((lines[lineIndex] ?? '').trim()) {
      return lineIndex + 1
    }
  }
  return lines.length + 1
}

function findChunkBounds(args: {
  lines: readonly string[]
  markerLineIndex: number
  nextBoundaryLineIndex: number
}): { endLine: number; startLine: number } | null {
  const startLine = firstNonEmptyLineAfter(args.lines, args.markerLineIndex + 2)
  const endLine = args.nextBoundaryLineIndex
  if (startLine > endLine) {
    return null
  }
  return { endLine, startLine }
}

async function writeChunkExpansion(args: {
  kind: string
  tempRootDir: string
  chunk: {
    absolutePath: string
    originStartCharacter: number
    originStartLine: number
    relativePath: string
    text: string
  }
}): Promise<string> {
  return writeTempChunk({
    tempRootDir: join(args.tempRootDir, args.kind),
    relativePath: args.chunk.relativePath,
    text: args.chunk.text,
  })
}

function createChunkDescriptor(args: {
  bundleRelativePath: string
  candidatePath: string | null
  index: number
  kind: string
  preserveCandidatePath: boolean
  tempRootDir: string
  text: string
  originStartCharacter: number
  originStartLine: number
}): {
  absolutePath: string
  originStartCharacter: number
  originStartLine: number
  relativePath: string
  text: string
} {
  const baseName = basename(args.bundleRelativePath).replace(/\.[^.]+$/, '')
  const candidatePath =
    args.preserveCandidatePath && args.candidatePath ? normalizeCommentPath(args.candidatePath) : ''
  const relativePath = candidatePath
    ? candidatePath
    : posix.join('chunks', `${baseName}-${String(args.index + 1).padStart(3, '0')}.js`)
  return {
    absolutePath: join(args.tempRootDir, args.kind, relativePath),
    originStartCharacter: args.originStartCharacter,
    originStartLine: args.originStartLine,
    relativePath,
    text: args.text,
  }
}

function createChunkText(args: {
  blockLines: readonly string[]
  originStartCharacter: number
  originStartLine: number
}): string {
  const blockText = args.blockLines.join('\n')
  return `${createLeadingPadding(args.originStartLine, args.originStartCharacter)}${blockText}`
}

export async function splitAnnotatedBundleModules(args: {
  bundleRelativePath: string
  bundleText: string
  kind: string
  preserveCandidatePath?: boolean
  tempRootDir: string
}): Promise<SourceExpansionResult> {
  const text = args.bundleText.replace(/\r\n?/g, '\n')
  const lines = text.split('\n')

  const chunks: Array<{
    absolutePath: string
    originStartCharacter: number
    originStartLine: number
    relativePath: string
    text: string
  }> = []

  let currentMarker: { candidatePath: string; lineIndex: number } | null = null

  const finalizeChunk = (nextBoundaryLineIndex: number): void => {
    if (!currentMarker) {
      return
    }

    const bounds = findChunkBounds({
      lines,
      markerLineIndex: currentMarker.lineIndex,
      nextBoundaryLineIndex,
    })
    if (!bounds) {
      currentMarker = null
      return
    }

    const blockLines = lines.slice(bounds.startLine - 1, bounds.endLine)
    if (blockLines.every(line => !line.trim())) {
      currentMarker = null
      return
    }

    const firstContentLine = blockLines.findIndex(blockLine => blockLine.trim() !== '')
    const originStartLine =
      firstContentLine >= 0 ? bounds.startLine + firstContentLine : bounds.startLine
    const originStartCharacter =
      firstContentLine >= 0 ? leadingWhitespaceColumn(blockLines[firstContentLine] ?? '') : 1

    const chunk = createChunkDescriptor({
      bundleRelativePath: args.bundleRelativePath,
      candidatePath: currentMarker.candidatePath,
      index: chunks.length,
      kind: args.kind,
      preserveCandidatePath: args.preserveCandidatePath ?? true,
      tempRootDir: args.tempRootDir,
      text: createChunkText({
        blockLines,
        originStartCharacter,
        originStartLine,
      }),
      originStartCharacter,
      originStartLine,
    })

    chunks.push(chunk)
    currentMarker = null
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? ''
    const candidatePath = extractWebpackModulePath(line) ?? extractModuleMarkerPath(line)
    if (candidatePath) {
      finalizeChunk(lineIndex)
      currentMarker = { candidatePath, lineIndex }
      continue
    }

    if (currentMarker && isBundleFooterLine(line)) {
      finalizeChunk(lineIndex)
    }
  }

  if (currentMarker) {
    finalizeChunk(lines.length)
  }

  if (chunks.length === 0) {
    return {
      cleanupPaths: [],
      units: [],
    }
  }

  await Promise.all(
    chunks.map(async chunk => {
      await writeChunkExpansion({
        kind: args.kind,
        tempRootDir: args.tempRootDir,
        chunk,
      })
    }),
  )

  return {
    cleanupPaths: [join(args.tempRootDir, args.kind)],
    units: chunks.map(chunk => ({
      file: {
        absolutePath: chunk.absolutePath,
        relativePath: chunk.relativePath,
        language: 'javascript',
        originPath: normalizeCommentPath(args.bundleRelativePath) || args.bundleRelativePath,
        originStartCharacter: chunk.originStartCharacter,
        originStartLine: chunk.originStartLine,
      } satisfies DiscoveredSourceFile,
      originFile: {
        absolutePath: args.bundleRelativePath,
        relativePath: args.bundleRelativePath,
        language: 'javascript',
      },
      fingerprintPath: chunk.absolutePath,
      strategyKind: args.kind,
    })),
  }
}
