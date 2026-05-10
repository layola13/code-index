import { mkdir, writeFile } from 'fs/promises'
import { dirname, join, posix, relative } from 'path'

export function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').trim()
}

export function stripLeadingTraversal(value: string): string {
  let normalized = normalizePath(value)
  while (normalized.startsWith('../')) {
    normalized = normalized.slice(3)
  }
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2)
  }
  return normalized
}

export function trimToCommonSourceRoot(value: string): string {
  const normalized = normalizePath(value)
  const segments = ['src', 'lib', 'app', 'packages', 'test', 'tests']

  for (const segment of segments) {
    const marker = `/${segment}/`
    const index = normalized.lastIndexOf(marker)
    if (index >= 0) {
      return normalized.slice(index + 1)
    }
    if (normalized.startsWith(`${segment}/`)) {
      return normalized
    }
  }

  return normalized
}

function normalizeSourceRootAlias(value: string): string {
  return value.replace(/(^|\/)[^/]+-src(?=\/|$)/g, '$1src')
}

export function normalizeCommentPath(value: string): string {
  const normalized = stripLeadingTraversal(normalizePath(value))
  return trimToCommonSourceRoot(normalizeSourceRootAlias(normalized))
}

export function computeLeadingWhitespaceColumn(line: string): number {
  let index = 0
  while (index < line.length && /\s/.test(line[index] ?? '')) {
    index++
  }
  return index + 1
}

export function splitToLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n')
}

export function prefixTextToLine(
  text: string,
  startLine: number,
): string {
  const prefixLines = Math.max(0, startLine - 1)
  return `${'\n'.repeat(prefixLines)}${text}`
}

export async function writeTempChunk(args: {
  tempRootDir: string
  relativePath: string
  text: string
}): Promise<string> {
  const tempPath = join(args.tempRootDir, args.relativePath)
  await mkdir(dirname(tempPath), { recursive: true })
  await writeFile(tempPath, args.text, 'utf8')
  return tempPath
}

export function resolveRelativeChunkPath(args: {
  originalPath: string
  fallbackName: string
  index: number
}): string {
  const normalized = normalizeCommentPath(args.originalPath)
  if (normalized) {
    return normalized
  }
  return posix.join('chunks', `${args.fallbackName}-${args.index + 1}.js`)
}

export function originalRelativePathFromSourcePath(sourcePath: string): string {
  const normalized = normalizeCommentPath(sourcePath)
  if (!normalized) {
    return ''
  }
  return normalized || relative('.', normalized)
}
