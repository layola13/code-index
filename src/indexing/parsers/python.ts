import type { ClassIR, FunctionIR, ModuleIR } from '../ir.js'
import {
  cleanTypeReference,
  computeLineStarts,
  dedupeStrings,
  dependencyLabelForParam,
  extractAwaitTargets,
  extractCallTargets,
  extractRaisedTargets,
  lineRangeFromOffsets,
  normalizeWhitespace,
  parseParametersFromSignature,
  relativePathToModuleId,
  splitTopLevel,
} from '../parserUtils.js'
import type { ParseContext } from './base.js'

type DecoratorBlock = {
  decorators: string[]
  nextIndex: number
}

type HeaderBlock = {
  endIndex: number
  text: string
}

function indentationWidth(line: string): number {
  let width = 0
  for (const char of line) {
    if (char === ' ') {
      width++
      continue
    }
    if (char === '\t') {
      width += 4
      continue
    }
    break
  }
  return width
}

function collectDecorators(
  lines: readonly string[],
  startIndex: number,
  requiredIndent: number,
): DecoratorBlock {
  const decorators: string[] = []
  let index = startIndex

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      index++
      continue
    }
    if (
      indentationWidth(line) === requiredIndent &&
      line.trimStart().startsWith('@')
    ) {
      decorators.push(line.trim().slice(1))
      index++
      continue
    }
    break
  }

  return { decorators, nextIndex: index }
}

function collectHeader(lines: readonly string[], startIndex: number): HeaderBlock {
  const parts: string[] = []
  let index = startIndex
  let balance = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    parts.push(trimmed)

    for (const char of trimmed) {
      if ('([{'.includes(char)) {
        balance++
      } else if (')]}'.includes(char)) {
        balance = Math.max(0, balance - 1)
      }
    }

    if (balance === 0 && trimmed.endsWith(':')) {
      break
    }

    index++
  }

  return {
    endIndex: index,
    text: parts.join(' '),
  }
}

function findBlockEnd(
  lines: readonly string[],
  headerEndIndex: number,
  headerIndent: number,
): number {
  let lastIndex = headerEndIndex

  for (let index = headerEndIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    if (trimmed.startsWith('#')) {
      continue
    }

    const indent = indentationWidth(line)
    if (indent <= headerIndent) {
      return lastIndex
    }
    lastIndex = index
  }

  return lines.length - 1
}

function extractImports(text: string): string[] {
  const imports: string[] = []

  for (const match of text.matchAll(
    /^\s*import\s+([A-Za-z0-9_.,\s]+)(?:\s+as\s+[A-Za-z0-9_]+)?\s*$/gm,
  )) {
    if (match[1]) {
      for (const part of match[1].split(',')) {
        const token = part.trim().split(/\s+as\s+/)[0]
        if (token) {
          imports.push(token)
        }
      }
    }
  }

  for (const match of text.matchAll(
    /^\s*from\s+([A-Za-z0-9_./]+)\s+import\s+([A-Za-z0-9_.*,\s]+)\s*$/gm,
  )) {
    if (match[1]) {
      imports.push(match[1])
    }
  }

  return dedupeStrings(imports)
}

function extractImportStubs(text: string): string[] {
  const stubs: string[] = []

  for (const match of text.matchAll(
    /^\s*import\s+([A-Za-z0-9_.,\s]+(?:\s+as\s+[A-Za-z0-9_]+)?)\s*$/gm,
  )) {
    const clause = match[1] ?? ''
    for (const part of clause.split(',')) {
      const normalized = normalizeWhitespace(part)
      if (!normalized) {
        continue
      }
      stubs.push(`import ${normalized}`)
    }
  }

  for (const match of text.matchAll(
    /^\s*from\s+([A-Za-z0-9_./]+)\s+import\s+([A-Za-z0-9_.*,\s]+)\s*$/gm,
  )) {
    const fromModule = normalizeWhitespace(match[1] ?? '')
    const imported = normalizeWhitespace(match[2] ?? '')
    if (!fromModule || !imported) {
      continue
    }
    stubs.push(`from ${fromModule} import ${imported}`)
  }

  return dedupeStrings(stubs)
}

