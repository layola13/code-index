import type { SourceStrategyPlugin } from '../../src/indexing/strategyTypes.js'

export function createRawSourceStrategyPlugin(): SourceStrategyPlugin {
  return {
    kind: 'raw',
    detect() {
      return { kind: 'raw', confidence: 0.5, reason: 'default raw source' }
    },
    async expand() {
      return {
        cleanupPaths: [],
        units: [],
      }
    },
  }
}

export function getSourceStrategyPlugins(): SourceStrategyPlugin[] {
  return [createRawSourceStrategyPlugin()]
}

