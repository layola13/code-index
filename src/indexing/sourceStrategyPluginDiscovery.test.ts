import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { discoverSourceStrategyPluginManifests } from './sourceStrategyPluginDiscovery.js'

describe('source strategy plugin discovery', () => {
  it('discovers plugin manifests under the root plugins directory', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'code-index-plugin-discovery-'))

    try {
      await mkdir(join(rootDir, 'plugins', 'bundle-extractors', '.codex-plugin'), {
        recursive: true,
      })
      await writeFile(
        join(rootDir, 'plugins', 'bundle-extractors', '.codex-plugin', 'plugin.json'),
        JSON.stringify(
          {
            name: 'bundle-extractors',
            version: '0.1.0',
            sourceStrategyPluginEntry: './index.ts',
          },
          null,
          2,
        ),
        'utf8',
      )

      const manifests = await discoverSourceStrategyPluginManifests(rootDir)

      expect(manifests).toEqual([
        join(rootDir, 'plugins', 'bundle-extractors', '.codex-plugin', 'plugin.json'),
      ])
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
