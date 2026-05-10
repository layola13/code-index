import { buildCodeIndex } from '../src/indexing/build.js'
import { errorMessage } from '../src/utils/errors.js'
import { statSync } from 'fs'

type HookInput = {
  cwd?: string
  hook_event_name?: string
  session_id?: string
  turn_id?: string
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

async function main(): Promise<number> {
  const input = parseInput(await Bun.file('/dev/stdin').text())
  const cwd = input.cwd ?? process.cwd()

  try {
    const cwdStat = statSync(cwd)
    if (!cwdStat.isDirectory()) {
      return 0
    }
  } catch {
    return 0
  }

  try {
    await buildCodeIndex({
      rootDir: cwd,
      outputDir: `${cwd}/.code_index`,
    })
    return 0
  } catch (error) {
    console.error(`code-index hook failed for ${cwd}: ${errorMessage(error)}`)
    return 1
  }
}

if (import.meta.main) {
  const exitCode = await main()
  if (exitCode !== 0) {
    process.exitCode = exitCode
  }
}
