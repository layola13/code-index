import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { isCompleteModuleIR } from './incremental.js'
import { parseModuleWithBuiltinParsers } from './parseBuiltin.js'

describe('parseModuleWithBuiltinParsers', () => {
  it('returns complete modules from the generic language-pack fallback', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'code-index-parse-builtin-'))
    const filePath = join(rootDir, 'main.go')

    try {
      await writeFile(filePath, 'package main\nfunc main() {}\n', 'utf8')

      const module = await parseModuleWithBuiltinParsers({
        file: {
          absolutePath: filePath,
          relativePath: 'main.go',
          language: 'go',
        },
        maxFileBytes: Number.MAX_SAFE_INTEGER,
      })

      expect(module.language).toBe('go')
      expect(module.sourceBytes).toBeGreaterThan(0)
      expect(module.lineCount).toBeGreaterThan(0)
      expect(module.truncated).toBe(false)
      expect(isCompleteModuleIR(module)).toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
