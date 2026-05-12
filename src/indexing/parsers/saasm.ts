import type { FunctionIR, ModuleIR, ParamIR } from '../ir.js'
import {
  cleanTypeReference,
  dedupeStrings,
  normalizeWhitespace,
  relativePathToModuleId,
  safePythonIdentifier,
  splitTopLevel,
} from '../parserUtils.js'
import type { ParseContext } from './base.js'

type SaasmDeclarationKind = 'function' | 'extern' | 'export' | 'ffi_wrapper'

type SaasmDeclaration = {
  hasBody: boolean
  kind: SaasmDeclarationKind
  lineEnd: number
  lineStart: number
  name: string
  params: ParamIR[]
  returns?: string
}

type ParsedLine =
  | { kind: 'blank' | 'comment' | 'unknown'; text: string }
  | { kind: 'import'; specifier: string; text: string }
  | { kind: 'const'; name: string; text: string }
  | { kind: 'label'; name: string; text: string }
  | { kind: 'declaration'; declaration: SaasmDeclaration; text: string }

type CurrentFunction = {
  declaration: SaasmDeclaration
  bodyLines: string[]
}

function normalizeSaasmText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function splitLines(text: string): string[] {
  return normalizeSaasmText(text).split('\n')
}

function stripInlineComment(text: string): string {
  const index = text.indexOf('//')
  if (index < 0) {
    return text.trim()
  }
  return text.slice(0, index).trim()
}

function parseDirectivePrefix(line: string): {
  kind?: SaasmDeclarationKind
  remainder: string
} {
  const trimmed = line.trim()
  if (!trimmed.startsWith('@')) {
    return { remainder: trimmed }
  }

  const keywordMatch = trimmed.match(/^@(extern|export|ffi_wrapper)\b\s*(.*)$/)
  if (keywordMatch) {
    return {
      kind: keywordMatch[1] as SaasmDeclarationKind,
      remainder: keywordMatch[2] ?? '',
    }
  }

  return {
    remainder: trimmed.slice(1),
  }
}

function parseSaasmParams(paramsText: string): ParamIR[] {
  const params: Array<ParamIR | null> = splitTopLevel(paramsText, ',').map((rawParam, index) => {
    let value = normalizeWhitespace(rawParam)
    if (!value) {
      return null
    }

    value = value.replace(/^(?:\^|&|\*)\s*/, '')
    value = value.replace(/^(?:mut|ref|const)\s+/g, '')

    const colonIndex = value.indexOf(':')
    let namePart = colonIndex >= 0 ? value.slice(0, colonIndex).trim() : value
    let annotation = colonIndex >= 0 ? cleanTypeReference(value.slice(colonIndex + 1)) : undefined

    if (!namePart) {
      return null
    }

    const parts = namePart.split(/\s+/).filter(Boolean)
    if (parts.length > 1 && !annotation) {
      namePart = parts[0] ?? namePart
      annotation = cleanTypeReference(parts.slice(1).join(' '))
    }

    const normalizedName = namePart
      .replace(/^[@#]+/, '')
      .replace(/^[^A-Za-z_]+/, '')
      .trim()

    const name =
      normalizedName && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalizedName)
        ? normalizedName
        : `arg${index + 1}`

    return {
      name,
      annotation,
    }
  })

  return params.filter((param): param is ParamIR => param !== null)
}

function parseSaasmDeclarationLine(line: string): SaasmDeclaration | null {
  const trimmed = stripInlineComment(line)
  if (!trimmed || !trimmed.startsWith('@')) {
    return null
  }

  const prefixInfo = parseDirectivePrefix(trimmed)
  const remainder = prefixInfo.remainder.trim()

  if (!remainder) {
    return null
  }

  const match = remainder.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([\s\S]*)\))?\s*(?:->\s*([^\s:]+(?:\s+[^\s:]+)*))?\s*(:?)\s*$/,
  )

  if (!match?.[1]) {
    return null
  }

  const name = match[1]
  const paramsText = match[2] ?? ''
  const returnsText = match[3]?.trim()
  const hasColon = Boolean(match[4])
  const kind = prefixInfo.kind ?? 'function'

  return {
    hasBody: hasColon && kind !== 'extern',
    kind,
    lineStart: 0,
    lineEnd: 0,
    name,
    params: parseSaasmParams(paramsText),
    returns: returnsText ? cleanTypeReference(returnsText) : undefined,
  }
}

