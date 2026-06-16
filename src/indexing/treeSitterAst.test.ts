import { chmod, mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { expect, test } from 'bun:test'

import { discoverSourceFiles } from './discovery.js'
import { resolveCodeIndexConfig } from './config.js'
import { parseAstModule } from './treeSitterAst.js'

test('parseAstModule preserves AST structure for cpp, h, go, rust, java, haxe, and zig', () => {
  const cpp = parseAstModule({
    filePath: 'demo/main.cpp',
    moduleId: 'demo/main',
    sourceText: [
      '#include <vector>',
      'namespace ns {',
      'class A { public: int foo(int x); };',
      'int top(int z) { return z; }',
      '}',
      '',
    ].join('\n'),
  })

  expect(cpp?.imports).toContain('<vector>')
  expect(cpp?.classes[0]?.methods[0]?.name).toBe('foo')
  expect(cpp?.functions[0]?.name).toBe('top')
  expect(cpp?.functions[0]?.params[0]?.name).toBe('z')

  const header = parseAstModule({
    filePath: 'demo/main.h',
    moduleId: 'demo/main',
    sourceText: [
      '#include <vector>',
      'namespace ns {',
      'class A { public: int foo(int x); };',
      'int top(int z) { return z; }',
      '}',
      '',
    ].join('\n'),
  })

  expect(header?.classes[0]?.methods[0]?.name).toBe('foo')
  expect(header?.functions[0]?.name).toBe('top')

  const haxe = parseAstModule({
    filePath: 'demo/Main.hx',
    moduleId: 'demo/Main',
    sourceText: [
      'package demo;',
      'import foo.Bar;',
      'class Main {',
      '  public static function main(args:Array<String>, count:Int):Void {',
      '    trace(args);',
      '  }',
      '}',
      '',
    ].join('\n'),
  })

  expect(haxe?.imports).toContain('foo.Bar')
  expect(haxe?.importStubs).toContain('import foo.Bar')
  expect(haxe?.classes[0]?.methods[0]?.name).toBe('main')
  expect(haxe?.classes[0]?.methods[0]?.params.map(param => param.name)).toEqual([
    'args',
    'count',
  ])

  const zig = parseAstModule({
    filePath: 'demo/main.zig',
    moduleId: 'demo/main',
    sourceText: [
      'const std = @import("std");',
      'pub const S = struct {',
      '  pub fn foo(self: *S, x: i32) i32 {',
      '    return x;',
      '  }',
      '};',
      'pub fn top(x: i32) i32 {',
      '  return x;',
      '}',
      '',
    ].join('\n'),
  })

  expect(zig?.imports).toContain('std')
  expect(zig?.importStubs).toContain('import std')
  expect(zig?.classes[0]?.methods[0]?.name).toBe('foo')
  expect(zig?.functions[0]?.name).toBe('top')
  expect(zig?.functions[0]?.params[0]?.name).toBe('x')

  const go = parseAstModule({
    filePath: 'demo/main.go',
    moduleId: 'demo/main',
    sourceText: [
      'package main',
      '',
      'import "fmt"',
      '',
      'type S struct {}',
      '',
      'func (s *S) Foo(x int) string {',
      '  fmt.Println(x)',
      '  return "ok"',
      '}',
      '',
      'func Top(y int) int {',
      '  return y',
      '}',
      '',
    ].join('\n'),
  })

  expect(go?.imports).toContain('fmt')
  expect(go?.classes[0]?.methods[0]?.name).toBe('Foo')
  expect(go?.functions[0]?.name).toBe('Top')

  const rust = parseAstModule({
    filePath: 'demo/main.rs',
    moduleId: 'demo/main',
    sourceText: [
      'use std::fmt;',
      '',
      'pub struct S;',
      '',
      'impl S {',
      '  pub fn foo(&self, x: i32) -> i32 {',
      '    x',
      '  }',
      '}',
      '',
      'pub fn top(y: i32) -> i32 {',
      '  y',
      '}',
      '',
    ].join('\n'),
  })

  expect(rust?.imports).toContain('use std::fmt;')
  expect(rust?.classes[0]?.methods[0]?.name).toBe('foo')
  expect(rust?.functions[0]?.name).toBe('top')

  const sla = parseAstModule({
    filePath: 'demo/main.sla',
    moduleId: 'demo/main',
    sourceText: [
      'use std::fmt;',
      '',
      'pub struct S;',
      '',
      'impl S {',
      '  pub fn foo(&self, x: i32) -> i32 {',
      '    x',
      '  }',
      '}',
      '',
      'pub fn top(y: i32) -> i32 {',
      '  y',
      '}',
      '',
    ].join('\n'),
  })

  expect(sla?.language).toBe('rust')
  expect(sla?.imports).toContain('use std::fmt;')
  expect(sla?.classes[0]?.methods[0]?.name).toBe('foo')
  expect(sla?.functions[0]?.name).toBe('top')

  const java = parseAstModule({
    filePath: 'demo/Main.java',
    moduleId: 'demo/Main',
    sourceText: [
      'package demo;',
      '',
      'import java.util.List;',
      '',
      'public class Main {',
      '  public static int foo(int x) {',
      '    return x;',
      '  }',
      '}',
      '',
    ].join('\n'),
  })

  expect(java?.imports).toContain('java.util.List')
  expect(java?.classes[0]?.methods[0]?.name).toBe('foo')
  expect(java?.classes[0]?.methods[0]?.params[0]?.name).toBe('x')

  const ts = parseAstModule({
    filePath: 'demo/service.ts',
    moduleId: 'demo/service',
    sourceText: [
      'export class Service {',
      '  create(id: string): number {',
      '    return helper(id)',
      '  }',
      '}',
      '',
      'export function helper(id: string): number {',
      '  return id.length',
      '}',
      '',
    ].join('\n'),
  })

  expect(ts?.classes[0]?.name).toBe('Service')
  expect(ts?.classes[0]?.methods[0]?.name).toBe('create')
  expect(ts?.functions[0]?.name).toBe('helper')

  const py = parseAstModule({
    filePath: 'demo/worker.py',
    moduleId: 'demo/worker',
    sourceText: [
      'class Worker(BaseWorker):',
      '    def run(self, task_id: str) -> Result:',
      '        return self.repo.save(task_id)',
      '',
      'def top(value: str) -> None:',
      '    raise RuntimeError(value)',
      '',
    ].join('\n'),
  })

  expect(py?.classes[0]?.name).toBe('Worker')
  expect(py?.classes[0]?.methods[0]?.name).toBe('run')
  expect(py?.functions[0]?.name).toBe('top')
})

test('parseAstModule recognizes additional cpp-style extensions', () => {
  const hh = parseAstModule({
    filePath: 'demo/main.hh',
    moduleId: 'demo/main',
    sourceText: [
      'class Helper {',
      'public:',
      '  int foo(int x);',
      '};',
      '',
    ].join('\n'),
  })

  expect(hh?.language).toBe('cpp')
  expect(hh?.classes[0]?.name).toBe('Helper')
  expect(hh?.classes[0]?.methods[0]?.name).toBe('foo')

  const hpp = parseAstModule({
    filePath: 'demo/main.hpp',
    moduleId: 'demo/main',
    sourceText: [
      'class Header {',
      'public:',
      '  int foo(int x);',
      '};',
      '',
    ].join('\n'),
  })

  expect(hpp?.language).toBe('cpp')
  expect(hpp?.classes[0]?.name).toBe('Header')

  const cpp = parseAstModule({
    filePath: 'demo/main.c++',
    moduleId: 'demo/main',
    sourceText: [
      '#include <vector>',
      'int top(int x) { return x; }',
      '',
    ].join('\n'),
  })

  expect(cpp?.language).toBe('cpp')
  expect(cpp?.functions[0]?.name).toBe('top')
})

test('parseAstModule handles ocaml and ocaml interface files', () => {
  const ml = parseAstModule({
    filePath: 'demo/main.ml',
    moduleId: 'demo/main',
    sourceText: [
      'open Foo',
      'module N = struct',
      '  let add x y = x + y',
      '  type t = A | B',
      '  class c = object',
      '    method foo x = x',
      '  end',
      'end',
      '',
    ].join('\n'),
  })

  expect(ml?.language).toBe('ocaml')
  expect(ml?.imports).toContain('Foo')
  expect(ml?.functions.map(fn => fn.name)).toContain('add')
  expect(ml?.classes.map(cls => cls.name)).toEqual(expect.arrayContaining(['t', 'c']))
  expect(ml?.classes.find(cls => cls.name === 'c')?.methods[0]?.name).toBe('foo')

  const mli = parseAstModule({
    filePath: 'demo/main.mli',
    moduleId: 'demo/main',
    sourceText: [
      'val add : int -> int -> int',
      'module M : sig',
      '  val x : int',
      '  class c : object method foo : int -> int end',
      'end',
      '',
    ].join('\n'),
  })

  expect(mli?.language).toBe('ocaml')
  expect(mli?.functions.find(fn => fn.name === 'add')?.params.map(param => param.annotation)).toEqual([
    'int',
    'int',
  ])
  expect(mli?.functions.find(fn => fn.name === 'x')?.returns).toBe('int')
  expect(mli?.classes.find(cls => cls.name === 'c')?.methods[0]?.name).toBe('foo')
})

test('parseAstModule handles ocaml module type bodies, class types, and include module type', () => {
  const moduleType = parseAstModule({
    filePath: 'src/macro/macroApi.ml',
    moduleId: 'src/macro/macroApi',
    sourceText: [
      'module type InterpApi = sig',
      '  type value',
      '',
      '  val vnull : value',
      '  val vint : int -> value',
      '  val encode_string_map : (\'a -> value) -> (string, \'a) PMap.t -> value',
      '',
      '  include module type of BaseInterp',
      '',
      '  class type printer = object',
      '    method show : value -> string',
      '  end',
      'end',
      '',
    ].join('\n'),
  })

  expect(moduleType?.language).toBe('ocaml')
  expect(moduleType?.notes).toContain('module type InterpApi')
  expect(moduleType?.imports).toContain('BaseInterp')
  expect(moduleType?.importStubs).toContain('include module type of BaseInterp')
  expect(moduleType?.functions.map(fn => fn.name)).toEqual(
    expect.arrayContaining(['vnull', 'vint', 'encode_string_map']),
  )
  expect(moduleType?.classes.map(cls => cls.name)).toEqual(
    expect.arrayContaining(['value', 'printer']),
  )
  expect(moduleType?.classes.find(cls => cls.name === 'printer')?.methods[0]?.name).toBe('show')
  expect(moduleType?.functions.find(fn => fn.name === 'vint')?.returns).toBe('value')
  expect(moduleType?.functions.find(fn => fn.name === 'encode_string_map')?.params[0]?.annotation).toBe(
    "(\'a -> value) -> (string, \'a) PMap.t",
  )
})

test('discoverSourceFiles includes zig extensions', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'code-index-zig-discover-'))

  try {
    await mkdir(join(rootDir, 'src'), { recursive: true })
    await writeFile(join(rootDir, 'src', 'main.zig'), 'pub fn top() void {}\n', 'utf8')

    const config = resolveCodeIndexConfig({ rootDir, outputDir: join(rootDir, '.code_index') })
    const discovered = await discoverSourceFiles(config)
    expect(discovered.files.map(file => file.relativePath)).toContain('src/main.zig')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('discoverSourceFiles includes sla files as rust sources', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'code-index-sla-discover-'))

  try {
    await mkdir(join(rootDir, 'src'), { recursive: true })
    await writeFile(join(rootDir, 'src', 'main.sla'), 'pub fn top() -> i32 { 1 }\n', 'utf8')

    const config = resolveCodeIndexConfig({ rootDir, outputDir: join(rootDir, '.code_index') })
    const discovered = await discoverSourceFiles(config)
    const slaFile = discovered.files.find(file => file.relativePath === 'src/main.sla')
    expect(slaFile?.language).toBe('rust')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('discoverSourceFiles includes ocaml extensions', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'code-index-ocaml-discover-'))

  try {
    await mkdir(join(rootDir, 'src'), { recursive: true })
    await writeFile(join(rootDir, 'src', 'main.ml'), 'let add x y = x + y\n', 'utf8')
    await writeFile(join(rootDir, 'src', 'main.mli'), 'val add : int -> int -> int\n', 'utf8')

    const config = resolveCodeIndexConfig({ rootDir, outputDir: join(rootDir, '.code_index') })
    const discovered = await discoverSourceFiles(config)
    expect(discovered.files.map(file => file.relativePath)).toEqual(
      expect.arrayContaining(['src/main.ml', 'src/main.mli']),
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('discoverSourceFiles skips unreadable directories without failing', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'code-index-unreadable-discover-'))

  try {
    await mkdir(join(rootDir, 'src', 'nested'), { recursive: true })
    await writeFile(join(rootDir, 'src', 'main.ts'), 'export const ok = true\n', 'utf8')
    await writeFile(join(rootDir, 'src', 'nested', 'other.ts'), 'export const nested = true\n', 'utf8')

    try {
      await chmod(join(rootDir, 'src', 'nested'), 0)
      const config = resolveCodeIndexConfig({ rootDir, outputDir: join(rootDir, '.code_index') })
      const discovered = await discoverSourceFiles(config)
      expect(discovered.files.map(file => file.relativePath)).toEqual(['src/main.ts'])
    } finally {
      await chmod(join(rootDir, 'src', 'nested'), 0o755)
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('generic AST fallback still recovers classes and functions', () => {
  const generic = parseAstModule({
    filePath: 'demo/readme.txt',
    moduleId: 'demo/readme',
    sourceText: [
      'class GenericThing {',
      '  run(value) {',
      '    call(value)',
      '  }',
      '}',
      '',
      'def top(value):',
      '  return call(value)',
      '',
    ].join('\n'),
  })

  expect(generic?.classes[0]?.name).toBe('GenericThing')
  expect(generic?.functions[0]?.name).toBe('top')
})

test('generic fallback uses language-pack structure for swift', () => {
  const swift = parseAstModule({
    filePath: 'demo/Main.swift',
    moduleId: 'demo/Main',
    sourceText: [
      'class Main {',
      '  func main(name: String) -> String {',
      '    return name',
      '  }',
      '}',
      '',
    ].join('\n'),
  })

  expect(swift?.classes[0]?.name).toBe('Main')
  expect(swift?.classes[0]?.methods[0]?.name).toBe('main')
  expect(swift?.functions.length).toBe(0)
})
