import { stat } from 'fs/promises'
import { join } from 'path'

import { buildCodeIndex } from './build.js'

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissingFileError(error)) {
      return false
    }
    throw error
  }
}

async function hasRequiredArtifacts(
  outputDir: string,
  requiredArtifacts: readonly string[],
): Promise<boolean> {
  for (const relativePath of requiredArtifacts) {
    if (!(await pathExists(join(outputDir, relativePath)))) {
      return false
    }
  }

  return true
}

export type EnsureIndexArtifactsOptions = {
  outputDir: string
  requiredArtifacts: readonly string[]
  rootDir: string
  signal?: AbortSignal
}

export async function ensureIndexArtifacts(
  options: EnsureIndexArtifactsOptions,
): Promise<boolean> {
  if (await hasRequiredArtifacts(options.outputDir, options.requiredArtifacts)) {
    return false
  }

  await buildCodeIndex({
    rootDir: options.rootDir,
    outputDir: options.outputDir,
    signal: options.signal,
  })
  return true
}
