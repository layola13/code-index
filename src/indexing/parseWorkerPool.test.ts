import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseModulesWithWorkerPool } from './parseWorkerPool.js'
import type { DiscoveredSourceFile } from './discovery.js'

function createDiscoveredFile(index: number): DiscoveredSourceFile {
  return {
    absolutePath: `/tmp/worker-fixture-${index}.ts`,
    relativePath: `worker-fixture-${index}.ts`,
    language: 'typescript',
  }
}

describe('parseModulesWithWorkerPool', () => {
  it('runs parse workers concurrently under Bun', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'code-index-worker-pool-'))
    const workerPath = join(tempDir, 'parse-worker.mjs')
    try {
      await writeFile(
        workerPath,
        [
          "import { parentPort } from 'node:worker_threads'",
          '',
          'parentPort.on("message", async request => {',
          '  await new Promise(resolve => setTimeout(resolve, 150))',
          '  parentPort.postMessage({',
          '    ok: true,',
          '    module: {',
          '      moduleId: request.file.relativePath,',
          '      sourcePath: request.file.absolutePath,',
          '      relativePath: request.file.relativePath,',
          '      language: request.file.language,',
          '      parseMode: "test-worker",',
          '      imports: [],',
          '      importStubs: [],',
          '      exports: [],',
          '      classes: [],',
          '      functions: [],',
          '      notes: [],',
          '      errors: [],',
          '      sourceBytes: 0,',
          '      lineCount: 0,',
          '      truncated: false,',
          '    },',
          '  })',
          '})',
          '',
        ].join('\n'),
        'utf8',
      )

      const files = [0, 1, 2, 3].map(createDiscoveredFile)
      const startedAt = performance.now()
      const modules = await parseModulesWithWorkerPool({
        files,
        maxFileBytes: 1024,
        workerCount: 4,
        workerEntry: workerPath,
      })
      const elapsedMs = performance.now() - startedAt

      expect(modules.map(module => module.relativePath)).toEqual(
        files.map(file => file.relativePath),
      )
      expect(elapsedMs).toBeLessThan(450)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
