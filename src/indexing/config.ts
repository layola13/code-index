import { availableParallelism, cpus } from 'os'
import { basename, resolve } from 'path'
import type { CodeLanguage } from './ir.js'
import type { CodeIndexProgressCallback } from './progress.js'

export const DEFAULT_MAX_FILE_BYTES = Number.MAX_SAFE_INTEGER

export const DEFAULT_PARSE_WORKERS = resolveDefaultParseWorkers()
export const GENERATED_INDEX_DIR_PREFIXES = ['.code_index_', '.index_'] as const

export const LANGUAGE_BY_EXTENSION: Record<string, CodeLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.ml': 'ocaml',
  '.mli': 'ocaml',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.hx': 'haxe',
  '.zig': 'zig',
  '.saasm': 'saasm',
  '.saasm-iface': 'saasm',
  '.saasm-layout': 'saasm',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.hh': 'cpp',
  '.cpp': 'cpp',
  '.cppm': 'cpp',
  '.hpp': 'cpp',
  '.cxx': 'cpp',
  '.hxx': 'cpp',
  '.c++': 'cpp',
  '.h++': 'cpp',
  '.ixx': 'cpp',
  '.mpp': 'cpp',
  '.ipp': 'cpp',
  '.inl': 'cpp',
  '.tpp': 'cpp',
  '.kt': 'generic',
  '.kts': 'generic',
  '.swift': 'generic',
  '.rb': 'generic',
  '.php': 'generic',
  '.cs': 'generic',
  '.lua': 'generic',
  '.sh': 'generic',
  '.bash': 'generic',
  '.zsh': 'generic',
}

export const DEFAULT_IGNORED_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  '.vs',
  '.cache',
  '.code_index',
  '.history',
  '.summarizer',
  '.usernotice',
  '.usernotic',
  '.venv',
  '.tox',
  '__pycache__',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'coverage',
  'out',
  'target',
  'binaries',
  'intermediate',
  'saved',
  'deriveddatacache',
  'thirdparty',
  'third_party',
  'third-party',
  'cmakefiles',
  'cmake-build-debug',
  'cmake-build-release',
  'tmp',
  '.tmp',
])

const LANGUAGE_SUFFIX_ENTRIES = Object.entries(LANGUAGE_BY_EXTENSION).sort(
  ([left], [right]) => right.length - left.length,
)

export type CodeIndexBuildOptions = {
  ignoredDirNames?: readonly string[]
  maxFiles?: number
  rootDir?: string
  outputDir?: string
  signal?: AbortSignal
  discoverSourceStrategyPluginManifests?: boolean
  sourceStrategyPluginManifests?: readonly string[]
  sourceStrategyKinds?: readonly string[]
  maxFileBytes?: number
  onProgress?: CodeIndexProgressCallback
  workers?: number
}

export type CodeIndexConfig = {
  rootDir: string
  outputDir: string
  outputDirName: string
  maxFiles?: number
  maxFileBytes: number
  onProgress?: CodeIndexProgressCallback
  parseWorkers: number
  ignoredDirNames: ReadonlySet<string>
  discoverSourceStrategyPluginManifests: boolean
  sourceStrategyPluginManifests: ReadonlySet<string>
  sourceStrategyKinds: ReadonlySet<string>
  signal?: AbortSignal
}

function resolveDefaultParseWorkers(): number {
  const cpuCount =
    typeof availableParallelism === 'function'
      ? availableParallelism()
      : cpus().length
  if (cpuCount <= 1) {
    return 1
  }
  return Math.max(1, Math.min(8, cpuCount - 1))
}

function normalizeIgnoredDirName(name: string): string {
  return name.trim().toLowerCase()
}

function normalizeSourceStrategyKind(name: string): string {
  return name.trim().toLowerCase()
}

export function isGeneratedIndexDirName(name: string): boolean {
  const normalized = normalizeIgnoredDirName(name)
  return (
    normalized === '.code_index' ||
    GENERATED_INDEX_DIR_PREFIXES.some(prefix => normalized.startsWith(prefix))
  )
}

function normalizeParseWorkers(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_PARSE_WORKERS
  }

  if (!Number.isFinite(value) || value <= 0) {
    return 1
  }

  return Math.max(1, Math.trunc(value))
}

export function resolveCodeIndexConfig(
  options: CodeIndexBuildOptions = {},
): CodeIndexConfig {
  const cwd = process.cwd()
  const rootDir = resolve(cwd, options.rootDir ?? '.')
  const outputDir = options.outputDir
    ? resolve(cwd, options.outputDir)
    : resolve(rootDir, '.code_index')

  return {
    rootDir,
    outputDir,
    outputDirName: basename(outputDir),
    maxFiles: options.maxFiles,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    onProgress: options.onProgress,
    parseWorkers: normalizeParseWorkers(options.workers),
    ignoredDirNames: new Set(
      [...DEFAULT_IGNORED_DIR_NAMES, ...(options.ignoredDirNames ?? [])].map(
        normalizeIgnoredDirName,
      ),
    ),
    discoverSourceStrategyPluginManifests:
      options.discoverSourceStrategyPluginManifests ?? true,
    sourceStrategyPluginManifests: new Set(
      (options.sourceStrategyPluginManifests ?? [])
        .map(manifestPath => resolve(cwd, manifestPath.trim()))
        .filter(manifestPath => Boolean(manifestPath)),
    ),
    sourceStrategyKinds: new Set(
      (options.sourceStrategyKinds ?? [])
        .map(normalizeSourceStrategyKind)
        .filter(kind => Boolean(kind)),
    ),
    signal: options.signal,
  }
}

export function getCodeLanguageForExtension(
  extension: string,
): CodeLanguage | null {
  return LANGUAGE_BY_EXTENSION[extension.toLowerCase()] ?? null
}

export function getCodeLanguageForPath(filePath: string): CodeLanguage | null {
  const normalized = filePath.replaceAll('\\', '/').toLowerCase()
  for (const [suffix, language] of LANGUAGE_SUFFIX_ENTRIES) {
    if (normalized.endsWith(suffix)) {
      return language
    }
  }
  return null
}
