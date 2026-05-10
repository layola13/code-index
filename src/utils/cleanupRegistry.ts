type CleanupFn = () => void | Promise<void>

const cleanupFns = new Set<CleanupFn>()
let exitHookRegistered = false

async function runCleanupFns(): Promise<void> {
  for (const cleanupFn of cleanupFns) {
    try {
      await cleanupFn()
    } catch (error) {
      // Best effort: cleanup must never block shutdown.
      console.error(
        `[code-index] cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
}

function registerExitHook(): void {
  if (exitHookRegistered) {
    return
  }
  exitHookRegistered = true
  process.once('beforeExit', () => {
    void runCleanupFns()
  })
}

export function registerCleanup(cleanupFn: CleanupFn): void {
  cleanupFns.add(cleanupFn)
  registerExitHook()
}
