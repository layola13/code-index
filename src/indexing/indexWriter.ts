import { mkdir, writeFile } from 'fs/promises'
import { join, parse as parsePath, posix } from 'path'
import {
  CODE_INDEX_ARTIFACT_VERSION,
  type CodeIndexManifest,
  type EdgeIR,
  type FunctionIR,
  type ModuleIR,
} from './ir.js'
import { isCompleteModuleIR } from './incremental.js'
import { safePythonIdentifier } from './parserUtils.js'
import { createYieldState, maybeYieldToEventLoop } from './runtime.js'

function makeEdgeId(index: number): string {
  return `edge-${index.toString().padStart(6, '0')}`
}

function renderFunctionSignature(fn: FunctionIR): string {
  const params = fn.params
    .map(param =>
      param.annotation
        ? `${param.name}: ${param.annotation}`
        : param.name,
    )
    .join(', ')

  return `${fn.name}(${params})${fn.returns ? ` -> ${fn.returns}` : ''}`
}

function sortCountEntries(
  values: Record<string, number>,
): Array<[string, number]> {
  return Object.entries(values).sort(([left], [right]) =>
    left.localeCompare(right),
  )
}

function sortCountRecord(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(sortCountEntries(values))
}

function collectCompleteModules(modules: readonly ModuleIR[]): ModuleIR[] {
  return modules.filter(isCompleteModuleIR)
}

export function formatCountSummary(values: Record<string, number>): string {
  return sortCountEntries(values)
    .map(([name, count]) => `${name}: ${count}`)
    .join(' | ')
}

export async function buildEdges(args: {
  modules: readonly ModuleIR[]
  signal?: AbortSignal
}): Promise<EdgeIR[]> {
  const edges: EdgeIR[] = []
  const yieldState = createYieldState()

  for (const module of collectCompleteModules(args.modules)) {
    args.signal?.throwIfAborted?.()
    await maybeYieldToEventLoop(yieldState)
    for (const imported of module.imports) {
      edges.push({
        edgeId: makeEdgeId(edges.length + 1),
        kind: 'imports',
        source: module.moduleId,
        target: imported,
        sourceFile: module.relativePath,
      })
    }

    for (const cls of module.classes) {
      for (const base of cls.bases) {
        edges.push({
          edgeId: makeEdgeId(edges.length + 1),
          kind: 'inherits',
          source: cls.qualifiedName,
          target: base,
          sourceFile: module.relativePath,
          sourceSymbol: cls.qualifiedName,
          lineStart: cls.sourceLines.start,
          lineEnd: cls.sourceLines.end,
        })
      }

      for (const dependency of cls.dependsOn) {
        edges.push({
          edgeId: makeEdgeId(edges.length + 1),
          kind: 'depends_on',
          source: cls.qualifiedName,
          target: dependency,
          sourceFile: module.relativePath,
          sourceSymbol: cls.qualifiedName,
          lineStart: cls.sourceLines.start,
          lineEnd: cls.sourceLines.end,
        })
      }

      for (const method of cls.methods) {
        for (const call of method.calls) {
          edges.push({
            edgeId: makeEdgeId(edges.length + 1),
            kind: 'calls',
            source: method.qualifiedName,
            target: call,
            sourceFile: module.relativePath,
            sourceSymbol: method.qualifiedName,
            lineStart: method.sourceLines.start,
            lineEnd: method.sourceLines.end,
          })
        }
      }
    }

    for (const fn of module.functions) {
      for (const call of fn.calls) {
        edges.push({
          edgeId: makeEdgeId(edges.length + 1),
          kind: 'calls',
          source: fn.qualifiedName,
          target: call,
          sourceFile: module.relativePath,
          sourceSymbol: fn.qualifiedName,
          lineStart: fn.sourceLines.start,
          lineEnd: fn.sourceLines.end,
        })
      }
    }
  }

  return edges
}

