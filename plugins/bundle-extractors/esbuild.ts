import { createAnnotatedBundleSourceStrategyPlugin } from './annotated.js'

function looksLikeEsbuild(text: string): boolean {
  return (
    /__commonJS|__toESM|__name/.test(text) ||
    (/\(\(\)\s*=>\s*\{/.test(text) &&
      /(?:^|\n)\s*\/\/\s*(?:\.{2}\/)+.*(?:\/|\\).+\.(?:m?js|cjs|js)\s*(?:\n|$)/m.test(text))
  )
}

export function createEsbuildSourceStrategyPlugin() {
  return createAnnotatedBundleSourceStrategyPlugin({
    kind: 'esbuild',
    confidence: 0.95,
    detectText: looksLikeEsbuild,
    reason: 'esbuild bundle markers detected',
  })
}

export function getSourceStrategyPlugins() {
  return [createEsbuildSourceStrategyPlugin()]
}
