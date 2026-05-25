import { createHash } from 'crypto'
import { buildCodeIndex } from '../src/indexing/build.js'
import { errorMessage } from '../src/utils/errors.js'
import { closeSync, openSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'fs'
import { mkdirSync, appendFileSync } from 'fs'
import { dirname, join, resolve } from 'path'

type HookInput = {
  cwd?: string
  hook_event_name?: string
  session_id?: string
  turn_id?: string
}

const HOOK_LOG_PATH = resolve(
  process.env.CODE_INDEX_HOOK_LOG_PATH ?? `${process.env.HOME ?? '/tmp'}/.codex/log/code-index-hook.log`,
)
const HOOK_STATE_DIR = resolve(
  process.env.CODE_INDEX_HOOK_STATE_DIR ?? `${process.env.HOME ?? '/tmp'}/.codex/log/code-index-hook-state`,
)
const HOOK_THROTTLE_MS = 60_000
const HOOK_LOCK_STALE_MS = 10 * 60_000

type RunIndexHookOptions = {
  rawInput: string
  processCwd?: string
  logPath?: string
  stateDir?: string
  buildCodeIndexImpl?: typeof buildCodeIndex
  statSyncImpl?: typeof statSync
  now?: () => Date
}

function logHook(message: string, logPath = HOOK_LOG_PATH, now = () => new Date()): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${now().toISOString()} ${message}\n`, 'utf8')
  } catch {
    // Logging must never break the hook itself.
  }
}

function parseInput(text: string): HookInput {
  const trimmed = text.trim()
  if (!trimmed) {
    return {}
  }

  try {
    return JSON.parse(trimmed) as HookInput
  } catch {
    return {}
  }
}

function workspaceKey(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16)
}

function errorCode(error: unknown): string | undefined {
  return (
    Boolean(error) &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code?: string }).code
  )
}

function getWorkspacePaths(cwd: string, stateDir: string): {
  cooldownPath: string
  lockPath: string
} {
  const key = workspaceKey(cwd)
  return {
    cooldownPath: join(stateDir, `${key}.last_success`),
    lockPath: join(stateDir, `${key}.lock`),
  }
}

function acquireHookLock(args: {
  now: () => Date
  lockPath: string
  statSyncImpl: typeof statSync
}): number | null {
  mkdirSync(dirname(args.lockPath), { recursive: true })

  try {
    return openSync(args.lockPath, 'wx', 0o600)
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      throw error
    }

    try {
      const stats = args.statSyncImpl(args.lockPath)
      if (args.now().getTime() - stats.mtimeMs > HOOK_LOCK_STALE_MS) {
        try {
          unlinkSync(args.lockPath)
          return openSync(args.lockPath, 'wx', 0o600)
        } catch {
          return null
        }
      }
    } catch {
      // If the lock cannot be inspected or reclaimed, skip this run.
    }

    return null
  }
}

function releaseHookLock(lockFd: number, lockPath: string): void {
  try {
    closeSync(lockFd)
  } catch {
    // Best effort only.
  }

  try {
    unlinkSync(lockPath)
  } catch {
    // Best effort only.
  }
}

function hasFreshCooldown(cooldownPath: string, now: () => Date, statSyncImpl: typeof statSync): boolean {
  try {
    const stats = statSyncImpl(cooldownPath)
    return now().getTime() - stats.mtimeMs < HOOK_THROTTLE_MS
  } catch {
    return false
  }
}

function touchCooldown(cooldownPath: string, now: () => Date): void {
  try {
    mkdirSync(dirname(cooldownPath), { recursive: true })
    const timestamp = now()
    writeFileSync(cooldownPath, `${timestamp.toISOString()}\n`, 'utf8')
    utimesSync(cooldownPath, timestamp, timestamp)
  } catch {
    // Best effort only. A missed cooldown is better than failing the hook.
  }
}

export async function runIndexHook(options: RunIndexHookOptions): Promise<number> {
  const input = parseInput(options.rawInput)
  const processCwd = options.processCwd ?? process.cwd()
  const cwd = input.cwd ?? processCwd
  const eventName = input.hook_event_name ?? 'unknown'
  const logPath = options.logPath ?? HOOK_LOG_PATH
  const stateDir = options.stateDir ?? HOOK_STATE_DIR
  const buildCodeIndexImpl = options.buildCodeIndexImpl ?? buildCodeIndex
  const statSyncImpl = options.statSyncImpl ?? statSync
  const now = options.now ?? (() => new Date())
  const { cooldownPath, lockPath } = getWorkspacePaths(cwd, stateDir)

  logHook(
    `hook-start event=${eventName} processCwd=${JSON.stringify(processCwd)} payloadCwd=${JSON.stringify(
      input.cwd ?? '',
    )} resolvedCwd=${JSON.stringify(cwd)} session=${JSON.stringify(
      input.session_id ?? '',
    )} turn=${JSON.stringify(input.turn_id ?? '')} input=${JSON.stringify(options.rawInput.trim())}`,
    logPath,
    now,
  )

  try {
    const cwdStat = statSyncImpl(cwd)
    if (!cwdStat.isDirectory()) {
      logHook(`hook-skip event=${eventName} resolvedCwd=${JSON.stringify(cwd)} reason=not-directory`, logPath, now)
      return 0
    }
  } catch {
    logHook(`hook-skip event=${eventName} resolvedCwd=${JSON.stringify(cwd)} reason=missing`, logPath, now)
    return 0
  }

  const lockFd = acquireHookLock({
    now,
    lockPath,
    statSyncImpl,
  })
  if (lockFd === null) {
    logHook(`hook-skip event=${eventName} resolvedCwd=${JSON.stringify(cwd)} reason=busy`, logPath, now)
    return 0
  }

  let shouldTouchCooldown = false
  try {
    if (hasFreshCooldown(cooldownPath, now, statSyncImpl)) {
      logHook(
        `hook-skip event=${eventName} resolvedCwd=${JSON.stringify(cwd)} reason=cooldown cooldown_ms=${HOOK_THROTTLE_MS}`,
        logPath,
        now,
      )
      return 0
    }

    shouldTouchCooldown = true
    await buildCodeIndexImpl({
      rootDir: cwd,
      outputDir: `${cwd}/.code_index`,
    })
    touchCooldown(cooldownPath, now)
    shouldTouchCooldown = false
    logHook(`hook-finish event=${eventName} resolvedCwd=${JSON.stringify(cwd)} status=success`, logPath, now)
    return 0
  } catch (error) {
    if (shouldTouchCooldown) {
      touchCooldown(cooldownPath, now)
      shouldTouchCooldown = false
    }
    const message = errorMessage(error)
    logHook(
      `hook-finish event=${eventName} resolvedCwd=${JSON.stringify(cwd)} status=failure error=${JSON.stringify(
        message,
      )}`,
      logPath,
      now,
    )
    console.error(`code-index hook failed for ${cwd}: ${message}`)
    return 1
  } finally {
    if (shouldTouchCooldown) {
      touchCooldown(cooldownPath, now)
    }
    releaseHookLock(lockFd, lockPath)
  }
}

if (import.meta.main) {
  const exitCode = await runIndexHook({
    rawInput: await Bun.file('/dev/stdin').text(),
  })
  if (exitCode !== 0) {
    process.exitCode = exitCode
  }
}
