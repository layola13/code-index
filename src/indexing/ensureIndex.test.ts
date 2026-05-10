import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { expect, test } from 'bun:test'

import { ensureIndexArtifacts } from './ensureIndex.js'

test('ensureIndexArtifacts builds missing indexes and discovers haxe files', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'code-index-hx-'))

  try {
    await mkdir(join(rootDir, 'src'), { recursive: true })
    await writeFile(
      join(rootDir, 'src', 'Main.hx'),
      [
        'class Main {',
        '  public static function main() {}',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )

    const outputDir = join(rootDir, '.code_index')
    const firstBuild = await ensureIndexArtifacts({
      outputDir,
      requiredArtifacts: ['index/manifest.json', 'index/modules.jsonl'],
      rootDir,
    })

    expect(firstBuild).toBe(true)

    const modulesJsonl = await readFile(
      join(outputDir, 'index', 'modules.jsonl'),
      'utf8',
    )
    expect(modulesJsonl).toContain('src/Main.hx')

    const secondBuild = await ensureIndexArtifacts({
      outputDir,
      requiredArtifacts: ['index/manifest.json', 'index/modules.jsonl'],
      rootDir,
    })

    expect(secondBuild).toBe(false)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