export function buildManifest(args: {
  edges: readonly EdgeIR[]
  fileLimitReached: boolean
  maxFiles?: number
  modules: readonly ModuleIR[]
  outputDir: string
  rootDir: string
}): CodeIndexManifest {
  const languages: Record<string, number> = {}
  const parseModes: Record<string, number> = {}
  let classCount = 0
  let functionCount = 0
  let methodCount = 0
  let truncatedCount = 0

  for (const module of collectCompleteModules(args.modules)) {
    languages[module.language] = (languages[module.language] ?? 0) + 1
    parseModes[module.parseMode] = (parseModes[module.parseMode] ?? 0) + 1
    classCount += module.classes.length
    functionCount += module.functions.length
    methodCount += module.classes.reduce(
      (count, cls) => count + cls.methods.length,
      0,
    )
    truncatedCount += module.truncated ? 1 : 0
  }

  return {
    artifactVersion: CODE_INDEX_ARTIFACT_VERSION,
    rootDir: args.rootDir,
    outputDir: args.outputDir,
    createdAt: new Date().toISOString(),
    moduleCount: collectCompleteModules(args.modules).length,
    classCount,
    functionCount,
    methodCount,
    edgeCount: args.edges.length,
    fileLimit: args.maxFiles,
    fileLimitReached: args.fileLimitReached,
    truncatedCount,
    languages: sortCountRecord(languages),
    parseModes: sortCountRecord(parseModes),
  }
}

function renderSummary(args: {
  edges: readonly EdgeIR[]
  manifest: CodeIndexManifest
  modules: readonly ModuleIR[]
  outputDir: string
}): string {
  const modules = collectCompleteModules(args.modules)
  const largestModules = [...modules]
    .sort((left, right) => {
      const leftCount =
        left.functions.length +
        left.classes.length +
        left.classes.reduce((count, cls) => count + cls.methods.length, 0)
      const rightCount =
        right.functions.length +
        right.classes.length +
        right.classes.reduce((count, cls) => count + cls.methods.length, 0)
      return rightCount - leftCount
    })
    .slice(0, 20)

  const lines = [
    '# Code Index Summary',
    '',
    `- root: ${args.manifest.rootDir}`,
    `- output: ${args.outputDir}`,
    `- modules: ${args.manifest.moduleCount}`,
    `- classes: ${args.manifest.classCount}`,
    `- functions: ${args.manifest.functionCount}`,
    `- methods: ${args.manifest.methodCount}`,
    `- edges: ${args.manifest.edgeCount}`,
    `- file_limit: ${args.manifest.fileLimit ?? 'none'}`,
    `- file_limit_reached: ${args.manifest.fileLimitReached ? 'yes' : 'no'}`,
    `- truncated_files: ${args.manifest.truncatedCount}`,
    '',
    '## Languages',
    ...sortCountEntries(args.manifest.languages).map(
      ([language, count]) => `- ${language}: ${count}`,
    ),
    '',
    '## Parse Modes',
    ...sortCountEntries(args.manifest.parseModes).map(
      ([mode, count]) => `- ${mode}: ${count}`,
    ),
    '',
    '## Largest Modules',
    '| Module | Classes | Functions | Methods | Imports | Parse mode |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...largestModules.map(module => {
      const methods = module.classes.reduce(
        (count, cls) => count + cls.methods.length,
        0,
      )
      return `| ${module.relativePath.replaceAll('|', '\\|')} | ${module.classes.length} | ${module.functions.length} | ${methods} | ${module.imports.length} | ${module.parseMode} |`
    }),
  ]

  const failedModules = modules.filter(module => module.errors.length > 0)
  if (failedModules.length > 0) {
    lines.push('', '## Parse Errors')
    for (const module of failedModules.slice(0, 20)) {
      lines.push(`- ${module.relativePath}: ${module.errors.join('; ')}`)
    }
  }

  return lines.join('\n') + '\n'
}

const JS_LIKE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
] as const