function parseSaasmLine(line: string): ParsedLine {
  const trimmed = line.trim()
  if (!trimmed) {
    return { kind: 'blank', text: line }
  }
  if (trimmed.startsWith('//')) {
    return { kind: 'comment', text: line }
  }
  if (trimmed.startsWith('@import ')) {
    return {
      kind: 'import',
      specifier: trimmed.slice('@import '.length).trim().replace(/^["']|["']$/g, ''),
      text: line,
    }
  }
  if (trimmed.startsWith('#def ')) {
    return {
      kind: 'const',
      name: trimmed.slice('#def '.length).trim().split(/\s|=/, 1)[0] ?? '',
      text: line,
    }
  }
  if (trimmed.startsWith('@const ')) {
    return {
      kind: 'const',
      name: trimmed.slice('@const '.length).trim().split(/\s|=/, 1)[0] ?? '',
      text: line,
    }
  }
  if (/^L_[A-Za-z0-9_]+:\s*$/.test(trimmed)) {
    return {
      kind: 'label',
      name: trimmed.slice(0, -1),
      text: line,
    }
  }

  const declaration = parseSaasmDeclarationLine(trimmed)
  if (declaration) {
    return { kind: 'declaration', declaration, text: line }
  }

  return { kind: 'unknown', text: line }
}

function safeSaasmSymbolName(value: string): string {
  return safePythonIdentifier(value.replace(/^@+/, ''), 'saasm_symbol')
}

function extractSaasmCallTargets(bodyText: string): string[] {
  const targets = new Set<string>()
  const normalized = normalizeSaasmText(bodyText)
  const callRegex =
    /\bcall(?:_indirect)?\s+@?([A-Za-z_][A-Za-z0-9_.$]*)\s*\(/g

  for (const match of normalized.matchAll(callRegex)) {
    const target = match[1]?.trim()
    if (target) {
      targets.add(target)
    }
  }

  return [...targets]
}

function buildFunctionIR(args: {
  bodyText: string
  declaration: SaasmDeclaration
  moduleId: string
  originPath: string
}): FunctionIR {
  const functionName = safeSaasmSymbolName(args.declaration.name)
  const params = args.declaration.params.map(param => ({
    ...param,
    name: safePythonIdentifier(param.name, 'arg'),
  }))
  const calls = extractSaasmCallTargets(args.bodyText)

  return {
    kind: 'function',
    name: functionName,
    qualifiedName: `${args.moduleId}::${functionName}`,
    params,
    returns: args.declaration.returns,
    decorators:
      args.declaration.kind === 'extern'
        ? ['extern']
        : args.declaration.kind === 'export'
          ? ['export']
          : args.declaration.kind === 'ffi_wrapper'
            ? ['ffi_wrapper']
            : [],
    calls,
    awaits: [],
    raises: [],
    isAsync: false,
    isPublic: true,
    exported: args.declaration.kind === 'export',
    sourceLines: {
      start: args.declaration.lineStart,
      end: args.declaration.lineEnd,
    },
    originPath: args.originPath,
  }
}

function finalizeCurrentFunction(
  current: CurrentFunction | null,
  moduleId: string,
  originPath: string,
): FunctionIR | null {
  if (!current) {
    return null
  }

  const bodyText = current.bodyLines.join('\n')
  return buildFunctionIR({
    bodyText,
    declaration: current.declaration,
    moduleId,
    originPath,
  })
}

export function parseSaasmModule(context: ParseContext): ModuleIR {
  const text = normalizeSaasmText(context.source.text)
  const lines = splitLines(text)
  const moduleId = relativePathToModuleId(context.file.relativePath)

  const imports = new Set<string>()
  const notes = new Set<string>()
  const errors = new Set<string>()
  const exports = new Set<string>()
  const functions: FunctionIR[] = []

  let current: CurrentFunction | null = null

  const pushCurrent = (): void => {
    if (!current) {
      return
    }
    const fn = finalizeCurrentFunction(
      current,
      moduleId,
      context.source.originPath ?? context.file.originPath ?? context.file.relativePath,
    )
    if (fn) {
      functions.push(fn)
      if (fn.exported) {
        exports.add(fn.name)
      }
    }
    current = null
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const parsed = parseSaasmLine(line)

    if (parsed.kind === 'declaration') {
      pushCurrent()
      const declaration = {
        ...parsed.declaration,
        lineStart: index + 1,
        lineEnd: index + 1,
      }
      if (!declaration.hasBody) {
        const fn = buildFunctionIR({
          bodyText: '',
          declaration,
          moduleId,
          originPath:
            context.source.originPath ?? context.file.originPath ?? context.file.relativePath,
        })
        functions.push(fn)
        if (fn.exported) {
          exports.add(fn.name)
        }
        continue
      }
      current = {
        declaration,
        bodyLines: [],
      }
      continue
    }

    if (current) {
      current.declaration.lineEnd = index + 1
      current.bodyLines.push(line)
    }

    if (parsed.kind === 'import') {
      if (parsed.specifier) {
        imports.add(parsed.specifier)
      }
      continue
    }

    if (parsed.kind === 'const') {
      if (parsed.name) {
        notes.add(parsed.name)
      }
      continue
    }

    if (parsed.kind === 'label') {
      notes.add(parsed.name)
      continue
    }

    if (parsed.kind === 'unknown' && line.trim().startsWith('@')) {
      errors.add(`unrecognized SA directive: ${normalizeWhitespace(line)}`)
    }
  }

  pushCurrent()

  const functionNames = functions.map(fn => fn.name)
  const importStubs = [...imports].map(specifier => `# import ${specifier}`)

  return {
    moduleId,
    sourcePath: context.file.absolutePath,
    relativePath: context.file.relativePath,
    originPath: context.source.originPath ?? context.file.originPath,
    originStartLine:
      context.source.originStartLine ?? context.file.originStartLine,
    originStartCharacter:
      context.source.originStartCharacter ?? context.file.originStartCharacter,
    language: 'saasm',
    parseMode: context.source.truncated ? 'saasm-truncated' : 'saasm-line',
    imports: dedupeStrings([...imports]),
    importStubs: dedupeStrings(importStubs),
    exports: dedupeStrings([...exports, ...functionNames.filter(name => name && !name.startsWith('_'))]),
    classes: [],
    functions,
    notes: dedupeStrings([
      ...notes,
      ...(context.source.truncated
        ? [`source truncated to ${context.config.maxFileBytes} bytes before parsing`]
        : []),
    ]),
    errors: dedupeStrings([...errors]),
    sourceBytes: context.source.byteSize,
    lineCount: lines.length,
    truncated: context.source.truncated,
  }
}
