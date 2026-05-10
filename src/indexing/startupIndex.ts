import type { BuildCodeIndexResult } from './build.js'
import type { CodeIndexBuildProgress } from './progress.js'

export function startupIndexEnabled(): boolean {
  return process.env.CLAUDE_CODE_STARTUP_INDEX !== '0'
}

export function formatStartupIndexProgress(
  progress: CodeIndexBuildProgress,
): string {
  const ratio =
    progress.total && progress.total > 0 && progress.completed !== undefined
      ? ` (${Math.min(100, Math.round((progress.completed / progress.total) * 100))}%)`
      : ''

  switch (progress.phase) {
    case 'discover':
      return `Indexing project: ${progress.message}${ratio}`
    case 'parse':
      return `Indexing project: ${progress.message}${ratio}`
    case 'emit':
      return `Indexing project: ${progress.message}${ratio}`
    case 'edges':
      return `Indexing project: ${progress.message}`
    case 'write':
      return `Indexing project: ${progress.message}`
    case 'skills':
      return `Indexing project: ${progress.message}`
    case 'complete':
      return `Indexing project: ${progress.message}`
  }
}

export function formatStartupIndexSummary(
  result: BuildCodeIndexResult,
): string {
  return [
    `Startup code index ready.`,
    `Root: ${result.rootDir}`,
    `Duration: ${Math.round(result.timings.totalMs)}ms`,
    `Incremental: reused ${result.incremental.cacheHits} | parsed ${result.incremental.cacheMisses} | removed ${result.incremental.removedFiles}`,
    `Modules: ${result.manifest.moduleCount}`,
    `Functions: ${result.manifest.functionCount}`,
    `Edges: ${result.manifest.edgeCount}`,
  ].join('\n')
}
