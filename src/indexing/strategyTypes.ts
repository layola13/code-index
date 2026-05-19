import type { DiscoveredSourceFile } from './discovery.js'
import type { LoadedSource } from './source.js'

export type BuiltinSourceStrategyKind =
  | 'raw'
  | 'webpack'
  | 'esbuild'
  | 'vite'
  | 'minified-js'

export type SourceStrategyKind = string

export type StrategyDetection = {
  confidence: number
  kind: string
  reason: string
}

export type SourceUnit = {
  file: DiscoveredSourceFile
  originFile: DiscoveredSourceFile
  source?: LoadedSource
  fingerprintPath?: string
  originPath?: string
  originStartLine?: number
  originStartCharacter?: number
  strategyKind: string
}

export type SourceExpansionResult = {
  cleanupPaths: string[]
  units: SourceUnit[]
}

export type SourceStrategyPlugin = {
  kind: string
  detect: (args: {
    file: DiscoveredSourceFile
    headText: string
    tailText: string
    hasSourceMapComment: boolean
  }) => StrategyDetection | null
  expand: (args: {
    file: DiscoveredSourceFile
    headText: string
    rootDir: string
    tempRootDir: string
    tailText: string
    signal?: AbortSignal
  }) => Promise<SourceExpansionResult>
}
