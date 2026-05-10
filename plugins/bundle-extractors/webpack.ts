import { createAnnotatedBundleSourceStrategyPlugin } from './annotated.js'

function looksLikeWebpack(text: string): boolean {
  return /webpackBootstrap|__webpack_require__|\/\*\s*harmony export\s*\*\//.test(text)
}

export function createWebpackSourceStrategyPlugin() {
  return createAnnotatedBundleSourceStrategyPlugin({
    kind: 'webpack',
    confidence: 0.95,
    detectText: looksLikeWebpack,
    reason: 'webpack bundle markers detected',
  })
}

export function getSourceStrategyPlugins() {
  return [createWebpackSourceStrategyPlugin()]
}
