import { readSourceTextSampleParts } from './source.js'
import type { DiscoveredSourceFile } from './discovery.js'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  type SourceStrategyPlugin,
  type SourceExpansionResult,
  type StrategyDetection,
} from './strategyTypes.js'
import { loadSourceStrategyPluginsFromPackageManifest } from './sourceStrategyPluginPackage.js'
import { isGeneratedBundlePath } from './sourceStrategyUtils.js'
import { discoverSourceStrategyPluginManifests } from './sourceStrategyPluginDiscovery.js'

const DEFAULT_SAMPLE_BYTES = 1000
const BUILTIN_SOURCE_STRATEGY_PACKAGE_MANIFEST = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../plugins/bundle-extractors/.codex-plugin/plugin.json',
)

const BUILTIN_STRATEGY_PLUGINS = new Map<string, SourceStrategyPlugin>()
const CUSTOM_STRATEGY_PLUGINS = new Map<string, SourceStrategyPlugin>()
const LOADED_STRATEGY_MANIFESTS = new Set<string>()

function normalizeStrategyKind(value: string): string {
  return value.trim().toLowerCase()
}

function dedupePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(Boolean))]
}

function hasSourceMapComment(text: string): boolean {
  return /(?:\/\/[#@]\s*sourceMappingURL=([^\s]+))|(?:\/\*#\s*sourceMappingURL=([^*]+)\*\/)/m.test(
    text,
  )
}

function hasInlineSourceMap(text: string): boolean {
  return /sourceMappingURL=data:application\/json/i.test(text)
}

function stripTrailingSourceMapComment(text: string): string {
  return text.replace(
    /(?:\n|\r\n?)\s*(?:\/\/[#@]\s*sourceMappingURL=[^\s]+|\/\*#\s*sourceMappingURL=[^*]+\*\/)\s*$/,
    '',
  )
}

function hasBundleMarker(text: string): boolean {
  return (
    /__webpack_require__|webpackBootstrap|\/\*\s*harmony export\s*\*\//.test(text) ||
    /__commonJS|__export|__toESM|__name/.test(text) ||
    /__vitePreload|__vite__|__vite_ssr_import_/.test(text) ||
    /createRequire\s+as\s+_createRequire|fileURLToPath\s+as\s+_fileURLToPath|import\.meta\.url|__filename|__dirname/.test(
      text,
    )
  )
}

function isLikelyMinified(text: string): boolean {
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

function isBundleLike(text: string, relativePath: string): boolean {
  const normalized = stripTrailingSourceMapComment(text)
  return (
    isGeneratedBundlePath(relativePath) ||
    hasBundleMarker(normalized) ||
    isLikelyMinified(normalized)
  )
}

function normalizeSampleText(sample: { headText: string; tailText: string }): string {
  if (!sample.headText) {
    return sample.tailText
  }
  if (!sample.tailText) {
    return sample.headText
  }
  return `${sample.headText}\n${sample.tailText}`
}

function getPluginByKind(kind: string): SourceStrategyPlugin | null {
  const normalized = normalizeStrategyKind(kind)
  return CUSTOM_STRATEGY_PLUGINS.get(normalized) ?? BUILTIN_STRATEGY_PLUGINS.get(normalized) ?? null
}

function getAvailableKinds(): Set<string> {
  const kinds = new Set<string>()
  for (const kind of BUILTIN_STRATEGY_PLUGINS.keys()) {
    kinds.add(kind)
  }
  for (const kind of CUSTOM_STRATEGY_PLUGINS.keys()) {
    kinds.add(kind)
  }
  return kinds
}

function resolveEnabledKinds(enabledKinds: ReadonlySet<string>): Set<string> {
  if (enabledKinds.size === 0) {
    return new Set(['raw'])
  }

  const normalized = new Set<string>()
  for (const kind of enabledKinds) {
    const trimmed = normalizeStrategyKind(kind)
    if (!trimmed) {
      continue
    }

    if (trimmed === 'auto') {
      for (const availableKind of getAvailableKinds()) {
        normalized.add(availableKind)
      }
      continue
    }

    normalized.add(trimmed)
  }

  if (normalized.size === 0) {
    normalized.add('raw')
  }

  return normalized
}

function selectStrategyPlugin(args: {
  enabledKinds: ReadonlySet<string>
  file: DiscoveredSourceFile
  headText: string
  tailText: string
  hasSourceMapComment: boolean
}): {
  detection: StrategyDetection
  plugin: SourceStrategyPlugin
} | null {
  const enabledKinds = resolveEnabledKinds(args.enabledKinds)
  const detections: Array<{
    detection: StrategyDetection
    plugin: SourceStrategyPlugin
  }> = []

  for (const kind of enabledKinds) {
    if (kind === 'raw') {
      continue
    }

    const plugin = getPluginByKind(kind)
    if (!plugin) {
      continue
    }

    const detection = plugin.detect({
      file: args.file,
      headText: args.headText,
      tailText: args.tailText,
      hasSourceMapComment: args.hasSourceMapComment,
    })
    if (!detection) {
      continue
    }

    detections.push({ detection, plugin })
  }

  if (detections.length === 0) {
    return null
  }

  detections.sort((left, right) => right.detection.confidence - left.detection.confidence)
  return detections[0] ?? null
}

function selectImplicitMinifiedStrategyPlugin(args: {
  file: DiscoveredSourceFile
  sampleText: string
}): {
  detection: StrategyDetection
  plugin: SourceStrategyPlugin
} | null {
  if (!isLikelyMinified(args.sampleText)) {
    return null
  }

  const plugin = getPluginByKind('minified-js')
  if (!plugin) {
    return null
  }

  return {
    detection: {
      kind: 'minified-js',
      confidence: 0.6,
      reason: 'implicit minified bundle detection',
    },
    plugin,
  }
}

function createSkippedResult(): SourceExpansionResult {
  return {
    cleanupPaths: [],
    units: [],
  }
}

async function loadSourceStrategyPluginManifest(manifestPath: string): Promise<void> {
  if (LOADED_STRATEGY_MANIFESTS.has(manifestPath)) {
    return
  }

  const plugins = await loadSourceStrategyPluginsFromPackageManifest(manifestPath)
  for (const plugin of plugins) {
    BUILTIN_STRATEGY_PLUGINS.set(normalizeStrategyKind(plugin.kind), plugin)
  }
  LOADED_STRATEGY_MANIFESTS.add(manifestPath)
}

export async function ensureSourceStrategyPluginsLoaded(
  args: {
    manifestPaths?: readonly string[]
    rootDir?: string
    discoverFromRoot?: boolean
  } = {},
): Promise<void> {
  const discoveredManifestPaths =
    args.discoverFromRoot && args.rootDir
      ? await discoverSourceStrategyPluginManifests(args.rootDir)
      : []
  for (const manifestPath of dedupePaths([
    BUILTIN_SOURCE_STRATEGY_PACKAGE_MANIFEST,
    ...discoveredManifestPaths,
    ...(args.manifestPaths ?? []),
  ])) {
    await loadSourceStrategyPluginManifest(manifestPath)
  }
}

export function registerSourceStrategyPlugin(plugin: SourceStrategyPlugin): void {
  CUSTOM_STRATEGY_PLUGINS.set(normalizeStrategyKind(plugin.kind), plugin)
}

export function unregisterSourceStrategyPlugin(kind: string): void {
  CUSTOM_STRATEGY_PLUGINS.delete(normalizeStrategyKind(kind))
}

export function resetSourceStrategyPluginsForTesting(): void {
  BUILTIN_STRATEGY_PLUGINS.clear()
  CUSTOM_STRATEGY_PLUGINS.clear()
  LOADED_STRATEGY_MANIFESTS.clear()
}

export async function expandSourceFile(args: {
  enabledKinds: ReadonlySet<string>
  file: DiscoveredSourceFile
  maxFileBytes: number
  pluginManifests?: ReadonlySet<string>
  rootDir: string
  discoverPluginManifests?: boolean
}): Promise<SourceExpansionResult> {
  await ensureSourceStrategyPluginsLoaded({
    manifestPaths: args.pluginManifests ? [...args.pluginManifests] : [],
    rootDir: args.rootDir,
    discoverFromRoot: args.discoverPluginManifests ?? true,
  })

  const sample = await readSourceTextSampleParts(
    args.file.absolutePath,
    DEFAULT_SAMPLE_BYTES,
    DEFAULT_SAMPLE_BYTES,
  )
  const sampleText = normalizeSampleText(sample)
  const hasMapComment = hasSourceMapComment(sampleText) || hasInlineSourceMap(sampleText)

  if (hasMapComment) {
    return createSkippedResult()
  }

  const selected = selectStrategyPlugin({
    enabledKinds: args.enabledKinds,
    file: args.file,
    headText: sample.headText,
    tailText: sample.tailText,
    hasSourceMapComment: false,
  })

  const implicitMinified =
    !selected && args.enabledKinds.size === 0
      ? selectImplicitMinifiedStrategyPlugin({
          file: args.file,
          sampleText,
        })
      : null

  const chosen = selected ?? implicitMinified

  if (!chosen) {
    if (isBundleLike(sampleText, args.file.relativePath)) {
      return createSkippedResult()
    }

    return {
      cleanupPaths: [],
      units: [
        {
          file: args.file,
          originFile: args.file,
          originPath: args.file.originPath,
          originStartLine: args.file.originStartLine,
          originStartCharacter: args.file.originStartCharacter,
          fingerprintPath: args.file.absolutePath,
          source: undefined,
          strategyKind: 'raw',
        },
      ],
    }
  }

  const tempRootDir = join(args.rootDir, '.code_index_tmp', 'strategy')
  const expanded = await chosen.plugin.expand({
    file: args.file,
    headText: sample.headText,
    rootDir: args.rootDir,
    tempRootDir,
    tailText: sample.tailText,
  })

  return {
    cleanupPaths: dedupePaths([tempRootDir, ...expanded.cleanupPaths]),
    units: expanded.units.map(unit => ({
      ...unit,
      originFile: unit.originFile ?? args.file,
      originPath: unit.originPath ?? args.file.originPath,
      originStartLine: unit.originStartLine ?? args.file.originStartLine,
      originStartCharacter:
        unit.originStartCharacter ?? args.file.originStartCharacter,
      fingerprintPath: unit.fingerprintPath ?? unit.file.absolutePath,
      source: unit.source,
    })),
  }
}
