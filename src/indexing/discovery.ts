import { readdir } from 'fs/promises'
import { extname, relative, sep } from 'path'
import type { CodeIndexConfig } from './config.js'
import { getCodeLanguageForExtension, isGeneratedIndexDirName } from './config.js'
import type { CodeLanguage } from './ir.js'
import type { CodeIndexBuildProgress } from './progress.js'
import { createYieldState, maybeYieldToEventLoop } from './runtime.js'

export type DiscoveredSourceFile = {
  absolutePath: string
  relativePath: string
  language: CodeLanguage
}

export type DiscoverSourceFilesResult = {
  fileLimitReached: boolean
  files: DiscoveredSourceFile[]
}

const DISCOVERY_PROGRESS_INTERVAL = 256

function shouldSkipDirectory(
  absolutePath: string,
  dirName: string,
  config: CodeIndexConfig,
): boolean {
  if (isGeneratedIndexDirName(dirName)) {
    return true
  }

  if (config.ignoredDirNames.has(dirName.toLowerCase())) {
    return true
  }

  if (absolutePath === config.outputDir) {
    return true
  }

  return absolutePath.startsWith(config.outputDir + sep)
}

export async function discoverSourceFiles(
  config: CodeIndexConfig,
): Promise<DiscoverSourceFilesResult> {
  const discovered: DiscoveredSourceFile[] = []
  const yieldState = createYieldState()
  let fileLimitReached = false
  let lastReportedCount = 0

  async function reportProgress(force = false): Promise<void> {
    if (!config.onProgress) {
      return
    }
    if (
      !force &&
      discovered.length > 0 &&
      discovered.length - lastReportedCount < DISCOVERY_PROGRESS_INTERVAL
    ) {
      return
    }
    lastReportedCount = discovered.length
    await config.onProgress({
      phase: 'discover',
      message: `Discovered ${discovered.length} source files`,
      completed: discovered.length,
    } satisfies CodeIndexBuildProgress)
  }

  async function walk(dirPath: string): Promise<boolean> {
    const entries = await readdir(dirPath, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      await maybeYieldToEventLoop(yieldState)
      const absolutePath = `${dirPath}${sep}${entry.name}`

      if (entry.isDirectory()) {
        if (shouldSkipDirectory(absolutePath, entry.name, config)) {
          continue
        }
        if (await walk(absolutePath)) {
          return true
        }
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      const language = getCodeLanguageForExtension(extname(entry.name))
      if (!language) {
        continue
      }

      discovered.push({
        absolutePath,
        relativePath: relative(config.rootDir, absolutePath).split(sep).join('/'),
        language,
      })
      await reportProgress()

      if (config.maxFiles !== undefined && discovered.length >= config.maxFiles) {
        fileLimitReached = true
        return true
      }
    }

    return false
  }

  await walk(config.rootDir)
  await reportProgress(true)
  discovered.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return {
    fileLimitReached,
    files: discovered,
  }
}
