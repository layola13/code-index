import { buildCodeIndex } from '../src/indexing/build.js'
import { errorMessage } from '../src/utils/errors.js'
import { statSync } from 'fs'
import { mkdirSync, appendFileSync } from 'fs'
import { dirname, resolve } from 'path'

type HookInput = {
  cwd?: string
  hook_event_name?: string
  session_id?: string
  turn_id?: string
}

const HOOK_LOG_PATH = resolve(
  process.env.CODE_INDEX_HOOK_LOG_PATH ?? `${process.env.HOME ?? '/tmp'}/.codex/log/code-index-hook.log`,
)

type RunIndexHookOptions = {
  rawInput: string
  processCwd?: string
  logPath?: string
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

export async function runIndexHook(options: RunIndexHookOptions): Promise<number> {
  const input = parseInput(options.rawInput)
  const processCwd = options.processCwd ?? process.cwd()
  const cwd = input.cwd ?? processCwd
  const eventName = input.hook_event_name ?? 'unknown'
  const logPath = options.logPath ?? HOOK_LOG_PATH
  const buildCodeIndexImpl = options.buildCodeIndexImpl ?? buildCodeIndex
  const statSyncImpl = options.statSyncImpl ?? statSync
  const now = options.now ?? (() => new Date())

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

  try {
    await buildCodeIndexImpl({
      rootDir: cwd,
      outputDir: `${cwd}/.code_index`,
    })
    logHook(`hook-finish event=${eventName} resolvedCwd=${JSON.stringify(cwd)} status=success`, logPath, now)
    return 0
  } catch (error) {
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