function normalizePathish(value: string): string {
  const trimmed = value.trim().replaceAll('\\', '/')
  if (!trimmed) {
    return ''
  }

  const withoutDotPrefix = trimmed.startsWith('./')
    ? trimmed.slice(2)
    : trimmed
  return withoutDotPrefix.replace(/\/+$/g, '')
}

function stripModuleExtension(value: string): string {
  return value.replace(/\.(?:[cm]?[jt]sx?|py)$/i, '')
}

function relatedImportExtensions(relativePath: string): readonly string[] {
  const extension = posix.extname(relativePath).toLowerCase()
  if (JS_LIKE_EXTENSIONS.includes(extension as (typeof JS_LIKE_EXTENSIONS)[number])) {
    return JS_LIKE_EXTENSIONS
  }
  if (extension === '.py') {
    return ['.py']
  }
  return extension ? [extension] : []
}

function addModuleAlias(
  aliasMap: Map<string, string>,
  alias: string,
  targetPath: string,
): void {
  const normalized = normalizePathish(alias)
  if (!normalized || aliasMap.has(normalized)) {
    return
  }
  aliasMap.set(normalized, targetPath)
}

function collectModuleAliases(relativePath: string): string[] {
  const normalized = normalizePathish(relativePath)
  const stripped = stripModuleExtension(normalized)
  const aliases = new Set<string>([normalized, stripped])

  for (const extension of relatedImportExtensions(normalized)) {
    aliases.add(`${stripped}${extension}`)
  }

  if (stripped.endsWith('/index')) {
    const directoryAlias = stripped.slice(0, -'/index'.length)
    if (directoryAlias) {
      aliases.add(directoryAlias)
    }
  }

  return [...aliases]
}

function buildModuleAliasMap(modules: readonly ModuleIR[]): Map<string, string> {
  const aliasMap = new Map<string, string>()
  const sortedModules = collectCompleteModules(modules).sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )

  for (const module of sortedModules) {
    for (const alias of collectModuleAliases(module.relativePath)) {
      addModuleAlias(aliasMap, alias, module.relativePath)
    }
  }

  return aliasMap
}

function buildModulePathById(modules: readonly ModuleIR[]): Map<string, string> {
  const modulePathById = new Map<string, string>()
  for (const module of collectCompleteModules(modules)) {
    modulePathById.set(module.moduleId, module.relativePath)
  }
  return modulePathById
}

type SymbolPathIndex = {
  exact: Map<string, string>
  local: Map<string, string>
}

function localSymbolName(qualifiedName: string): string {
  const separatorIndex = qualifiedName.indexOf('::')
  return separatorIndex >= 0
    ? qualifiedName.slice(separatorIndex + 2)
    : qualifiedName
}

function addUniquePath(
  index: Map<string, string | null>,
  key: string,
  path: string,
): void {
  const current = index.get(key)
  if (current === undefined) {
    index.set(key, path)
    return
  }
  if (current !== path) {
    index.set(key, null)
  }
}

function buildSymbolPathIndex(modules: readonly ModuleIR[]): SymbolPathIndex {
  const exact = new Map<string, string>()
  const localCandidates = new Map<string, string | null>()

  for (const module of collectCompleteModules(modules)) {
    for (const cls of module.classes) {
      addUniquePath(exact, cls.qualifiedName, module.relativePath)
      addUniquePath(localCandidates, localSymbolName(cls.qualifiedName), module.relativePath)

      for (const method of cls.methods) {
        addUniquePath(exact, method.qualifiedName, module.relativePath)
        addUniquePath(
          localCandidates,
          localSymbolName(method.qualifiedName),
          module.relativePath,
        )
      }
    }

    for (const fn of module.functions) {
      addUniquePath(exact, fn.qualifiedName, module.relativePath)
      addUniquePath(localCandidates, localSymbolName(fn.qualifiedName), module.relativePath)
    }
  }

  const local = new Map<string, string>()
  for (const [name, path] of localCandidates.entries()) {
    if (typeof path === 'string') {
      local.set(name, path)
    }
  }

  return { exact, local }
}

