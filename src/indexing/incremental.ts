import { createHash } from 'crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { ModuleIR } from './ir.js'
import type { LoadedSource } from './source.js'

const MODULE_CACHE_VERSION = 2
const MODULE_CACHE_FILENAME = 'module-cache.v1.json'

export type ModuleCacheFingerprint = {
  signature: string
}

type SerializedModuleCache = {
  engine: 'typescript'
  entries: Array<{
    fingerprint: ModuleCacheFingerprint
    module: ModuleIR
    relativePath: string
  }>
  maxFileBytes: number
  rootDir: string
  version: number
}

export type ModuleCacheRecord = {
  fingerprint: ModuleCacheFingerprint
  module: ModuleIR
}

function cachePath(outputDir: string): string {
  return join(outputDir, MODULE_CACHE_FILENAME)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isCompleteModuleIR(value: unknown): value is ModuleIR {
  if (!value || typeof value !== 'object') {
    return false
  }

  const module = value as Partial<ModuleIR>
  return (
    isNonEmptyString(module.moduleId) &&
    isNonEmptyString(module.sourcePath) &&
    isNonEmptyString(module.relativePath) &&
    isNonEmptyString(module.language) &&
    isNonEmptyString(module.parseMode) &&
    Array.isArray(module.imports) &&
    Array.isArray(module.importStubs) &&
    Array.isArray(module.exports) &&
    Array.isArray(module.classes) &&
    Array.isArray(module.functions) &&
    Array.isArray(module.notes) &&
    Array.isArray(module.errors) &&
    typeof module.sourceBytes === 'number' &&
    typeof module.lineCount === 'number' &&
    typeof module.truncated === 'boolean'
  )
}

async function invalidateModuleCache(outputDir: string): Promise<void> {
  try {
    await rm(outputDir, { recursive: true, force: true })
  } catch {
    // A stale cache should not block a rebuild.
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function fingerprintLoadedSource(
  source: LoadedSource,
): ModuleCacheFingerprint {
  return {
    signature: `${source.byteSize}:${hashText(source.text)}`,
  }
}

export async function fingerprintSourceFile(
  absolutePath: string,
): Promise<ModuleCacheFingerprint | null> {
  try {
    const text = await readFile(absolutePath, 'utf8')
    return {
      signature: `${Buffer.byteLength(text, 'utf8')}:${hashText(text)}`,
    }
  } catch {
    return null
  }
}

export function fingerprintsEqual(
  left: ModuleCacheFingerprint | null | undefined,
  right: ModuleCacheFingerprint | null | undefined,
): boolean {
  return left?.signature === right?.signature
}

export async function loadModuleCache(args: {
  engine: 'typescript'
  maxFileBytes: number
  outputDir: string
  rootDir: string
}): Promise<Map<string, ModuleCacheRecord>> {
  const path = cachePath(args.outputDir)
  let raw: string

  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return new Map()
  }

  let parsed: SerializedModuleCache
  try {
    parsed = JSON.parse(raw) as SerializedModuleCache
  } catch {
    await invalidateModuleCache(args.outputDir)
    return new Map()
  }

  if (
    parsed.version !== MODULE_CACHE_VERSION ||
    parsed.engine !== args.engine ||
    parsed.rootDir !== args.rootDir ||
    parsed.maxFileBytes !== args.maxFileBytes
  ) {
    await invalidateModuleCache(args.outputDir)
    return new Map()
  }

  const records = new Map<string, ModuleCacheRecord>()
  let foundInvalidEntry = false
  for (const entry of Array.isArray(parsed.entries) ? parsed.entries : []) {
    if (
      !entry?.relativePath ||
      !entry.fingerprint ||
      !isCompleteModuleIR(entry.module)
    ) {
      foundInvalidEntry = true
      continue
    }
    records.set(entry.relativePath, {
      fingerprint: entry.fingerprint,
      module: entry.module,
    })
  }

  if (foundInvalidEntry) {
    await invalidateModuleCache(args.outputDir)
    return new Map()
  }

  return records
}

export async function writeModuleCache(args: {
  engine: 'typescript'
  entries: Array<{
    fingerprint: ModuleCacheFingerprint
    module: ModuleIR
    relativePath: string
  }>
  maxFileBytes: number
  outputDir: string
  rootDir: string
}): Promise<void> {
  const path = cachePath(args.outputDir)
  const tempPath = `${path}.tmp`
  await mkdir(dirname(path), { recursive: true })

  const payload: SerializedModuleCache = {
    version: MODULE_CACHE_VERSION,
    engine: args.engine,
    rootDir: args.rootDir,
    maxFileBytes: args.maxFileBytes,
    entries: args.entries,
  }

  await writeFile(tempPath, JSON.stringify(payload), 'utf8')
  await rename(tempPath, path)
}
