import { createRequire } from 'module'
import { resolve } from 'path'

import type { AstParser } from './astCommon.js'
type LanguagePackModule = typeof import('@kreuzberg/tree-sitter-language-pack')
type LanguagePackProcessConfig = Parameters<LanguagePackModule['process']>[1]

export type TreeSitterLanguage = {
  language: unknown
  name?: string | null
}

const nodeRequire = createRequire(import.meta.url)
const treeSitterRequire = createRequire(
  resolve(process.cwd(), 'node_modules/tree-sitter/index.js'),
)

let cachedLanguagePack: LanguagePackModule | null = null
let cachedTreeSitterModule: unknown | null = null

function patchReportForBun(): (() => void) | null {
  const report = process.report
  const getReport = report?.getReport
  if (!report || typeof getReport !== 'function') {
    return null
  }

  const original = getReport.bind(report)
  const sample = original()
  const header = sample?.header
  if (header && typeof header.glibcVersion === 'string') {
    return null
  }

  report.getReport = ((...args: Parameters<typeof getReport>) => {
    const current = original(...args)
    if (current?.header && current.header.glibcVersion === undefined) {
      const fallback =
        current.header.glibcVersionRuntime ?? current.header.glibcVersionCompiler
      if (typeof fallback === 'string' && fallback) {
        current.header.glibcVersion = fallback
      }
    }
    return current
  }) as typeof getReport

  return () => {
    report.getReport = getReport
  }
}

function loadLanguagePack(): LanguagePackModule {
  if (cachedLanguagePack) {
    return cachedLanguagePack
  }

  const restore = patchReportForBun()
  try {
    cachedLanguagePack = nodeRequire(
      '@kreuzberg/tree-sitter-language-pack',
    ) as typeof import('@kreuzberg/tree-sitter-language-pack')
    return cachedLanguagePack
  } finally {
    restore?.()
  }
}

function loadTreeSitterModule(): unknown {
  if (cachedTreeSitterModule) {
    return cachedTreeSitterModule
  }

  const restore = patchReportForBun()
  const savedBunVersion = process.versions.bun
  try {
    delete (process.versions as { bun?: string }).bun
    cachedTreeSitterModule = treeSitterRequire('tree-sitter')
    return cachedTreeSitterModule
  } finally {
    if (savedBunVersion) {
      ;(process.versions as { bun?: string }).bun = savedBunVersion
    }
    restore?.()
  }
}

export function loadTreeSitter(): unknown {
  return loadTreeSitterModule()
}

export function ensureLanguageAvailability(names: readonly string[]): number {
  const pack = loadLanguagePack()
  return pack.download([...new Set(names)])
}

export function detectLanguageFromFile(filePath: string): string | undefined | null {
  const pack = loadLanguagePack()
  return pack.detectLanguageFromPath(filePath)
}

export function detectLanguageFromFileExtension(
  extension: string,
): string | undefined | null {
  const pack = loadLanguagePack()
  return pack.detectLanguageFromExtension(extension)
}

export function detectLanguageFromContent(
  content: string,
): string | undefined | null {
  const pack = loadLanguagePack()
  return pack.detectLanguageFromContent(content)
}

export function processWithLanguagePack(
  source: string,
  config: LanguagePackProcessConfig,
): ReturnType<LanguagePackModule['process']> {
  const pack = loadLanguagePack()
  return pack.process(source, config)
}

export function downloadLanguagePack(names: readonly string[]): number {
  return ensureLanguageAvailability(names)
}

export function loadTreeSitterParser(): AstParser {
  const ParserCtor = loadTreeSitterModule() as unknown as { new (): AstParser }
  if (typeof ParserCtor !== 'function') {
    throw new Error('tree-sitter parser constructor is unavailable')
  }
  return new ParserCtor() as NativeTreeSitterParser
}
