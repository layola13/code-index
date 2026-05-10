import { readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'
import type { SourceStrategyPlugin } from './strategyTypes.js'

type SourceStrategyPluginPackageManifest = {
  sourceStrategyPluginEntry?: string
  sourceStrategyPluginEntries?: string[]
}

type SourceStrategyPluginModule = {
  default?: unknown
  getSourceStrategyPlugins?: () => SourceStrategyPlugin[]
  getBuiltinSourceStrategyPlugins?: () => SourceStrategyPlugin[]
}

function normalizeEntryList(
  manifest: SourceStrategyPluginPackageManifest,
): string[] {
  const entries = [
    ...(manifest.sourceStrategyPluginEntries ?? []),
    manifest.sourceStrategyPluginEntry ?? '',
  ]
  return [...new Set(entries.map(entry => entry.trim()).filter(Boolean))]
}

function extractPluginsFromModule(module: SourceStrategyPluginModule): SourceStrategyPlugin[] {
  const exported =
    module.getSourceStrategyPlugins ??
    module.getBuiltinSourceStrategyPlugins ??
    module.default

  if (typeof exported === 'function') {
    const plugins = exported()
    if (Array.isArray(plugins)) {
      return plugins.filter((plugin): plugin is SourceStrategyPlugin => Boolean(plugin))
    }
  }

  if (Array.isArray(exported)) {
    return exported.filter((plugin): plugin is SourceStrategyPlugin => Boolean(plugin))
  }

  return []
}

export async function loadSourceStrategyPluginsFromPackageManifest(
  manifestPath: string,
): Promise<SourceStrategyPlugin[]> {
  const manifest = JSON.parse(
    await readFile(manifestPath, 'utf8'),
  ) as SourceStrategyPluginPackageManifest
  const packageRoot = dirname(dirname(manifestPath))
  const entries = normalizeEntryList(manifest)
  const plugins: SourceStrategyPlugin[] = []

  for (const entry of entries) {
    const entryPath = join(packageRoot, entry)
    const module = (await import(pathToFileURL(entryPath).href)) as SourceStrategyPluginModule
    plugins.push(...extractPluginsFromModule(module))
  }

  return plugins
}
