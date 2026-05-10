import { createRequire } from 'module'
import { dirname, join } from 'path'
import type { DiscoveredSourceFile } from '../../src/indexing/discovery.js'
import { loadTreeSitterParser } from '../../src/indexing/treeSitter.js'
import type {
  SourceExpansionResult,
  SourceStrategyPlugin,
} from '../../src/indexing/strategyTypes.js'
import {
  computeLineStarts,
  createLeadingPadding,
  hasInlineSourceMap,
  isLikelyMinifiedText,
  normalizeSampleText,
} from './shared.js'

type SyntaxNode = ReturnType<ReturnType<typeof loadTreeSitterParser>['parse']>['rootNode']

const nodeRequire = createRequire(import.meta.url)
let cachedJavaScriptLanguage: unknown | null = null
let cachedParser: ReturnType<typeof loadTreeSitterParser> | null = null

function loadJavaScriptLanguage(): unknown {
  if (cachedJavaScriptLanguage) {
    return cachedJavaScriptLanguage
  }

  const resolvedPackageJson = nodeRequire.resolve('tree-sitter-javascript/package.json')
  const packageRoot = dirname(resolvedPackageJson)
  const binding = nodeRequire('node-gyp-build')(packageRoot) as {
    language?: unknown
  }
  const value = binding.language ?? binding
  if (!value) {
    throw new Error('tree-sitter-javascript binding unavailable')
  }
  cachedJavaScriptLanguage = value
  return value
}

function loadJavaScriptParser(): ReturnType<typeof loadTreeSitterParser> {
  if (cachedParser) {
    return cachedParser
  }

  const parser = loadTreeSitterParser()
  ;(parser as { setLanguage(language?: unknown): void }).setLanguage(
    loadJavaScriptLanguage(),
  )
  cachedParser = parser
  return parser
}

function getNodeText(sourceText: string, node: SyntaxNode | null | undefined): string {
  if (!node) {
    return ''
  }
  return sourceText.slice(node.startIndex, node.endIndex)
}

function resolveChunkRelativePath(args: {
  bundleRelativePath: string
  index: number
}): string {
  const base = args.bundleRelativePath.replaceAll('\\', '/').split('/').pop() ?? 'bundle.js'
  const safeBase = base.replace(/\.[^.]+$/, '')
  return `chunks/${safeBase}-${String(args.index + 1).padStart(3, '0')}.js`
}

export async function splitTopLevelJavaScriptModules(args: {
  bundleRelativePath: string
  bundleText: string
  tempRootDir: string
  kind: string
}): Promise<SourceExpansionResult> {
  const text = args.bundleText.replace(/\r\n?/g, '\n')
  let root: SyntaxNode | null = null

  try {
    const parser = loadJavaScriptParser()
    const tree = parser.parse(text)
    root = tree?.rootNode as SyntaxNode | null
  } catch {
    root = null
  }

  const topLevelNodes = root?.namedChildren.filter(node => node.type !== 'comment') ?? []
  if (topLevelNodes.length === 0) {
    return {
      cleanupPaths: [],
      units: [],
    }
  }

  const chunks = topLevelNodes.map((node, index) => {
    const startLine = node.startPosition.row + 1
    const startColumn = node.startPosition.column + 1
    const relativePath = resolveChunkRelativePath({
      bundleRelativePath: args.bundleRelativePath,
      index,
    })
    const textChunk = `${createLeadingPadding(startLine, startColumn)}${getNodeText(text, node)}`
    const absolutePath = join(args.tempRootDir, args.kind, relativePath)
    return {
      absolutePath,
      originStartCharacter: startColumn,
      originStartLine: startLine,
      relativePath,
      text: textChunk,
    }
  })

  await Promise.all(
    chunks.map(async chunk => {
      const { writeTempChunk } = await import('../../src/indexing/extractorUtils.js')
      await writeTempChunk({
        tempRootDir: join(args.tempRootDir, args.kind),
        relativePath: chunk.relativePath,
        text: chunk.text,
      })
    }),
  )

  return {
    cleanupPaths: [join(args.tempRootDir, args.kind)],
    units: chunks.map(chunk => ({
      file: {
        absolutePath: chunk.absolutePath,
        relativePath: chunk.relativePath,
        language: 'javascript',
        originPath: args.bundleRelativePath,
        originStartCharacter: chunk.originStartCharacter,
        originStartLine: chunk.originStartLine,
      } satisfies DiscoveredSourceFile,
      originFile: {
        absolutePath: args.bundleRelativePath,
        relativePath: args.bundleRelativePath,
        language: 'javascript',
      },
      fingerprintPath: chunk.absolutePath,
      strategyKind: args.kind,
    })),
  }
}

function looksLikeMinifiedJs(text: string): boolean {
  return isLikelyMinifiedText(text)
}

export function createMinifiedJsSourceStrategyPlugin(): SourceStrategyPlugin {
  return {
    kind: 'minified-js',
    detect({ headText, tailText, hasSourceMapComment }) {
      const text = normalizeSampleText({ headText, tailText })
      if (hasSourceMapComment || hasInlineSourceMap(text)) {
        return null
      }
      return looksLikeMinifiedJs(text)
        ? { kind: 'minified-js', confidence: 0.75, reason: 'minified bundle detected' }
        : null
    },
    async expand({ file, headText, tempRootDir, tailText }) {
      const bundleText = normalizeSampleText({ headText, tailText })
      const split = await splitTopLevelJavaScriptModules({
        bundleRelativePath: file.relativePath,
        bundleText,
        kind: 'minified-js',
        tempRootDir,
      })

      if (split.units.length > 0) {
        return split
      }

      const relativePath = resolveChunkRelativePath({
        bundleRelativePath: file.relativePath,
        index: 0,
      })
      const absolutePath = join(tempRootDir, 'minified-js', relativePath)
      const normalizedText = bundleText.replace(/\r\n?/g, '\n')
      const { writeTempChunk } = await import('../../src/indexing/extractorUtils.js')
      await writeTempChunk({
        tempRootDir: join(tempRootDir, 'minified-js'),
        relativePath,
        text: normalizedText,
      })

      return {
        cleanupPaths: [join(tempRootDir, 'minified-js')],
        units: [
          {
            file: {
              absolutePath,
              relativePath,
              language: 'javascript',
              originPath: file.relativePath,
              originStartCharacter: 1,
              originStartLine: 1,
            },
            originFile: file,
            fingerprintPath: absolutePath,
            strategyKind: 'minified-js',
          },
        ],
      }
    },
  }
}

export function getSourceStrategyPlugins(): SourceStrategyPlugin[] {
  return [createMinifiedJsSourceStrategyPlugin()]
}
