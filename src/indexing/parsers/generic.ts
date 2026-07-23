import type { ClassIR, FunctionIR, ModuleIR } from '../ir.js'
import {
  cleanTypeReference,
  computeBraceDepths,
  computeLineStarts,
  dedupeStrings,
  extractAwaitTargets,
  extractCallTargets,
  extractRaisedTargets,
  findMatchingChar,
  lineRangeFromOffsets,
  normalizeWhitespace,
  parseParametersFromSignature,
  relativePathToModuleId,
  sanitizeForStructure,
} from '../parserUtils.js'
import type { ParseContext } from './base.js'
import {
  detectLanguageFromContent,
  detectLanguageFromFile,
  processWithLanguagePack,
} from '../treeSitter.js'

type LanguagePackSpan = {
  endByte?: number
  endColumn?: number
  endLine?: number
  startByte?: number
  startColumn?: number
  startLine?: number
}

type LanguagePackStructureItem = {
  bodySpan?: LanguagePackSpan | null
  children?: LanguagePackStructureItem[] | null
  decorators?: string[] | null
  kind?: string | null
  name?: string | null
  span?: LanguagePackSpan | null
}

type LanguagePackImportInfo = {
  alias?: string | null
  items?: string[] | null
  isWildcard?: boolean | null
  source?: string | null
  span?: LanguagePackSpan | null
}