function resolveRelativePathSpecifier(
  currentRelativePath: string,
  specifier: string,
): string | null {
  const currentDir = posix.dirname(currentRelativePath)
  const baseDir = currentDir === '.' ? '' : currentDir
  const resolved = posix.normalize(posix.join(baseDir, specifier))
  return normalizePathish(resolved)
}

function resolveRelativePythonSpecifier(
  currentRelativePath: string,
  specifier: string,
): string | null {
  if (specifier.includes('/')) {
    return null
  }

  const match = specifier.match(/^(\.+)(.*)$/)
  if (!match?.[1]) {
    return null
  }

  const currentDir = posix.dirname(currentRelativePath)
  const currentSegments =
    currentDir === '.' ? [] : currentDir.split('/').filter(Boolean)
  const parentSteps = Math.max(0, match[1].length - 1)
  if (parentSteps > currentSegments.length) {
    return null
  }

  const targetSegments = currentSegments.slice(
    0,
    currentSegments.length - parentSteps,
  )
  const remainder = match[2] ?? ''
  if (remainder) {
    targetSegments.push(...remainder.split('.').filter(Boolean))
  }

  return normalizePathish(targetSegments.join('/'))
}

function resolveImportToModulePath(args: {
  aliasMap: ReadonlyMap<string, string>
  importerPath: string
  specifier: string
}): string | null {
  const normalizedSpecifier = normalizePathish(args.specifier).replace(
    /^node:/,
    '',
  )
  if (!normalizedSpecifier) {
    return null
  }

  const candidates = new Set<string>()
  const addCandidate = (value: string | null) => {
    if (!value) {
      return
    }
    const normalized = normalizePathish(value)
    if (!normalized) {
      return
    }
    candidates.add(normalized)
    candidates.add(stripModuleExtension(normalized))
  }

  if (normalizedSpecifier.startsWith('.')) {
    addCandidate(
      resolveRelativePathSpecifier(args.importerPath, normalizedSpecifier),
    )
    addCandidate(
      resolveRelativePythonSpecifier(args.importerPath, normalizedSpecifier),
    )
  } else {
    addCandidate(normalizedSpecifier)
    if (!normalizedSpecifier.includes('/')) {
      addCandidate(normalizedSpecifier.replaceAll('.', '/'))
    }
  }

  for (const candidate of candidates) {
    const resolved = args.aliasMap.get(candidate)
    if (resolved) {
      return resolved
    }
  }

  return null
}

type FileDependencyEdge = {
  sourcePath: string
  targetPath: string
}

async function buildFileDependencyEdges(
  args: {
    modules: readonly ModuleIR[]
    signal?: AbortSignal
  },
): Promise<FileDependencyEdge[]> {
  const aliasMap = buildModuleAliasMap(args.modules)
  const seenEdges = new Set<string>()
  const edges: FileDependencyEdge[] = []
  const yieldState = createYieldState()

  for (const module of collectCompleteModules(args.modules)) {
    args.signal?.throwIfAborted?.()
    await maybeYieldToEventLoop(yieldState)
    for (const imported of module.imports) {
      args.signal?.throwIfAborted?.()
      const targetPath = resolveImportToModulePath({
        aliasMap,
        importerPath: module.relativePath,
        specifier: imported,
      })
      if (!targetPath || targetPath === module.relativePath) {
        continue
      }

      const edgeKey = `${module.relativePath}\n${targetPath}`
      if (seenEdges.has(edgeKey)) {
        continue
      }

      seenEdges.add(edgeKey)
      edges.push({
        sourcePath: module.relativePath,
        targetPath,
      })
    }
  }

  return edges.sort((left, right) => {
    const sourceCompare = left.sourcePath.localeCompare(right.sourcePath)
    if (sourceCompare !== 0) {
      return sourceCompare
    }
    return left.targetPath.localeCompare(right.targetPath)
  })
}

