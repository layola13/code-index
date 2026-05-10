import { readdir } from 'fs/promises'
import { join } from 'path'

function isPluginManifestCandidate(dirPath: string, entryName: string): boolean {
  return entryName === '.codex-plugin'
}

async function discoverPluginManifestPathsInDirectory(
  dirPath: string,
): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  const manifests: string[] = []

  for (const entry of entries) {
    const entryPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      if (isPluginManifestCandidate(dirPath, entry.name)) {
        manifests.push(join(dirPath, entry.name, 'plugin.json'))
        continue
      }
      manifests.push(...(await discoverPluginManifestPathsInDirectory(entryPath)))
    }
  }

  return manifests
}

export async function discoverSourceStrategyPluginManifests(
  rootDir: string,
): Promise<string[]> {
  try {
    return [...new Set(await discoverPluginManifestPathsInDirectory(join(rootDir, 'plugins')))].sort()
  } catch {
    return []
  }
}
