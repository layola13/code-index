import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CodeIndexBuildOptions } from './config.js'
import { resolveCodeIndexConfig } from './config.js'
import type {
  BuildCodeIndexResult,
  CodeIndexIncrementalStats,
  CodeIndexTimings,
} from './build.js'
import type { CodeIndexManifest } from './ir.js'
import { resolveCodeIndexSkillPaths } from './skillWriter.js'

type CommandResult = {
  stdout: string
  stderr: string
}

const RUST_BINARY_NAME = process.platform === 'win32'
  ? 'code-index-rs.exe'
  : 'code-index-rs'

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function runCommand(args: {
  command: string
  args: string[]
  cwd?: string
  signal?: AbortSignal
}): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(args.command, args.args, {
      cwd: args.cwd,
      env: process.env,
      signal: args.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout.on('data', chunk => {
      stdoutChunks.push(Buffer.from(chunk))
    })
    child.stderr.on('data', chunk => {
      stderrChunks.push(Buffer.from(chunk))
      process.stderr.write(chunk)
    })
    child.on('error', reject)
    child.on('close', code => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      if (code === 0) {
        resolvePromise({ stdout, stderr })
        return
      }
      reject(
        new Error(
          `Rust code-index engine exited with code ${code ?? 'unknown'}${
            stderr ? `: ${stderr.trim()}` : ''
          }`,
        ),
      )
    })
  })
}

function candidateRustProjects(): string[] {
  const root = repoRoot()
  return [
    process.env.CODE_INDEX_RS_MANIFEST
      ? dirname(process.env.CODE_INDEX_RS_MANIFEST)
      : '',
    process.env.CODE_INDEX_RS_DIR ?? '',
    resolve(root, 'engines', 'rust'),
    resolve(root, '..', 'code-index-rs'),
  ].filter(Boolean)
}

async function resolveRustBinary(signal?: AbortSignal): Promise<string> {
  const explicitBinary = process.env.CODE_INDEX_RS_BIN
  if (explicitBinary) {
    const resolved = resolve(explicitBinary)
    if (!(await isExecutable(resolved))) {
      throw new Error(`CODE_INDEX_RS_BIN is not executable: ${resolved}`)
    }
    return resolved
  }

  for (const projectDir of candidateRustProjects()) {
    const binary = join(projectDir, 'target', 'release', RUST_BINARY_NAME)
    if (await isExecutable(binary)) {
      return binary
    }
  }

  for (const projectDir of candidateRustProjects()) {
    const manifestPath = join(projectDir, 'Cargo.toml')
    if (!(await pathExists(manifestPath))) {
      continue
    }
    await runCommand({
      command: 'cargo',
      args: ['build', '--release', '--manifest-path', manifestPath],
      cwd: projectDir,
      signal,
    })
    const binary = join(projectDir, 'target', 'release', RUST_BINARY_NAME)
    if (await isExecutable(binary)) {
      return binary
    }
  }

  throw new Error(
    'Rust code-index engine not found. Set CODE_INDEX_RS_BIN or place code-index-rs next to code-index.',
  )
}

function parseDurationMs(stdout: string, label: string): number {
  const pattern = new RegExp(`^\\s*${label}:\\s*([0-9.]+)s\\s*$`, 'im')
  const match = stdout.match(pattern)
  if (!match?.[1]) {
    return 0
  }
  return Number.parseFloat(match[1]) * 1000
}

async function readManifest(outputDir: string): Promise<CodeIndexManifest> {
  const manifestText = await readFile(join(outputDir, 'index', 'manifest.json'), 'utf8')
  return JSON.parse(manifestText) as CodeIndexManifest
}

function ensureRustEngineOptionsSupported(options: CodeIndexBuildOptions): void {
  if ((options.sourceStrategyKinds?.length ?? 0) > 0) {
    throw new Error('Rust engine does not support sourceStrategyKinds yet; use --engine typescript for source strategies.')
  }
  if ((options.sourceStrategyPluginManifests?.length ?? 0) > 0) {
    throw new Error('Rust engine does not support sourceStrategyPluginManifests yet; use --engine typescript for source strategies.')
  }
}

export async function buildCodeIndexWithRustEngine(
  options: CodeIndexBuildOptions = {},
): Promise<BuildCodeIndexResult> {
  ensureRustEngineOptionsSupported(options)
  const signal = options.signal instanceof AbortSignal ? options.signal : undefined
  const config = resolveCodeIndexConfig(options)
  const binary = await resolveRustBinary(signal)

  const commandArgs = ['build', config.rootDir, '--output-dir', config.outputDir]
  commandArgs.push('--workers', String(config.parseWorkers))
  if (config.maxFiles !== undefined) {
    commandArgs.push('--max-files', String(config.maxFiles))
  }
  if (config.maxFileBytes !== Number.MAX_SAFE_INTEGER) {
    commandArgs.push('--max-file-bytes', String(config.maxFileBytes))
  }
  for (const ignoredDirName of config.ignoredDirNames) {
    commandArgs.push('--ignore', ignoredDirName)
  }

  const startedAt = performance.now()
  await options.onProgress?.({
    phase: 'discover',
    message: `Starting Rust code-index engine for ${config.rootDir}`,
  })
  const commandResult = await runCommand({
    command: binary,
    args: commandArgs,
    cwd: repoRoot(),
    signal,
  })
  const totalMs = performance.now() - startedAt
  const manifest = await readManifest(config.outputDir)

  const timings: CodeIndexTimings = {
    buildEdgesMs: parseDurationMs(commandResult.stdout, 'build_edges'),
    discoverMs: parseDurationMs(commandResult.stdout, 'discover'),
    emitSkeletonMs: 0,
    parseMs: parseDurationMs(commandResult.stdout, 'parse'),
    totalMs: parseDurationMs(commandResult.stdout, 'total') || totalMs,
    writeIndexFilesMs: parseDurationMs(commandResult.stdout, 'write'),
    writeSkillsMs: 0,
  }
  const incremental: CodeIndexIncrementalStats = {
    cacheHits: 0,
    cacheMisses: manifest.moduleCount,
    removedFiles: 0,
  }

  await options.onProgress?.({
    phase: 'complete',
    message: `Rust code-index ready in ${Math.round(timings.totalMs)}ms`,
    completed: manifest.moduleCount,
    total: manifest.moduleCount,
  })

  return {
    engine: 'rust',
    fileLimitReached: manifest.fileLimitReached,
    incremental,
    maxFiles: config.maxFiles,
    manifest,
    outputDir: config.outputDir,
    parseWorkers: config.parseWorkers,
    rootDir: config.rootDir,
    skillPaths: resolveCodeIndexSkillPaths({
      rootDir: config.rootDir,
    }),
    skillsWritten: false,
    timings,
  }
}