function resolveEdgeTargetFile(args: {
  aliasMap: ReadonlyMap<string, string>
  edge: EdgeIR
  symbolPathIndex: SymbolPathIndex
}): string | undefined {
  if (args.edge.targetFile) {
    return args.edge.targetFile
  }

  if (args.edge.kind === 'imports') {
    return resolveImportToModulePath({
      aliasMap: args.aliasMap,
      importerPath: args.edge.sourceFile,
      specifier: args.edge.target,
    }) ?? undefined
  }

  return (
    args.symbolPathIndex.exact.get(args.edge.target) ??
    args.symbolPathIndex.local.get(args.edge.target)
  )
}

function escapeDotLabel(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '')
}

async function renderArchitectureDot(args: {
  modules: readonly ModuleIR[]
  signal?: AbortSignal
}): Promise<string> {
  const edges = await buildFileDependencyEdges({
    modules: args.modules,
    signal: args.signal,
  })
  const nodePaths = [...new Set(edges.flatMap(edge => [edge.sourcePath, edge.targetPath]))]
    .sort((left, right) => left.localeCompare(right))

  const nodeIds = new Map<string, string>()
  const lines = ['digraph{']

  for (const [index, nodePath] of nodePaths.entries()) {
    args.signal?.throwIfAborted?.()
    const nodeId = `n${index.toString(36)}`
    nodeIds.set(nodePath, nodeId)
    lines.push(`${nodeId}[label="${escapeDotLabel(nodePath)}"]`)
  }

  for (const edge of edges) {
    args.signal?.throwIfAborted?.()
    const sourceId = nodeIds.get(edge.sourcePath)
    const targetId = nodeIds.get(edge.targetPath)
    if (!sourceId || !targetId) {
      continue
    }
    lines.push(`${sourceId}->${targetId}`)
  }

  lines.push('}')
  return lines.join('\n') + '\n'
}

export async function writeIndexFiles(args: {
  edges: readonly EdgeIR[]
  fileLimitReached: boolean
  maxFiles?: number
  modules: readonly ModuleIR[]
  outputDir: string
  rootDir: string
  signal?: AbortSignal
}): Promise<CodeIndexManifest> {
  const indexDir = join(args.outputDir, 'index')
  await mkdir(indexDir, { recursive: true })

  const modules = collectCompleteModules(args.modules)
  const manifest = buildManifest({ ...args, modules })
  args.signal?.throwIfAborted?.()
  await writeFile(
    join(indexDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  )

  const moduleLines = modules.map(module =>
      JSON.stringify({
        module_id: module.moduleId,
        path: module.relativePath,
        origin_path: module.originPath,
        origin_start_character: module.originStartCharacter,
        origin_start_line: module.originStartLine,
        lang: module.language,
        imports_count: module.imports.length,
        classes_count: module.classes.length,
      functions_count: module.functions.length,
      methods_count: module.classes.reduce(
        (count, cls) => count + cls.methods.length,
        0,
      ),
      parse_mode: module.parseMode,
      truncated: module.truncated,
      notes: module.notes,
      errors: module.errors,
    }),
  )
  args.signal?.throwIfAborted?.()
  await writeFile(join(indexDir, 'modules.jsonl'), moduleLines.join('\n') + '\n', 'utf8')

  const symbolLines: string[] = []
  const symbolPathIndex = buildSymbolPathIndex(modules)
  const aliasMap = buildModuleAliasMap(modules)
  const yieldState = createYieldState()
  for (const module of modules) {
    args.signal?.throwIfAborted?.()
    await maybeYieldToEventLoop(yieldState)
    for (const cls of module.classes) {
      symbolLines.push(
        JSON.stringify({
          symbol_id: `${module.moduleId}::class:${cls.name}`,
          module_id: module.moduleId,
          kind: 'class',
          qualified_name: cls.qualifiedName,
          signature: cls.bases.length > 0 ? `class ${cls.name}(${cls.bases.join(', ')})` : `class ${cls.name}`,
          source_lines: cls.sourceLines,
        }),
      )

      for (const method of cls.methods) {
        symbolLines.push(
          JSON.stringify({
            symbol_id: `${module.moduleId}::method:${cls.name}.${method.name}`,
            module_id: module.moduleId,
            kind: 'method',
            qualified_name: method.qualifiedName,
            signature: renderFunctionSignature(method),
            source_lines: method.sourceLines,
          }),
        )
      }
    }

    for (const fn of module.functions) {
      symbolLines.push(
        JSON.stringify({
          symbol_id: `${module.moduleId}::function:${fn.name}`,
          module_id: module.moduleId,
          kind: 'function',
          qualified_name: fn.qualifiedName,
          signature: renderFunctionSignature(fn),
          source_lines: fn.sourceLines,
        }),
      )
    }
  }
  args.signal?.throwIfAborted?.()
  await writeFile(join(indexDir, 'symbols.jsonl'), symbolLines.join('\n') + '\n', 'utf8')

  const edgeLines = args.edges.map(edge =>
    JSON.stringify({
      ...edge,
      targetFile: resolveEdgeTargetFile({
        aliasMap,
        edge,
        symbolPathIndex,
      }),
    }),
  )
  args.signal?.throwIfAborted?.()
  await writeFile(join(indexDir, 'edges.jsonl'), edgeLines.join('\n') + '\n', 'utf8')

  await writeFile(
    join(indexDir, 'summary.md'),
    renderSummary({
      edges: args.edges,
      manifest,
      modules,
      outputDir: args.outputDir,
    }),
    'utf8',
  )
  await writeFile(
    join(indexDir, 'architecture.dot'),
    await renderArchitectureDot({
      modules,
      signal: args.signal,
    }),
    'utf8',
  )

  args.signal?.throwIfAborted?.()
  await writePythonIndex(args)

  return manifest
}

// ── Python __index__.py generator ──────────────────────────────────────────

function toSkeletonRelativePath(relativePath: string): string {
  const parsed = parsePath(relativePath)
  return join(parsed.dir, `${parsed.name}.py`).replaceAll('\\', '/')
}

function escapePythonString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, ' ')
    .replace(/\r/g, '')
}