function extractExports(
  text: string,
  classes: readonly ClassIR[],
  functions: readonly FunctionIR[],
): string[] {
  const explicitExports: string[] = []
  const allMatch = text.match(/__all__\s*=\s*[\[(]([\s\S]*?)[\])]/m)
  if (allMatch?.[1]) {
    for (const item of allMatch[1].matchAll(/['"]([^'"]+)['"]/g)) {
      if (item[1]) {
        explicitExports.push(item[1])
      }
    }
  }

  if (explicitExports.length > 0) {
    return dedupeStrings(explicitExports)
  }

  return dedupeStrings([
    ...classes.map(cls => cls.name).filter(name => !name.startsWith('_')),
    ...functions.map(fn => fn.name).filter(name => !name.startsWith('_')),
  ])
}

function buildPythonFunctionIR(args: {
  bodyText: string
  decorators: string[]
  endLineIndex: number
  headerText: string
  isMethod: boolean
  lineStarts: number[]
  moduleId: string
  name: string
  ownerClassName?: string
  startLineIndex: number
}): FunctionIR {
  const parsed = args.headerText.match(
    /^(async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*(?:->\s*([^:]+))?:$/,
  )

  const paramsText = parsed?.[3] ?? ''
  const returns = cleanTypeReference(parsed?.[4] ?? '')
  const qualifiedName = args.ownerClassName
    ? `${args.moduleId}::${args.ownerClassName}.${args.name}`
    : `${args.moduleId}::${args.name}`

  return {
    kind: args.isMethod ? 'method' : 'function',
    name: args.name,
    qualifiedName,
    params: parseParametersFromSignature(paramsText),
    returns: returns || undefined,
    decorators: args.decorators,
    calls: extractCallTargets(args.bodyText),
    awaits: extractAwaitTargets(args.bodyText),
    raises: extractRaisedTargets(args.bodyText),
    isAsync: Boolean(parsed?.[1]),
    isPublic: !args.name.startsWith('_'),
    exported: !args.name.startsWith('_'),
    sourceLines: lineRangeFromOffsets(
      args.lineStarts,
      args.lineStarts[args.startLineIndex] ?? 0,
      (args.lineStarts[args.endLineIndex + 1] ?? Number.MAX_SAFE_INTEGER) - 1,
    ),
  }
}

function extractPythonMethods(args: {
  classBodyStartIndex: number
  classEndIndex: number
  classIndent: number
  className: string
  lines: readonly string[]
  lineStarts: number[]
  moduleId: string
}): FunctionIR[] {
  const methods: FunctionIR[] = []

  for (let index = args.classBodyStartIndex; index <= args.classEndIndex; ) {
    const line = args.lines[index] ?? ''
    const trimmed = line.trim()

    if (!trimmed) {
      index++
      continue
    }

    const indent = indentationWidth(line)
    if (indent <= args.classIndent) {
      index++
      continue
    }

    const decoratorBlock = collectDecorators(args.lines, index, indent)
    const definitionIndex = decoratorBlock.nextIndex
    const definitionLine = args.lines[definitionIndex] ?? ''
    const definitionTrimmed = definitionLine.trim()

    if (!/^(async\s+def|def)\s+/.test(definitionTrimmed)) {
      index = definitionIndex + 1
      continue
    }

    const header = collectHeader(args.lines, definitionIndex)
    const endIndex = findBlockEnd(args.lines, header.endIndex, indent)
    const nameMatch = header.text.match(
      /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    )
    if (!nameMatch?.[1]) {
      index = endIndex + 1
      continue
    }

    methods.push(
      buildPythonFunctionIR({
        bodyText: args.lines.slice(header.endIndex + 1, endIndex + 1).join('\n'),
        decorators: decoratorBlock.decorators,
        endLineIndex: endIndex,
        headerText: header.text,
        isMethod: true,
        lineStarts: args.lineStarts,
        moduleId: args.moduleId,
        name: nameMatch[1],
        ownerClassName: args.className,
        startLineIndex:
          decoratorBlock.decorators.length > 0 ? index : definitionIndex,
      }),
    )

    index = endIndex + 1
  }

  return methods
}

export function parsePythonModule(context: ParseContext): ModuleIR {
  const moduleId = relativePathToModuleId(context.file.relativePath)
  const text = context.source.text
  const lines = text.split('\n')
  const lineStarts = computeLineStarts(text)
  const classes: ClassIR[] = []
  const functions: FunctionIR[] = []

  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()

    if (!trimmed) {
      index++
      continue
    }

    if (indentationWidth(line) !== 0) {
      index++
      continue
    }

    const decoratorBlock = collectDecorators(lines, index, 0)
    const definitionIndex = decoratorBlock.nextIndex
    const definitionLine = lines[definitionIndex] ?? ''
    const definitionTrimmed = definitionLine.trim()

    if (/^class\s+/.test(definitionTrimmed)) {
      const header = collectHeader(lines, definitionIndex)
      const endIndex = findBlockEnd(lines, header.endIndex, 0)
      const classMatch = header.text.match(
        /^class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?:$/,
      )
      if (classMatch?.[1]) {
        const methods = extractPythonMethods({
          classBodyStartIndex: header.endIndex + 1,
          classEndIndex: endIndex,
          classIndent: 0,
          className: classMatch[1],
          lines,
          lineStarts,
          moduleId,
        })
        const constructor = methods.find(method => method.name === '__init__')
        classes.push({
          name: classMatch[1],
          qualifiedName: `${moduleId}::${classMatch[1]}`,
          bases: classMatch[2]
            ? dedupeStrings(splitTopLevel(classMatch[2], ','))
            : [],
          dependsOn: dedupeStrings(
            (constructor?.params ?? []).map(dependencyLabelForParam),
          ),
          methods,
          exported: !classMatch[1].startsWith('_'),
          sourceLines: lineRangeFromOffsets(
            lineStarts,
            lineStarts[
              decoratorBlock.decorators.length > 0 ? index : definitionIndex
            ] ?? 0,
            (lineStarts[endIndex + 1] ?? Number.MAX_SAFE_INTEGER) - 1,
          ),
        })
      }
      index = endIndex + 1
      continue
    }

    if (/^(async\s+def|def)\s+/.test(definitionTrimmed)) {
      const header = collectHeader(lines, definitionIndex)
      const endIndex = findBlockEnd(lines, header.endIndex, 0)
      const functionMatch = header.text.match(
        /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
      )
      if (functionMatch?.[1]) {
        functions.push(
          buildPythonFunctionIR({
            bodyText: lines.slice(header.endIndex + 1, endIndex + 1).join('\n'),
            decorators: decoratorBlock.decorators,
            endLineIndex: endIndex,
            headerText: header.text,
            isMethod: false,
            lineStarts,
            moduleId,
            name: functionMatch[1],
            startLineIndex:
              decoratorBlock.decorators.length > 0 ? index : definitionIndex,
          }),
        )
      }
      index = endIndex + 1
      continue
    }

    index = definitionIndex + 1
  }

  return {
    moduleId,
    sourcePath: context.file.absolutePath,
    relativePath: context.file.relativePath,
    language: context.file.language,
    parseMode: context.source.truncated
      ? 'python-heuristic-truncated'
      : 'python-heuristic',
    imports: extractImports(text),
    importStubs: extractImportStubs(text),
    exports: extractExports(text, classes, functions),
    classes,
    functions,
    notes: context.source.truncated
      ? [`source truncated to ${context.config.maxFileBytes} bytes before parsing`]
      : [],
    errors: [],
    sourceBytes: context.source.byteSize,
    lineCount: lineStarts.length,
    truncated: context.source.truncated,
  }
}
