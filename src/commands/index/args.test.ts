import { describe, expect, it } from 'bun:test'
import { parseIndexArgs } from './args.js'

describe('parseIndexArgs', () => {
  it('parses source strategy kinds from repeated flags', () => {
    const parsed = parseIndexArgs(
      'build . --source-strategy webpack --source-strategy auto',
    )

    expect(parsed.kind).toBe('run')
    expect(parsed.rootDir).toBe('.')
    expect(parsed.sourceStrategyKinds).toEqual(['webpack', 'auto'])
  })

  it('parses source strategy kinds from equals syntax', () => {
    const parsed = parseIndexArgs('build src --source-strategy=esbuild')

    expect(parsed.kind).toBe('run')
    expect(parsed.rootDir).toBe('src')
    expect(parsed.sourceStrategyKinds).toEqual(['esbuild'])
  })

  it('parses source strategy plugin manifests from repeated flags', () => {
    const parsed = parseIndexArgs(
      'build . --source-strategy-plugin-manifest plugins/a/.codex-plugin/plugin.json --source-strategy-plugin-manifest=plugins/b/.codex-plugin/plugin.json',
    )

    expect(parsed.kind).toBe('run')
    expect(parsed.sourceStrategyPluginManifests).toEqual([
      'plugins/a/.codex-plugin/plugin.json',
      'plugins/b/.codex-plugin/plugin.json',
    ])
  })

  it('preserves auto plugin discovery by default', () => {
    const parsed = parseIndexArgs('build .')

    expect(parsed.kind).toBe('run')
    expect(parsed.sourceStrategyPluginManifests).toBeUndefined()
  })

  it('parses rust engine aliases', () => {
    const parsed = parseIndexArgs('build /repo --engine rs --workers 8')

    expect(parsed.kind).toBe('run')
    expect(parsed.rootDir).toBe('/repo')
    expect(parsed.engine).toBe('rust')
    expect(parsed.workers).toBe(8)
  })

  it('parses typescript engine aliases', () => {
    const parsed = parseIndexArgs('build . --engine=ts')

    expect(parsed.kind).toBe('run')
    expect(parsed.engine).toBe('typescript')
  })

  it('rejects unknown engines', () => {
    const parsed = parseIndexArgs('build . --engine go')

    expect(parsed.kind).toBe('error')
  })
})