function isMinifiedSymbol(name: string): boolean {
  // Filter out minified/obfuscated names from bundled code
  if (/^[$_]\d+$/.test(name)) return true        // $25, _38, $_8
  if (/^[$_][a-zA-Z]\d*$/.test(name) && name.length <= 3) return true  // $e, _Y, $j
  if (/^_[a-zA-Z]\d+$/.test(name) && name.length <= 4) return true  // _e8, _j5
  if (/^\$_/.test(name)) return true              // $_8
  if (/^_temp\d*$/.test(name)) return true        // _temp, _temp0, _temp1
  if (/^[A-Za-z_]\d{1,2}$/.test(name)) return true  // A25, a36, ab6, A_5
  if (/^__\d+$/.test(name)) return true           // __5
  return false
}

function isBundledModule(module: ModuleIR): boolean {
  // Skip bundled/compiled output files
  return module.relativePath === 'cli.js' || module.relativePath === 'cli.ts'
}

function computeCallFrequency(
  edges: readonly EdgeIR[],
  modules: readonly ModuleIR[],
): Map<string, number> {
  const bundledFiles = new Set(
    modules.filter(isBundledModule).map(m => m.relativePath),
  )
  const freq = new Map<string, number>()
  for (const edge of edges) {
    if (edge.kind !== 'calls') continue
    if (bundledFiles.has(edge.sourceFile)) continue
    const count = freq.get(edge.target) ?? 0
    freq.set(edge.target, count + 1)
  }
  return freq
}

