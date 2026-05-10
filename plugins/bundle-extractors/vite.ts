import type { SourceStrategyPlugin } from '../../src/indexing/strategyTypes.js'
import {
  hasInlineSourceMap,
  normalizeSampleText,
} from './shared.js'
import { splitTopLevelJavaScriptModules } from './minified-js.js'

function looksLikeVite(text: string): boolean {
  return /__vitePreload|__vite__|__vite_ssr_import_/.test(text)
}

export function createViteSourceStrategyPlugin(): SourceStrategyPlugin {
  return {
    kind: 'vite',
    detect({ headText, tailText, hasSourceMapComment }) {
      const text = normalizeSampleText({ headText, tailText })
      if (hasSourceMapComment || hasInlineSourceMap(text)) {
        return null
      }
      return looksLikeVite(text)
        ? { kind: 'vite', confidence: 0.9, reason: 'vite bundle markers detected' }
        : null
    },
    async expand({ file, headText, tempRootDir, tailText }) {
      const bundleText = normalizeSampleText({ headText, tailText })
      const split = await splitTopLevelJavaScriptModules({
        bundleRelativePath: file.relativePath,
        bundleText,
        kind: 'vite',
        tempRootDir,
      })

      if (split.units.length > 0) {
        return split
      }

      return {
        cleanupPaths: [],
        units: [],
      }
    },
  }
}

export function getSourceStrategyPlugins(): SourceStrategyPlugin[] {
  return [createViteSourceStrategyPlugin()]
}
