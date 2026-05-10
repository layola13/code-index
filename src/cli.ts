import { buildCodeIndex } from './indexing/build.js'
import { formatCountSummary } from './indexing/indexWriter.js'
import { formatStartupIndexProgress } from './indexing/startupIndex.js'
import { parseIndexArgs } from './commands/index/args.js'
import { startMcpServer } from './mcp.js'
import { errorMessage } from './utils/errors.js'

const USAGE = [
  'Usage: code-index [build] [path] [--output DIR] [--max-file-bytes N] [--max-files N] [--workers N] [--ignore-dir NAME]',
  '       code-index mcp',
  '',
  'Examples:',
  '  code-index',
  '  code-index build src',
  '  code-index build . --output .code_index',
  '  code-index mcp',
  '  code-index build --max-file-bytes 1048576',
  '  code-index build . --workers 8',
  '  code-index build . --max-files 20000 --ignore-dir ThirdParty',
].join('\n')

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`
  }

  const seconds = durationMs / 1000
  const precision = seconds >= 10 ? 1 : 2
  return `${seconds.toFixed(precision)}s (${Math.round(durationMs)}ms)`
}

export function formatBuildResult(result: Awaited<ReturnType<typeof buildCodeIndex>>): string {
  const { manifest, outputDir, rootDir, skillPaths, timings } = result

  return [
    'Code index build complete.',
    `Engine: ${result.engine}`,
    `Workers: ${result.parseWorkers}`,
    `Incremental: reused ${result.incremental.cacheHits} | parsed ${result.incremental.cacheMisses} | removed ${result.incremental.removedFiles}`,
    `Duration: ${formatDuration(timings.totalMs)}`,
    `Phases: discover ${formatDuration(timings.discoverMs)} | parse ${formatDuration(timings.parseMs)} | emit ${formatDuration(timings.emitSkeletonMs)} | edges ${formatDuration(timings.buildEdgesMs)} | write ${formatDuration(timings.writeIndexFilesMs)} | skills ${formatDuration(timings.writeSkillsMs)}`,
    `Root: ${rootDir}`,
    `Output: ${outputDir}`,
    `Modules: ${manifest.moduleCount}`,
    `Classes: ${manifest.classCount}`,
    `Functions: ${manifest.functionCount}`,
    `Methods: ${manifest.methodCount}`,
    `Edges: ${manifest.edgeCount}`,
    `File limit: ${manifest.fileLimit ?? 'none'}${manifest.fileLimitReached ? ' (reached)' : ''}`,
    `Truncated files: ${manifest.truncatedCount}`,
    `Languages: ${formatCountSummary(manifest.languages) || 'none'}`,
    '',
    'Generated:',
    `- ${outputDir}/index/architecture.dot  (file-level dependency map)`,
    `- ${outputDir}/__index__.py  (entry points, top dirs, hot symbols)`,
    `- ${outputDir}/index/summary.md`,
    `- ${outputDir}/index/manifest.json`,
    `- ${outputDir}/skeleton`,
    `- ${skillPaths.claude}`,
    `- ${skillPaths.codex}`,
    `- ${skillPaths.opencode}`,
  ].join('\n')
}

async function runBuildCommand(args: string): Promise<number> {
  const parsed = parseIndexArgs(args)
  if (parsed.kind === 'help') {
    console.log(USAGE)
    return 0
  }

  if (parsed.kind === 'error') {
    console.error(`${parsed.message}\n\n${USAGE}`)
    return 1
  }

  const result = await buildCodeIndex({
    ignoredDirNames: parsed.ignoredDirNames,
    maxFiles: parsed.maxFiles,
    maxFileBytes: parsed.maxFileBytes,
    outputDir: parsed.outputDir,
    rootDir: parsed.rootDir,
    workers: parsed.workers,
    onProgress(progress) {
      if (process.stderr.isTTY) {
        process.stderr.write(`\r${formatStartupIndexProgress(progress)}`)
      } else if (progress.phase !== 'complete') {
        console.error(formatStartupIndexProgress(progress))
      }
    },
  })

  if (process.stderr.isTTY) {
    process.stderr.write('\n')
  }
  console.log(formatBuildResult(result))
  return 0
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv

  if (command === 'mcp' || command === 'serve') {
    await startMcpServer()
    return 0
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE)
    return 0
  }

  try {
    return await runBuildCommand(argv.join(' '))
  } catch (error) {
    console.error(`Code index build failed: ${errorMessage(error)}`)
    return 1
  }
}

if (import.meta.main) {
  const exitCode = await main()
  if (exitCode !== 0) {
    process.exitCode = exitCode
  }
}