function detectEntryPoints(modules: readonly ModuleIR[]): Array<{
  name: string
  path: string
  description: string
}> {
  const entryPoints: Array<{ name: string; path: string; description: string }> = []
  const seen = new Set<string>()

  const entryPatterns = [
    { pattern: /^src\/main\.tsx?$/, name: 'CLI_MAIN', desc: 'Primary CLI entry point' },
    { pattern: /^src\/entrypoints\/cli\.tsx?$/, name: 'CLI_BOOTSTRAP', desc: 'CLI bootstrap wrapper' },
    { pattern: /^src\/entrypoints\/mcp\.tsx?$/, name: 'MCP_SERVER', desc: 'MCP server mode' },
    { pattern: /^src\/entrypoints\/init\.tsx?$/, name: 'CLI_INIT', desc: 'CLI initialization side-effects' },
    { pattern: /^src\/query\.tsx?$/, name: 'QUERY_ENGINE', desc: 'Core query execution engine' },
    { pattern: /^src\/QueryEngine\.tsx?$/, name: 'QUERY_ORCHESTRATOR', desc: 'Higher-level query orchestrator' },
    { pattern: /^src\/tools\.tsx?$/, name: 'TOOL_REGISTRY', desc: 'Tool definition registry' },
    { pattern: /^src\/commands\.tsx?$/, name: 'COMMAND_REGISTRY', desc: 'Slash command registry' },
    { pattern: /^src\/tasks\.tsx?$/, name: 'TASK_REGISTRY', desc: 'Task type registry' },
    { pattern: /^src\/Task\.tsx?$/, name: 'TASK_TYPES', desc: 'Core task type system' },
    { pattern: /^src\/Tool\.tsx?$/, name: 'TOOL_TYPES', desc: 'Tool type system and interfaces' },
    { pattern: /^src\/state\/AppStateStore\.tsx?$/, name: 'APP_STATE', desc: 'Canonical application state definition' },
    { pattern: /^src\/context\.tsx?$/, name: 'CONTEXT_BUILDERS', desc: 'System/user context builders' },
    { pattern: /^src\/cost-tracker\.tsx?$/, name: 'COST_TRACKER', desc: 'Cost/token tracking' },
    { pattern: /^src\/setup\.tsx?$/, name: 'SESSION_SETUP', desc: 'Session setup and worktree creation' },
  ]

  for (const module of modules) {
    for (const ep of entryPatterns) {
      if (ep.pattern.test(module.relativePath) && !seen.has(ep.name)) {
        seen.add(ep.name)
        entryPoints.push({
          name: ep.name,
          path: `skeleton/${toSkeletonRelativePath(module.relativePath)}`,
          description: ep.desc,
        })
      }
    }
  }

  return entryPoints
}

