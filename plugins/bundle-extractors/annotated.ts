import type { DiscoveredSourceFile } from '../../src/indexing/discovery.js'
import { writeTempChunk } from '../../src/indexing/extractorUtils.js'
import type {
  SourceExpansionResult,
  SourceStrategyPlugin,
} from '../../src/indexing/strategyTypes.js'
import { basename, join } from 'path'
import {
  hasInlineSourceMap,
  hasSourceMapComment,
  normalizeSampleText,
  splitAnnotatedBundleModules,
} from './shared.js'

type AnnotatedBundleStrategyDefinition = {
  kind: string
  confidence: number
  detectText: (text: string) => boolean
  reason: string
}

export function createAnnotatedBundleSourceStrategyPlugin(
  definition: AnnotatedBundleStrategyDefinition,
): SourceStrategyPlugin {
  return {
    kind: definition.kind,
    detect({ headText, tailText, hasSourceMapComment: detectedSourceMapComment }) {
      const text = normalizeSampleText({ headText, tailText })
      if (detectedSourceMapComment || hasInlineSourceMap(text)) {
        return null
      }
      if (!definition.detectText(text)) {
        return null
      }
      return {
        kind: definition.kind,
        confidence: definition.confidence,
        reason: definition.reason,
      }
    },
    async expand({ file, headText, tempRootDir, tailText }) {
      const bundleText = normalizeSampleText({ headText, tailText })
      const split = await splitAnnotatedBundleModules({
        bundleRelativePath: file.relativePath,
        bundleText,
        kind: definition.kind,
        preserveCandidatePath: definition.kind !== 'webpack',
        tempRootDir,
      })

      if (split.units.length > 0 || definition.kind !== 'webpack') {
        return split
      }

      const normalizedText = bundleText.replace(/\r\n?/g, '\n')
      const baseName = basename(file.relativePath).replace(/\.[^.]+$/, '')
      const relativePath = `chunks/${baseName}-001.js`
      const absolutePath = join(tempRootDir, definition.kind, relativePath)
      await writeTempChunk({
        tempRootDir: join(tempRootDir, definition.kind),
        relativePath,
        text: normalizedText,
      })

      return {
        cleanupPaths: [join(tempRootDir, definition.kind)],
        units: [
          {
            file: {
              absolutePath,
              relativePath,
              language: 'javascript',
              originPath: file.relativePath,
              originStartCharacter: 1,
              originStartLine: 1,
            } satisfies DiscoveredSourceFile,
            originFile: file,
            fingerprintPath: absolutePath,
            strategyKind: definition.kind,
          },
        ],
      }
    },
  }
}
