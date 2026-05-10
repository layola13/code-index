export type ParsedIndexArgs =
  | {
      kind: 'help'
    }
  | {
      kind: 'error'
      message: string
    }
  | {
      kind: 'run'
      ignoredDirNames?: string[]
      maxFiles?: number
      maxFileBytes?: number
      outputDir?: string
      rootDir: string
      sourceStrategyPluginManifests?: string[]
      sourceStrategyKinds?: string[]
      workers?: number
    }

export function tokenizeIndexArgs(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (const char of input.trim()) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }

    if (char === '\\') {
      escaping = true
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}

export function parseIndexArgs(input: string): ParsedIndexArgs {
  const tokens = tokenizeIndexArgs(input)
  if (tokens[0] === 'build') {
    tokens.shift()
  }

  let rootDir = '.'
  const ignoredDirNames: string[] = []
  let maxFiles: number | undefined
  let outputDir: string | undefined
  let maxFileBytes: number | undefined
  const sourceStrategyPluginManifests: string[] = []
  const sourceStrategyKinds: string[] = []
  let workers: number | undefined

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? ''

    if (token === '--help' || token === '-h') {
      return { kind: 'help' }
    }

    if (token.startsWith('--output=')) {
      outputDir = token.slice('--output='.length)
      if (!outputDir) {
        return {
          kind: 'error',
          message: 'Missing value for --output.',
        }
      }
      continue
    }

    if (token === '--output' || token === '-o') {
      outputDir = tokens[index + 1]
      if (!outputDir) {
        return {
          kind: 'error',
          message: 'Missing value for --output.',
        }
      }
      index++
      continue
    }

    if (token.startsWith('--max-file-bytes=')) {
      const rawValue = token.slice('--max-file-bytes='.length)
      const parsed = Number.parseInt(rawValue, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return {
          kind: 'error',
          message: `Invalid --max-file-bytes value: ${rawValue}`,
        }
      }
      maxFileBytes = parsed
      continue
    }

    if (token === '--max-file-bytes') {
      const rawValue = tokens[index + 1]
      const parsed = Number.parseInt(rawValue ?? '', 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return {
          kind: 'error',
          message: `Invalid --max-file-bytes value: ${rawValue ?? ''}`,
        }
      }
      maxFileBytes = parsed
      index++
      continue
    }

    if (token.startsWith('--max-files=')) {
      const rawValue = token.slice('--max-files='.length)
      const parsed = Number.parseInt(rawValue, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return {
          kind: 'error',
          message: `Invalid --max-files value: ${rawValue}`,
        }
      }
      maxFiles = parsed
      continue
    }

    if (token === '--max-files') {
      const rawValue = tokens[index + 1]
      const parsed = Number.parseInt(rawValue ?? '', 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return {
          kind: 'error',
          message: `Invalid --max-files value: ${rawValue ?? ''}`,
        }
      }
      maxFiles = parsed
      index++
      continue
    }

    if (token.startsWith('--workers=')) {
      const rawValue = token.slice('--workers='.length)
      const parsed = Number.parseInt(rawValue, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return {
          kind: 'error',
          message: `Invalid --workers value: ${rawValue}`,
        }
      }
      workers = parsed
      continue
    }

    if (token === '--workers') {
      const rawValue = tokens[index + 1]
      const parsed = Number.parseInt(rawValue ?? '', 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return {
          kind: 'error',
          message: `Invalid --workers value: ${rawValue ?? ''}`,
        }
      }
      workers = parsed
      index++
      continue
    }

    if (token.startsWith('--ignore-dir=')) {
      const ignoredDir = token.slice('--ignore-dir='.length).trim()
      if (!ignoredDir) {
        return {
          kind: 'error',
          message: 'Missing value for --ignore-dir.',
        }
      }
      ignoredDirNames.push(ignoredDir)
      continue
    }

    if (token.startsWith('--source-strategy=')) {
      const strategy = token.slice('--source-strategy='.length).trim()
      if (!strategy) {
        return {
          kind: 'error',
          message: 'Missing value for --source-strategy.',
        }
      }
      sourceStrategyKinds.push(strategy)
      continue
    }

    if (token.startsWith('--source-strategy-plugin-manifest=')) {
      const manifestPath = token
        .slice('--source-strategy-plugin-manifest='.length)
        .trim()
      if (!manifestPath) {
        return {
          kind: 'error',
          message: 'Missing value for --source-strategy-plugin-manifest.',
        }
      }
      sourceStrategyPluginManifests.push(manifestPath)
      continue
    }

    if (token === '--source-strategy') {
      const strategy = tokens[index + 1]?.trim()
      if (!strategy) {
        return {
          kind: 'error',
          message: 'Missing value for --source-strategy.',
        }
      }
      sourceStrategyKinds.push(strategy)
      index++
      continue
    }

    if (token === '--source-strategy-plugin-manifest') {
      const manifestPath = tokens[index + 1]?.trim()
      if (!manifestPath) {
        return {
          kind: 'error',
          message: 'Missing value for --source-strategy-plugin-manifest.',
        }
      }
      sourceStrategyPluginManifests.push(manifestPath)
      index++
      continue
    }

    if (token === '--ignore-dir') {
      const ignoredDir = tokens[index + 1]?.trim()
      if (!ignoredDir) {
        return {
          kind: 'error',
          message: 'Missing value for --ignore-dir.',
        }
      }
      ignoredDirNames.push(ignoredDir)
      index++
      continue
    }

    if (token.startsWith('-')) {
      return { kind: 'error', message: `Unknown flag: ${token}` }
    }

    if (rootDir !== '.') {
      return {
        kind: 'error',
        message: 'Only one path argument is supported.',
      }
    }

    rootDir = token
  }

  return {
    kind: 'run',
    ignoredDirNames: ignoredDirNames.length > 0 ? ignoredDirNames : undefined,
    maxFiles,
    maxFileBytes,
    outputDir,
    rootDir,
    sourceStrategyPluginManifests:
      sourceStrategyPluginManifests.length > 0
        ? sourceStrategyPluginManifests
        : undefined,
    sourceStrategyKinds: sourceStrategyKinds.length > 0 ? sourceStrategyKinds : undefined,
    workers,
  }
}