async function writePythonIndex(args: {
  edges: readonly EdgeIR[]
  modules: readonly ModuleIR[]
  outputDir: string
  rootDir: string
  signal?: AbortSignal
}): Promise<void> {
  const { modules, edges, outputDir } = args
  const callFreq = computeCallFrequency(edges, modules)
  const entryPoints = detectEntryPoints(modules)

  // Compute compact directory summary
  const dirCounts = new Map<string, number>()
  for (const module of modules) {
    args.signal?.throwIfAborted?.()
    const parsed = parsePath(module.relativePath)
    const dir = parsed.dir || '.'
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1)
  }

  // Top 30 directories by module count
  const topDirs = [...dirCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)

  // Top called symbols (project-specific, not language builtins)
  const BUILTIN_FILTER = new Set([
    'join', 'Error', 'map', 'filter', 'async', 'trim', 'test', 'String',
    'Date', 'Set', 'includes', 'parseInt', 'resolve', 'slice', 'replace',
    'split', 'concat', 'push', 'pop', 'shift', 'unshift', 'forEach',
    'reduce', 'find', 'some', 'every', 'indexOf', 'match', 'exec',
    'toString', 'valueOf', 'hasOwnProperty', 'constructor', 'prototype',
    'apply', 'call', 'bind',
  ])
  const topCalled = [...callFreq.entries()]
    .filter(([symbol]) => !isMinifiedSymbol(symbol))
    .filter(([symbol]) => !BUILTIN_FILTER.has(symbol))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)

  const lines: string[] = []

  // Header
  lines.push('# __index__.py  (auto-generated navigation bus)')
  lines.push('# ════════════════════════════════════════════════════════════════')
  lines.push('# PROJECT LOGIC INDEX — compact navigation layer')
  lines.push('#')
  lines.push('# For full data see:')
  lines.push('#   index/symbols.jsonl   — all symbols with signatures')
  lines.push('#   index/modules.jsonl   — module metadata & classes')
  lines.push('#   index/summary.md      — human-readable overview')
  lines.push('# ════════════════════════════════════════════════════════════════')
  lines.push('from __future__ import annotations')
  lines.push('from typing import Dict, List')
  lines.push('')

  // ── 1. ENTRY_POINTS ──
  lines.push('# ── 1. Entry Points ─────────────────────────────────────────────')
  lines.push('# Named entry points: CLI, MCP, query engine, tool/command registries.')
  lines.push('')

  lines.push('ENTRY_POINTS: Dict[str, str] = {')
  for (const ep of entryPoints) {
    args.signal?.throwIfAborted?.()
    const escapedPath = escapePythonString(ep.path)
    lines.push(`    '${ep.name}': '${escapedPath}',  # ${ep.description}`)
  }
  lines.push('}')
  lines.push('')

  // ── 2. TOP_DIRECTORIES ──
  lines.push('# ── 2. Top Directories (by module count) ─────────────────────────')
  lines.push('# Quick map of where the bulk of code lives.')
  lines.push('')

  lines.push('TOP_DIRECTORIES: Dict[str, int] = {')
  for (const [dir, count] of topDirs) {
    args.signal?.throwIfAborted?.()
    const escapedDir = escapePythonString(dir)
    lines.push(`    '${escapedDir}': ${count},`)
  }
  lines.push('}')
  lines.push('')

  // ── 3. HIGH_PRIORITY_SYMBOLS ──
  lines.push('# ── 3. High-Priority Symbols (by call frequency) ────────────────')
  lines.push('# Project-specific symbols called most frequently — core building blocks.')
  lines.push('')

  lines.push('HIGH_PRIORITY_SYMBOLS: Dict[str, int] = {')
  for (const [symbol, count] of topCalled) {
    args.signal?.throwIfAborted?.()
    const escaped = escapePythonString(symbol)
    lines.push(`    '${escaped}': ${count},`)
  }
  lines.push('}')
  lines.push('')

  // ── 4. Navigation helpers ──
  lines.push('# ── 4. Navigation Helpers ────────────────────────────────────────')
  lines.push('# Convenience functions for AI-assisted code navigation.')
  lines.push('# All read from local state; no filesystem access needed.')
  lines.push('')
  lines.push('_ENTRY: Dict[str, str] = ENTRY_POINTS')
  lines.push('_TOP_DIRS: Dict[str, int] = TOP_DIRECTORIES')
  lines.push('_HOT: Dict[str, int] = HIGH_PRIORITY_SYMBOLS')
  lines.push('')
  lines.push('')
  lines.push('def entry_point(name: str) -> str:')
  lines.push('    """Return the skeleton path for a named entry point."""')
  lines.push('    return _ENTRY.get(name, f"Unknown entry point: {name}")')
  lines.push('')
  lines.push('')
  lines.push('def hot_symbols(n: int = 10) -> List[str]:')
  lines.push('    """Return the top-N most-called project symbols."""')
  lines.push('    return list(_HOT)[:n]')
  lines.push('')
  lines.push('')
  lines.push('def module_count(dir_path: str) -> int:')
  lines.push('    """Return the number of modules in a source directory."""')
  lines.push('    return _TOP_DIRS.get(dir_path, 0)')
  lines.push('')
  lines.push('')
  lines.push('def directory_overview() -> Dict[str, int]:')
  lines.push('    """Return all top directories with their module counts."""')
  lines.push('    return dict(_TOP_DIRS)')
  lines.push('')

  // Write the file
  const content = lines.join('\n')
  await writeFile(join(outputDir, '__index__.py'), content, 'utf8')
}
