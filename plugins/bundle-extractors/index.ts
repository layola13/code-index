import type { SourceStrategyPlugin } from '../../src/indexing/strategyTypes.js'
import { createEsbuildSourceStrategyPlugin } from './esbuild.js'
import { createMinifiedJsSourceStrategyPlugin } from './minified-js.js'
import { createRawSourceStrategyPlugin } from './raw.js'
import { createViteSourceStrategyPlugin } from './vite.js'
import { createWebpackSourceStrategyPlugin } from './webpack.js'

export function getBuiltinSourceStrategyPlugins(): SourceStrategyPlugin[] {
  return [
    createRawSourceStrategyPlugin(),
    createWebpackSourceStrategyPlugin(),
    createEsbuildSourceStrategyPlugin(),
    createViteSourceStrategyPlugin(),
    createMinifiedJsSourceStrategyPlugin(),
  ]
}

export function getSourceStrategyPlugins(): SourceStrategyPlugin[] {
  return getBuiltinSourceStrategyPlugins()
}

export {
  createEsbuildSourceStrategyPlugin,
  createMinifiedJsSourceStrategyPlugin,
  createRawSourceStrategyPlugin,
  createViteSourceStrategyPlugin,
  createWebpackSourceStrategyPlugin,
}
