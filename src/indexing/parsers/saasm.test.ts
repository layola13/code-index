import { expect, test } from 'bun:test'

import { resolveCodeIndexConfig } from '../config.js'
import { parseSaasmModule } from './saasm.js'

test('parseSaasmModule extracts SA declarations, metadata, and module skeleton inputs', () => {
  const sourceText = [
    '@import "sa_std/io/print.saasm-iface"',
    '#loc "demo.rs":12:3',
    '#def Buffer_SIZE = 32',
    '@const HELLO_BYTES = utf8:"hello"',
    '@main() -> i32:',
    'L_ENTRY:',
    '  call @sa_print_bytes(&HELLO_BYTES, 5)',
    '  return 0',
    '',
    '@ffi_wrapper open_file(*path: ptr) -> ptr:',
    '  raw = *path',
    '  result = call @c_open(raw)',
    '  return result',
    '',
    '@extern c_open(*path: ptr) -> ptr',
    '',
  ].join('\n')

  const module = parseSaasmModule({
    config: resolveCodeIndexConfig({ rootDir: '/repo', outputDir: '/repo/.code_index' }),
    file: {
      absolutePath: '/repo/src/main.saasm',
      language: 'saasm',
      relativePath: 'src/main.saasm',
    },
    source: {
      byteSize: Buffer.byteLength(sourceText, 'utf8'),
      originPath: '/repo/generated/main.saasm',
      originStartCharacter: 7,
      originStartLine: 12,
      text: sourceText,
      truncated: false,
    },
  })

  expect(module.language).toBe('saasm')
  expect(module.parseMode).toBe('saasm-line')
  expect(module.moduleId).toBe('src/main.saasm')
  expect(module.imports).toEqual(['sa_std/io/print.saasm-iface'])
  expect(module.importStubs).toContain('# import sa_std/io/print.saasm-iface')
  expect(module.notes).toContain('Buffer_SIZE')
  expect(module.notes).toContain('HELLO_BYTES')
  expect(module.notes).toContain('L_ENTRY')
  expect(module.originPath).toBe('/repo/generated/main.saasm')
  expect(module.originStartLine).toBe(12)
  expect(module.originStartCharacter).toBe(7)

  expect(module.functions.map(fn => fn.qualifiedName)).toEqual([
    'src/main.saasm::main',
    'src/main.saasm::open_file',
    'src/main.saasm::c_open',
  ])

  const main = module.functions[0]
  expect(main?.returns).toBe('i32')
  expect(main?.calls).toEqual(['sa_print_bytes'])
  expect(main?.sourceLines).toEqual({ start: 5, end: 9 })

  const wrapper = module.functions[1]
  expect(wrapper?.decorators).toEqual(['ffi_wrapper'])
  expect(wrapper?.params).toEqual([{ name: 'path', annotation: 'ptr' }])
  expect(wrapper?.calls).toEqual(['c_open'])

  const extern = module.functions[2]
  expect(extern?.decorators).toEqual(['extern'])
  expect(extern?.sourceLines).toEqual({ start: 15, end: 15 })
})
