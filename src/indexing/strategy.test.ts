import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildCodeIndex } from './build.js'
import {
  registerSourceStrategyPlugin,
  resetSourceStrategyPluginsForTesting,
  unregisterSourceStrategyPlugin,
} from './strategy.js'
import { loadSourceStrategyPluginsFromPackageManifest } from './sourceStrategyPluginPackage.js'

describe('source strategy plugins', () => {
  it('loads builtin bundle extractor plugins from the plugin package manifest', async () => {
    const plugins = await loadSourceStrategyPluginsFromPackageManifest(
      join(process.cwd(), 'plugins', 'bundle-extractors', '.codex-plugin', 'plugin.json'),
    )

    expect(plugins.map(plugin => plugin.kind).sort()).toEqual([
      'esbuild',
      'minified-js',
      'raw',
      'vite',
      'webpack',
    ])
  })

  it('supports custom plugins and unregistering them', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'code-index-custom-strategy-'))

    const plugin = {
      kind: 'custom-bundle',
      detect: ({ headText, hasSourceMapComment, tailText }: { headText: string; hasSourceMapComment: boolean; tailText: string }) => {
        if (hasSourceMapComment) {
          return null
        }
        const text = `${headText}\n${tailText}`
        return text.includes('__custom_bundle__')
          ? { kind: 'custom-bundle', confidence: 1, reason: 'custom marker' }
          : null
      },
      expand: async ({ file, tempRootDir }: { file: { absolutePath: string; language: string; relativePath: string }; tempRootDir: string }) => {
        const tempPath = join(tempRootDir, 'custom-bundle', 'src', 'custom.js')
        await mkdir(join(tempRootDir, 'custom-bundle', 'src'), { recursive: true })
        await writeFile(tempPath, 'export function customValue() { return 7 }\n', 'utf8')
        return {
          cleanupPaths: [join(tempRootDir, 'custom-bundle')],
          units: [
            {
              file: {
                absolutePath: tempPath,
                relativePath: 'src/custom.js',
                language: file.language,
                originPath: file.relativePath,
                originStartLine: 1,
                originStartCharacter: 1,
              },
              originFile: file,
              fingerprintPath: tempPath,
              strategyKind: 'custom-bundle',
            },
          ],
        }
      },
    }

    try {
      registerSourceStrategyPlugin(plugin)

      await writeFile(
        join(rootDir, 'bundle.js'),
        [
          '/******/ (() => { // webpackBootstrap',
          '/******/  __custom_bundle__',
          '/******/ })();',
          '',
        ].join('\n'),
        'utf8',
      )

      const enabled = await buildCodeIndex({
        rootDir,
        outputDir: join(rootDir, '.code_index'),
        sourceStrategyKinds: ['custom-bundle'],
      })
      expect(enabled.manifest.moduleCount).toBe(1)

      unregisterSourceStrategyPlugin('custom-bundle')

      const skipped = await buildCodeIndex({
        rootDir,
        outputDir: join(rootDir, '.code_index'),
        sourceStrategyKinds: ['custom-bundle'],
      })
      expect(skipped.manifest.moduleCount).toBe(0)
    } finally {
      resetSourceStrategyPluginsForTesting()
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