function extractImports(text: string): string[] {
  const imports: string[] = []

  for (const match of text.matchAll(
    /^\s*(?:import|use|require|include|#include|from)\s+([A-Za-z0-9_./:<>"'-]+)/gm,
  )) {
    if (match[1]) {
      imports.push(match[1].replaceAll(/[<>"']/g, ''))
    }
  }

  return dedupeStrings(imports)
}

function detectStructureLanguage(
  context: ParseContext,
): string | null {
  return (
    detectLanguageFromFile(context.file.relativePath) ??
    detectLanguageFromContent(context.source.text) ??
    null
  )
}

function spanText(
  text: string,
  span: LanguagePackSpan | null | undefined,
): string {
  if (!span) {
    return ''
  }
  const start = Math.max(0, span.startByte ?? 0)
  const end = Math.max(start, span.endByte ?? start)
  return text.slice(start, end)
}

function extractSignatureParameters(signatureText: string): string {
  const openIndex = signatureText.indexOf('(')
  if (openIndex < 0) {
    return ''
  }
  const closeIndex = findMatchingChar(signatureText, openIndex, '(', ')')
  if (closeIndex < 0 || closeIndex <= openIndex) {
    return ''
  }
  return signatureText.slice(openIndex + 1, closeIndex)
}

function extractSignatureReturnType(signatureText: string): string | undefined {
  const openIndex = signatureText.indexOf('(')
  if (openIndex < 0) {
    return undefined
  }
  const closeIndex = findMatchingChar(signatureText, openIndex, '(', ')')
  if (closeIndex < 0 || closeIndex <= openIndex) {
    return undefined
  }
  const trailing = normalizeWhitespace(signatureText.slice(closeIndex + 1))
  if (!trailing) {
    return undefined
  }
  const boundaryIndex = trailing.search(/[\{;=]/)
  const normalized = (
    boundaryIndex >= 0 ? trailing.slice(0, boundaryIndex) : trailing
  ).trim()
  const cleaned = normalized.replace(/^(?:->|:)\s*/, '').trim()
  return cleaned || undefined
}

function buildPackFunctionIR(args: {
  bodyText: string
  item: LanguagePackStructureItem
  lineStarts: number[]
  moduleId: string
  originPath: string
  ownerClassName?: string
  sourceText: string
}): FunctionIR | null {
  const name = args.item.name?.trim()
  const span = args.item.span
  if (!name || !span) {
    return null
  }

  const signatureStart = Math.max(0, span.startByte ?? 0)
  const signatureEnd = Math.max(
    signatureStart,
    args.item.bodySpan?.startByte ?? span.endByte ?? signatureStart,
  )
  const signatureText = args.sourceText.slice(signatureStart, signatureEnd)
  const params = parseParametersFromSignature(
    extractSignatureParameters(signatureText),
  )
  const returns = extractSignatureReturnType(signatureText)
  const bodySpan = args.item.bodySpan ?? span
  const bodyText = args.bodyText || spanText(args.sourceText, bodySpan)
  const ownerClassName =
    args.ownerClassName ?? undefined

  return {
    kind: ownerClassName ? 'method' : 'function',
    name,
    qualifiedName: ownerClassName
      ? `${args.moduleId}::${ownerClassName}.${name}`
      : `${args.moduleId}::${name}`,
    params,
    returns: returns ? cleanTypeReference(returns) : undefined,
    decorators: dedupeStrings(args.item.decorators ?? []),
    calls: extractCallTargets(bodyText),
    awaits: extractAwaitTargets(bodyText),
    raises: extractRaisedTargets(bodyText),
    isAsync: /\basync\b/.test(signatureText) || /\basync\b/.test(bodyText),
    isPublic: !name.startsWith('_'),
    exported: !name.startsWith('_'),
    sourceLines: lineRangeFromOffsets(
      args.lineStarts,
      signatureStart,
      Math.max(signatureStart, bodySpan.endByte ?? span.endByte ?? signatureEnd),
    ),
    originPath: args.originPath,
  }
}

function buildPackClassIR(args: {
  item: LanguagePackStructureItem
  lineStarts: number[]
  methods: FunctionIR[]
  moduleId: string
  originPath: string
  sourceText: string
}): ClassIR | null {
  const name = args.item.name?.trim()
  const span = args.item.span
  if (!name || !span) {
    return null
  }

  return {
    name,
    qualifiedName: `${args.moduleId}::${name}`,
    bases: [],
    dependsOn: [],
    methods: args.methods,
    exported: true,
    sourceLines: lineRangeFromOffsets(
      args.lineStarts,
      span.startByte ?? 0,
      span.endByte ?? span.startByte ?? 0,
    ),
    originPath: args.originPath,
  }
}

const languagePackClassKinds = new Set([
  'Class',
  'Struct',
  'Interface',
  'Enum',
  'Trait',
  'Impl',
])

const languagePackFunctionKinds = new Set(['Function', 'Method'])

function collectPackMethods(args: {
  item: LanguagePackStructureItem
  lineStarts: number[]
  moduleId: string
  originPath: string
  sourceText: string
}): FunctionIR[] {
  const methods: FunctionIR[] = []
  for (const child of args.item.children ?? []) {
    const childKind = child.kind ?? 'Other'
    if (!languagePackFunctionKinds.has(childKind)) {
      continue
    }
    const fn = buildPackFunctionIR({
      bodyText: spanText(args.sourceText, child.bodySpan ?? child.span),
      item: child,
      lineStarts: args.lineStarts,
      moduleId: args.moduleId,
      originPath: args.originPath,
      ownerClassName: args.item.name?.trim(),
      sourceText: args.sourceText,
    })
    if (fn) {
      methods.push(fn)
    }
  }
  return dedupeByQualifiedName(methods)
}

function walkLanguagePackStructure(args: {
  items: readonly LanguagePackStructureItem[]
  lineStarts: number[]
  moduleId: string
  originPath: string
  sourceText: string
  classMap: Map<string, ClassIR>
  functions: FunctionIR[]
  insideClass?: boolean
}): void {
  for (const item of args.items) {
    const kind = item.kind ?? 'Other'
    if (languagePackClassKinds.has(kind)) {
      const classIR = buildPackClassIR({
        item,
        lineStarts: args.lineStarts,
        methods: collectPackMethods({
          item,
          lineStarts: args.lineStarts,
          moduleId: args.moduleId,
          originPath: args.originPath,
          sourceText: args.sourceText,
        }),
        moduleId: args.moduleId,
        originPath: args.originPath,
        sourceText: args.sourceText,
      })
      if (classIR) {
        const existing = args.classMap.get(classIR.qualifiedName)
        if (existing) {
          existing.methods.push(...classIR.methods)
          existing.methods = dedupeByQualifiedName(existing.methods)
        } else {
          args.classMap.set(classIR.qualifiedName, classIR)
        }
      }
      const nestedItems = (item.children ?? []).filter(
        child => !languagePackFunctionKinds.has(child.kind ?? 'Other'),
      )
      if (nestedItems.length > 0) {
        walkLanguagePackStructure({
          items: nestedItems,
          lineStarts: args.lineStarts,
          moduleId: args.moduleId,
          originPath: args.originPath,
          sourceText: args.sourceText,
          classMap: args.classMap,
          functions: args.functions,
          insideClass: true,
        })
      }
      continue
    }

    if (languagePackFunctionKinds.has(kind)) {
      if (!args.insideClass) {
        const fn = buildPackFunctionIR({
          bodyText: spanText(args.sourceText, item.bodySpan ?? item.span),
          item,
          lineStarts: args.lineStarts,
          moduleId: args.moduleId,
          originPath: args.originPath,
          sourceText: args.sourceText,
        })
        if (fn) {
          args.functions.push(fn)
        }
      }
      continue
    }

    if ((item.children ?? []).length > 0) {
      walkLanguagePackStructure({
        items: item.children ?? [],
        lineStarts: args.lineStarts,
        moduleId: args.moduleId,
        originPath: args.originPath,
        sourceText: args.sourceText,
        classMap: args.classMap,
        functions: args.functions,
        insideClass: args.insideClass,
      })
    }
  }
}

function tryParseLanguagePackModule(context: ParseContext): ModuleIR | null {
  const language = detectStructureLanguage(context)
  if (!language || language === 'generic') {
    return null
  }

  try {
    const result = processWithLanguagePack(context.source.text, {
      language,
      structure: true,
      imports: true,
      exports: true,
      symbols: true,
      diagnostics: true,
    })

    const structure = result.structure ?? []
    if (
      structure.length === 0 &&
      (result.imports?.length ?? 0) === 0 &&
      (result.exports?.length ?? 0) === 0 &&
      (result.symbols?.length ?? 0) === 0
    ) {
      return null
    }

    const lineStarts = computeLineStarts(context.source.text)
    const classMap = new Map<string, ClassIR>()
    const functions: FunctionIR[] = []
    walkLanguagePackStructure({
      items: structure,
      lineStarts,
      moduleId: relativePathToModuleId(context.file.relativePath),
      originPath: context.file.relativePath,
      sourceText: context.source.text,
      classMap,
      functions,
    })

    const classes = dedupeByQualifiedName([...classMap.values()])
    const imports = dedupeStrings(
      (result.imports ?? [])
        .map(entry => normalizeWhitespace(entry?.source ?? ''))
        .filter(Boolean),
    )
    const exportNames = dedupeStrings([
      ...classes.map(cls => cls.name),
      ...functions.map(fn => fn.name),
    ])
    const moduleId = relativePathToModuleId(context.file.relativePath)

    return {
      moduleId,
      sourcePath: context.file.absolutePath,
      relativePath: context.file.relativePath,
      language: context.file.language,
      parseMode: context.source.truncated
        ? 'generic-language-pack-truncated'
        : 'generic-language-pack',
      classes,
      errors: dedupeStrings((result.diagnostics ?? []).map(diag =>
        normalizeWhitespace(
          (diag as { message?: string; kind?: string }).message ??
            (diag as { message?: string; kind?: string }).kind ??
            '',
        ),
      ).filter(Boolean)),
      exports: exportNames,
      importStubs: [],
      imports,
      functions: dedupeByQualifiedName(functions),
      notes: [
        `tree-sitter language pack recovered structure for ${language}`,
      ],
      sourceBytes: context.source.byteSize,
      lineCount: lineStarts.length,
      truncated: context.source.truncated,
    }
  } catch {
    return null
  }
}

function mergeGenericModuleResults(
  packResult: ModuleIR,
  heuristicResult: ModuleIR,
): ModuleIR {
  const classes = packResult.classes.map(cls => ({ ...cls }))
  const functions = packResult.functions.map(fn => ({ ...fn }))
  const classMap = new Map(classes.map(cls => [cls.qualifiedName, cls]))
  const functionMap = new Map(functions.map(fn => [fn.qualifiedName, fn]))

  for (const heuristicClass of heuristicResult.classes) {
    const target = classMap.get(heuristicClass.qualifiedName)
    if (!target) {
      classes.push(heuristicClass)
      classMap.set(heuristicClass.qualifiedName, heuristicClass)
      continue
    }
    target.bases = dedupeStrings([...target.bases, ...heuristicClass.bases])
    target.dependsOn = dedupeStrings([...target.dependsOn, ...heuristicClass.dependsOn])
    const fieldMap = new Map((target.fields ?? []).map(field => [field.name, field]))
    for (const heuristicField of heuristicClass.fields ?? []) {
      const field = fieldMap.get(heuristicField.name)
      if (!field) {
        target.fields = [...(target.fields ?? []), heuristicField]
        fieldMap.set(heuristicField.name, heuristicField)
        continue
      }
      field.annotation = field.annotation ?? heuristicField.annotation
      field.defaultValue = field.defaultValue ?? heuristicField.defaultValue
      field.isPublic = field.isPublic || heuristicField.isPublic
    }
    const methodMap = new Map(target.methods.map(method => [method.qualifiedName, method]))
    for (const heuristicMethod of heuristicClass.methods) {
      const method = methodMap.get(heuristicMethod.qualifiedName)
      if (!method) {
        target.methods.push(heuristicMethod)
        continue
      }
      method.params = method.params.length > 0 ? method.params : heuristicMethod.params
      method.returns = method.returns ?? heuristicMethod.returns
      method.calls = dedupeStrings([...method.calls, ...heuristicMethod.calls])
      method.awaits = dedupeStrings([...method.awaits, ...heuristicMethod.awaits])
      method.raises = dedupeStrings([...method.raises, ...heuristicMethod.raises])
      method.decorators = dedupeStrings([...method.decorators, ...heuristicMethod.decorators])
      method.isAsync = method.isAsync || heuristicMethod.isAsync
      method.exported = method.exported || heuristicMethod.exported
    }
  }

  for (const heuristicFunction of heuristicResult.functions) {
    const target = functionMap.get(heuristicFunction.qualifiedName)
    if (!target) {
      functions.push(heuristicFunction)
      functionMap.set(heuristicFunction.qualifiedName, heuristicFunction)
      continue
    }
    target.params = target.params.length > 0 ? target.params : heuristicFunction.params
    target.returns = target.returns ?? heuristicFunction.returns
    target.calls = dedupeStrings([...target.calls, ...heuristicFunction.calls])
    target.awaits = dedupeStrings([...target.awaits, ...heuristicFunction.awaits])
    target.raises = dedupeStrings([...target.raises, ...heuristicFunction.raises])
    target.decorators = dedupeStrings([...target.decorators, ...heuristicFunction.decorators])
    target.isAsync = target.isAsync || heuristicFunction.isAsync
    target.exported = target.exported || heuristicFunction.exported
  }

  return {
    moduleId: packResult.moduleId,
    sourcePath: packResult.sourcePath,
    relativePath: packResult.relativePath,
    originPath: packResult.originPath ?? heuristicResult.originPath,
    originStartLine:
      packResult.originStartLine ?? heuristicResult.originStartLine,
    originStartCharacter:
      packResult.originStartCharacter ?? heuristicResult.originStartCharacter,
    language: packResult.language,
    parseMode: 'generic-language-pack+pattern',
    imports: dedupeStrings([...packResult.imports, ...heuristicResult.imports]),
    importStubs: dedupeStrings([...packResult.importStubs, ...heuristicResult.importStubs]),
    exports: dedupeStrings([
      ...(packResult.exports ?? []),
      ...(heuristicResult.exports ?? []),
      ...classes.filter(cls => cls.exported).map(cls => cls.name),
      ...functions.filter(fn => fn.exported).map(fn => fn.name),
    ]),
    classes: dedupeByQualifiedName(classes),
    functions: dedupeByQualifiedName(functions),
    notes: dedupeStrings([...packResult.notes, ...heuristicResult.notes]),
    errors: dedupeStrings([...packResult.errors, ...heuristicResult.errors]),
    sourceBytes: packResult.sourceBytes,
    lineCount: packResult.lineCount,
    truncated: packResult.truncated,
  }
}

function buildGenericHeuristicModule(args: {
  context: ParseContext
  extraNotes: string[]
  extraErrors: string[]
  lineStarts: number[]
  sanitizedText: string
  text: string
}): ModuleIR {
  const moduleId = relativePathToModuleId(args.context.file.relativePath)
  return {
    moduleId,
    sourcePath: args.context.file.absolutePath,
    relativePath: args.context.file.relativePath,
    language: args.context.file.language,
    parseMode: args.context.source.truncated ? 'generic-truncated' : 'generic-pattern',
    imports: extractImports(args.text),
    importStubs: [],
    exports: [],
    classes: extractClasses({
      lineStarts: args.lineStarts,
      moduleId,
      sanitizedText: args.sanitizedText,
      text: args.text,
    }),
    functions: extractFunctions({
      lineStarts: args.lineStarts,
      moduleId,
      sanitizedText: args.sanitizedText,
      text: args.text,
    }),
    notes: dedupeStrings([
      ...args.extraNotes,
      ...(args.context.source.truncated
        ? [`source truncated to ${args.context.config.maxFileBytes} bytes before parsing`]
        : []),
    ]),
    errors: dedupeStrings(args.extraErrors),
    sourceBytes: args.context.source.byteSize,
    lineCount: args.lineStarts.length,
    truncated: args.context.source.truncated,
  }
}

function buildGenericFunctionIR(args: {
  lineStarts: number[]
  moduleId: string
  name: string
  paramsText: string
  returnType?: string
  sourceText: string
  startOffset: number
  endOffsetExclusive: number
}): FunctionIR {
  return {
    kind: 'function',
    name: args.name,
    qualifiedName: `${args.moduleId}::${args.name}`,
    params: parseParametersFromSignature(args.paramsText),
    returns: args.returnType,
    decorators: [],
    calls: extractCallTargets(args.sourceText),
    awaits: extractAwaitTargets(args.sourceText),
    raises: extractRaisedTargets(args.sourceText),
    isAsync: /\basync\b/.test(args.sourceText),
    isPublic: !args.name.startsWith('_'),
    exported: !args.name.startsWith('_'),
    sourceLines: lineRangeFromOffsets(
      args.lineStarts,
      args.startOffset,
      args.endOffsetExclusive,
    ),
  }
}

function extractClasses(args: {
  lineStarts: number[]
  moduleId: string
  sanitizedText: string
  text: string
}): ClassIR[] {
  const classes: ClassIR[] = []
  const braceDepths = computeBraceDepths(args.sanitizedText)
  const classRegex =
    /(?:^|[\n;])\s*(?:pub\s+)?(?:abstract\s+)?(?:class|struct|trait|interface|enum|impl)\s+([A-Za-z_][A-Za-z0-9_:]*)/gm

  for (const match of args.sanitizedText.matchAll(classRegex)) {
    const name = match[1]
    if (!name) {
      continue
    }

    const nameIndex = (match.index ?? 0) + match[0].lastIndexOf(name)
    if ((braceDepths[nameIndex] ?? 0) !== 0) {
      continue
    }

    const bodyStartIndex = args.sanitizedText.indexOf('{', nameIndex)
    const bodyEndIndex =
      bodyStartIndex >= 0
        ? args.sanitizedText.indexOf('}', bodyStartIndex)
        : args.sanitizedText.indexOf('\n', nameIndex)

    classes.push({
      name,
      qualifiedName: `${args.moduleId}::${name}`,
      bases: [],
      dependsOn: [],
      methods: [],
      exported: true,
      sourceLines: lineRangeFromOffsets(
        args.lineStarts,
        nameIndex,
        bodyEndIndex >= 0 ? bodyEndIndex + 1 : nameIndex + name.length,
      ),
    })
  }

  return classes
}

function extractFunctions(args: {
  lineStarts: number[]
  moduleId: string
  sanitizedText: string
  text: string
}): FunctionIR[] {
  const functions: FunctionIR[] = []
  const braceDepths = computeBraceDepths(args.sanitizedText)
  const regexes = [
    /(?:^|[\n;])\s*(?:pub\s+)?(?:async\s+)?(?:fn|func|function|def)\s+([A-Za-z_][A-Za-z0-9_:]*)\s*\(([^)]*)\)/gm,
    /(?:^|[\n;])\s*[A-Za-z_][A-Za-z0-9_<>\s:*&]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/gm,
  ]

  for (const regex of regexes) {
    for (const match of args.sanitizedText.matchAll(regex)) {
      const name = match[1]
      if (!name) {
        continue
      }

      const nameIndex = (match.index ?? 0) + match[0].lastIndexOf(name)
      if ((braceDepths[nameIndex] ?? 0) !== 0) {
        continue
      }

      const bodyEnd = args.sanitizedText.indexOf('\n', nameIndex)
      functions.push(
        buildGenericFunctionIR({
          lineStarts: args.lineStarts,
          moduleId: args.moduleId,
          name,
          paramsText: normalizeWhitespace(match[2] ?? ''),
          sourceText: args.text.slice(match.index ?? 0, bodyEnd >= 0 ? bodyEnd : undefined),
          startOffset: nameIndex,
          endOffsetExclusive:
            bodyEnd >= 0 ? bodyEnd : nameIndex + name.length,
        }),
      )
    }
  }

  return dedupeStrings(functions.map(fn => fn.qualifiedName))
    .map(name => functions.find(fn => fn.qualifiedName === name))
    .filter((fn): fn is FunctionIR => Boolean(fn))
}

function dedupeByQualifiedName<T extends { qualifiedName: string }>(
  items: readonly T[],
): T[] {
  const seen = new Set<string>()
  const result: T[] = []

  for (const item of items) {
    if (seen.has(item.qualifiedName)) {
      continue
    }
    seen.add(item.qualifiedName)
    result.push(item)
  }

  return result
}

export function parseGenericModule(
  context: ParseContext,
  extraNotes: string[] = [],
  extraErrors: string[] = [],
): ModuleIR {
  const text = context.source.text
  const sanitizedText = sanitizeForStructure(text)
  const lineStarts = computeLineStarts(text)

  const languagePackResult = tryParseLanguagePackModule(context)
  const heuristicResult = buildGenericHeuristicModule({
    context,
    extraNotes,
    extraErrors,
    lineStarts,
    sanitizedText,
    text,
  })

  if (languagePackResult) {
    return mergeGenericModuleResults(languagePackResult, heuristicResult)
  }

  return heuristicResult
}
