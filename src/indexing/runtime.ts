const YIELD_INTERVAL = 128
const YIELD_MS = 8

type YieldState = {
  chunkStart: number
  iterations: number
}

export function createYieldState(): YieldState {
  return {
    chunkStart: performance.now(),
    iterations: 0,
  }
}

export async function maybeYieldToEventLoop(
  state: YieldState,
): Promise<void> {
  state.iterations++
  if ((state.iterations & (YIELD_INTERVAL - 1)) !== YIELD_INTERVAL - 1) {
    return
  }
  if (performance.now() - state.chunkStart <= YIELD_MS) {
    return
  }

  await new Promise<void>(resolve => setImmediate(resolve))
  state.chunkStart = performance.now()
}
