import { posix } from 'path'
import type { ClassIR, FunctionIR, ModuleIR } from '../ir.js'
import {
  cleanTypeReference,
  computeBraceDepths,
  computeLineStarts,
  dedupeStrings,
  dependencyLabelForParam,
  extractAwaitTargets,
  extractCallTargets,
  extractRaisedTargets,
  findMatchingChar,
  lineRangeFromOffsets,
  normalizeWhitespace,
  parseParametersFromSignature,
  relativePathToModuleId,
  safePythonIdentifier,
  sanitizeForStructure,
  skipWhitespace,
  splitTopLevel,
} from '../parserUtils.js'
import type { ParseContext } from './base.js'

function extractImports(text: string): string[] {
  const imports: string[] = []

  for (const match of text.matchAll(/^\s*import[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gm)) {
    if (match[1]) {
      imports.push(match[1])
    }
  }

  for (const match of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    if (match[1]) {
      imports.push(match[1])
    }
  }

  for (const match of text.matchAll(/^\s*export[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gm)) {
    if (match[1]) {
      imports.push(match[1])
    }
  }

  for (const match of text.matchAll(
    /^\s*(?:const|let|var)\s+[^=\n]+\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/gm,
  )) {
    if (match[1]) {
      imports.push(match[1])
    }
  }

  return dedupeStrings(imports)
}

function stripModuleExtension(value: string): string {
  let normalized = value.trim()
  normalized = normalized.replace(/\.(?:[cm]?[jt]sx?|py)$/i, '')
  normalized = normalized.replace(/\/index$/i, '')
  return normalized
}

function normalizeModuleSegment(value: string): string {
  return safePythonIdentifier(value.replace(/^@/, '').replace(/-/g, '_'), 'mod')
}

function toPythonModuleSpecifier(
  currentRelativePath: string,
  rawSpecifier: string,
): string | null {
  const specifier = stripModuleExtension(rawSpecifier)
  if (!specifier) {
    return null
  }

  if (specifier.startsWith('.')) {
    const currentDir = posix.dirname(currentRelativePath.replaceAll('\\', '/'))
    const currentSegments =
      currentDir === '.' ? [] : currentDir.split('/').filter(Boolean)
    const targetPath = posix.normalize(
      posix.join(currentDir === '.' ? '' : currentDir, specifier),
    )
    const targetSegments = targetPath.split('/').filter(Boolean)

    let common = 0
    while (
      common < currentSegments.length &&
      common < targetSegments.length &&
      currentSegments[common] === targetSegments[common]
    ) {
      common++
    }

    const relativeDots = '.'.repeat(currentSegments.length - common + 1)
    const remainder = targetSegments
      .slice(common)
      .map(normalizeModuleSegment)
      .join('.')
    return remainder ? `${relativeDots}${remainder}` : relativeDots
  }

  return specifier
    .split('/')
    .filter(Boolean)
    .map(normalizeModuleSegment)
    .join('.')
}

function parseNamedImportList(clause: string): string[] {
  const inner = clause.trim().replace(/^\{/, '').replace(/\}$/, '')
  return splitTopLevel(inner, ',')
    .map(part => normalizeWhitespace(part).replace(/^type\s+/, ''))
    .filter(Boolean)
    .map(part => {
      const aliasMatch = part.match(
        /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/,
      )
      if (!aliasMatch?.[1]) {
        return null
      }
      const imported = safePythonIdentifier(aliasMatch[1], 'symbol')
      const alias = aliasMatch[2]
        ? safePythonIdentifier(aliasMatch[2], imported)
        : null
      return alias && alias !== imported
        ? `${imported} as ${alias}`
        : imported
    })
    .filter((part): part is string => Boolean(part))
}

function renderNamespaceImport(
  moduleSpecifier: string,
  alias: string,
): string | null {
  if (!moduleSpecifier) {
    return null
  }

  if (!moduleSpecifier.startsWith('.')) {
    return `import ${moduleSpecifier} as ${alias}`
  }

  const leadingDots = moduleSpecifier.match(/^\.+/)?.[0] ?? ''
  const remainder = moduleSpecifier.slice(leadingDots.length)
  if (!remainder) {
    return null
  }

  const parts = remainder.split('.').filter(Boolean)
  const imported = parts.pop()
  if (!imported) {
    return null
  }

  const prefix = `${leadingDots}${parts.join('.')}`.replace(/\.$/, '')
  return parts.length > 0
    ? `from ${prefix} import ${imported} as ${alias}`
    : `from ${leadingDots} import ${imported} as ${alias}`
}

function extractImportStubs(text: string, currentRelativePath: string): string[] {
  const stubs: string[] = []

  for (const match of text.matchAll(
    /^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?$/gm,
  )) {
    const rawClause = normalizeWhitespace((match[1] ?? '').replace(/^type\s+/, ''))
    const moduleSpecifier = toPythonModuleSpecifier(
      currentRelativePath,
      match[2] ?? '',
    )
    if (!rawClause || !moduleSpecifier) {
      continue
    }

    let defaultImport: string | null = null
    let namespaceImport: string | null = null
    const namedImports: string[] = []

    for (const part of splitTopLevel(rawClause, ',')) {
      const normalized = normalizeWhitespace(part)
      if (!normalized) {
        continue
      }
      if (normalized.startsWith('{')) {
        namedImports.push(...parseNamedImportList(normalized))
        continue
      }
      const namespaceMatch = normalized.match(/^\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/)
      if (namespaceMatch?.[1]) {
        namespaceImport = safePythonIdentifier(namespaceMatch[1], 'namespace_')
        continue
      }
      defaultImport = safePythonIdentifier(
        normalized.replace(/^type\s+/, ''),
        'imported_symbol',
      )
    }

    const importedNames = [
      ...(defaultImport ? [defaultImport] : []),
      ...namedImports,
    ]
    if (importedNames.length > 0) {
      stubs.push(`from ${moduleSpecifier} import ${importedNames.join(', ')}`)
    }
    if (namespaceImport) {
      const namespaceLine = renderNamespaceImport(
        moduleSpecifier,
        namespaceImport,
      )
      if (namespaceLine) {
        stubs.push(namespaceLine)
      }
    }
  }

  for (const match of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]\s*;?$/gm)) {
    const moduleSpecifier = toPythonModuleSpecifier(
      currentRelativePath,
      match[1] ?? '',
    )
    if (moduleSpecifier && !moduleSpecifier.startsWith('.')) {
      stubs.push(`import ${moduleSpecifier}`)
    }
  }

  for (const match of text.matchAll(
    /^\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/gm,
  )) {
    const alias = safePythonIdentifier(match[1] ?? '', 'required_module')
    const moduleSpecifier = toPythonModuleSpecifier(
      currentRelativePath,
      match[2] ?? '',
    )
    if (!moduleSpecifier) {
      continue
    }
    const namespaceLine = renderNamespaceImport(moduleSpecifier, alias)
    if (namespaceLine) {
      stubs.push(namespaceLine)
    }
  }

  return dedupeStrings(stubs)
}

function extractExports(text: string): string[] {
  const exports: string[] = []

  for (const match of text.matchAll(
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
  )) {
    if (match[1]) {
      exports.push(match[1])
    }
  }

  for (const match of text.matchAll(/^\s*export\s+default\b/gm)) {
    if ((match.index ?? 0) >= 0) {
      exports.push('default')
    }
  }

  for (const match of text.matchAll(/^\s*export\s*\{([^}]+)\}/gm)) {
    const names = splitTopLevel(match[1] ?? '', ',')
    for (const name of names) {
      const aliasMatch = name.match(
        /^\s*([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?\s*$/,
      )
      if (aliasMatch?.[2]) {
        exports.push(aliasMatch[2])
      } else if (aliasMatch?.[1]) {
        exports.push(aliasMatch[1])
      }
    }
  }

  return dedupeStrings(exports)
}

function findAssignmentOperator(text: string, startIndex: number): number {
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let angleDepth = 0

  for (let index = startIndex; index < text.length; index++) {
    const char = text[index] ?? ''
    const next = text[index + 1] ?? ''
    const previous = text[index - 1] ?? ''

    if (char === '(') {
      parenDepth++
      continue
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
      continue
    }
    if (char === '[') {
      bracketDepth++
      continue
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
      continue
    }
    if (char === '{') {
      braceDepth++
      continue
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
      continue
    }
    if (char === '<') {
      angleDepth++
      continue
    }
    if (char === '>' && angleDepth > 0) {
      angleDepth--
      continue
    }

    if (
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      angleDepth === 0
    ) {
      if (char === ';') {
        return -1
      }
      if (
        char === '=' &&
        next !== '>' &&
        next !== '=' &&
        previous !== '=' &&
        previous !== '!' &&
        previous !== '<' &&
        previous !== '>'
      ) {
        return index
      }
    }
  }

  return -1
}

function findArrowOperator(text: string, startIndex: number): number {
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let angleDepth = 0

  for (let index = startIndex; index < text.length - 1; index++) {
    const char = text[index] ?? ''
    const next = text[index + 1] ?? ''

    if (char === '(') {
      parenDepth++
      continue
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
      continue
    }
    if (char === '[') {
      bracketDepth++
      continue
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
      continue
    }
    if (char === '{') {
      braceDepth++
      continue
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
      continue
    }
    if (char === '<') {
      angleDepth++
      continue
    }
    if (char === '>' && angleDepth > 0) {
      angleDepth--
      continue
    }

    if (
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      angleDepth === 0 &&
      char === '=' &&
      next === '>'
    ) {
      return index
    }
  }

  return -1
}

function findStatementEnd(text: string, startIndex: number): number {
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0

  for (let index = startIndex; index < text.length; index++) {
    const char = text[index] ?? ''

    if (char === '(') {
      parenDepth++
      continue
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
      continue
    }
    if (char === '[') {
      bracketDepth++
      continue
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
      continue
    }
    if (char === '{') {
      braceDepth++
      continue
    }
    if (char === '}') {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return index
      }
      braceDepth = Math.max(0, braceDepth - 1)
      continue
    }

    if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      if (char === ';' || char === '\n') {
        return index
      }
    }
  }

  return text.length
}

function extractReturnType(text: string): string | undefined {
  const trimmed = normalizeWhitespace(text)
  if (!trimmed.startsWith(':')) {
    return undefined
  }
  const value = cleanTypeReference(trimmed.slice(1))
  return value || undefined
}

function buildFunctionIR(args: {
  bodyText: string
  endOffsetExclusive: number
  exported: boolean
  isAsync: boolean
  isPublic: boolean
  kind: 'function' | 'method'
  lineStarts: number[]
  moduleId: string
  name: string
  originPath: string
  ownerClassName?: string
  paramsText: string
  returns?: string
  startOffset: number
}): FunctionIR {
  const qualifiedName = args.ownerClassName
    ? `${args.moduleId}::${args.ownerClassName}.${args.name}`
    : `${args.moduleId}::${args.name}`

  return {
    kind: args.kind,
    name: args.name,
    qualifiedName,
    params: parseParametersFromSignature(args.paramsText),
    returns: args.returns,
    decorators: [],
    calls: extractCallTargets(args.bodyText),
    awaits: extractAwaitTargets(args.bodyText),
    raises: extractRaisedTargets(args.bodyText),
    isAsync: args.isAsync,
    isPublic: args.isPublic,
    exported: args.exported,
    sourceLines: lineRangeFromOffsets(
      args.lineStarts,
      args.startOffset,
      args.endOffsetExclusive,
    ),
    originPath: args.originPath,
  }
}

function extractClassBases(headerText: string): string[] {
  const results: string[] = []
  const normalized = normalizeWhitespace(headerText)

  const extendsMatch = normalized.match(/\bextends\s+(.+?)(?:\bimplements\b|$)/)
  if (extendsMatch?.[1]) {
    results.push(...splitTopLevel(extendsMatch[1], ','))
  }

  const implementsMatch = normalized.match(/\bimplements\s+(.+)$/)
  if (implementsMatch?.[1]) {
    results.push(...splitTopLevel(implementsMatch[1], ','))
  }

  return dedupeStrings(results.map(cleanTypeReference))
}

function extractClassMethods(args: {
  bodyOffset: number
  bodyText: string
  className: string
  lineStarts: number[]
  moduleId: string
  originPath: string
  sanitizedBody: string
}): FunctionIR[] {
  const methods: FunctionIR[] = []
  const localDepths = computeBraceDepths(args.sanitizedBody)
  const methodRegex =
    /(?:^|[\n;])\s*(?:(?:public|private|protected|static|readonly|abstract|override|get|set|declare)\s+)*(async\s+)?(?:(constructor)|([A-Za-z_$][A-Za-z0-9_$]*))\s*(?:<[^>{=;]*>)?\s*\(/g

  for (const match of args.sanitizedBody.matchAll(methodRegex)) {
    const name = match[2] ?? match[3]
    if (!name) {
      continue
    }

    const nameIndex =
      (match.index ?? 0) + (match[0].lastIndexOf(name) >= 0 ? match[0].lastIndexOf(name) : 0)
    if ((localDepths[nameIndex] ?? 0) !== 0) {
      continue
    }

    const openParenIndex = args.sanitizedBody.indexOf('(', nameIndex)
    const closeParenIndex = findMatchingChar(
      args.sanitizedBody,
      openParenIndex,
      '(',
      ')',
    )
    if (openParenIndex === -1 || closeParenIndex === -1) {
      continue
    }

    const afterParamsIndex = skipWhitespace(args.sanitizedBody, closeParenIndex + 1)
    const bodyStartIndex = args.sanitizedBody.indexOf('{', afterParamsIndex)
    const statementTerminatorIndex = args.sanitizedBody.indexOf(';', afterParamsIndex)
    if (
      bodyStartIndex === -1 ||
      (statementTerminatorIndex !== -1 && statementTerminatorIndex < bodyStartIndex)
    ) {
      continue
    }

    const bodyEndIndex = findMatchingChar(
      args.sanitizedBody,
      bodyStartIndex,
      '{',
      '}',
    )
    if (bodyEndIndex === -1) {
      continue
    }

    const paramsText = args.bodyText.slice(openParenIndex + 1, closeParenIndex)
    const returnSegment = args.bodyText.slice(afterParamsIndex, bodyStartIndex)
    const bodyText = args.bodyText.slice(bodyStartIndex + 1, bodyEndIndex)
    const modifiersText = normalizeWhitespace(
      args.bodyText.slice(match.index ?? 0, openParenIndex),
    )

    methods.push(
      buildFunctionIR({
        bodyText,
        endOffsetExclusive: args.bodyOffset + bodyEndIndex + 1,
        exported: false,
        isAsync: Boolean(match[1]),
        isPublic:
          !/\bprivate\b/.test(modifiersText) &&
          !/\bprotected\b/.test(modifiersText),
        kind: 'method',
        lineStarts: args.lineStarts,
        moduleId: args.moduleId,
        name,
        originPath: args.originPath,
        ownerClassName: args.className,
        paramsText,
        returns:
          name === 'constructor' ? 'None' : extractReturnType(returnSegment),
        startOffset: args.bodyOffset + nameIndex,
      }),
    )
  }

  return methods
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
    /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g

  for (const match of args.sanitizedText.matchAll(classRegex)) {
    const name = match[1]
    if (!name) {
      continue
    }

    const classIndex = (match.index ?? 0) + match[0].lastIndexOf('class')
    if ((braceDepths[classIndex] ?? 0) !== 0) {
      continue
    }

    const bodyStartIndex = args.sanitizedText.indexOf('{', classIndex)
    if (bodyStartIndex === -1) {
      continue
    }
    const bodyEndIndex = findMatchingChar(
      args.sanitizedText,
      bodyStartIndex,
      '{',
      '}',
    )
    if (bodyEndIndex === -1) {
      continue
    }

    const headerText = args.text.slice(classIndex, bodyStartIndex)
    const bodyText = args.text.slice(bodyStartIndex + 1, bodyEndIndex)
    const sanitizedBody = args.sanitizedText.slice(bodyStartIndex + 1, bodyEndIndex)
    const methods = extractClassMethods({
      bodyOffset: bodyStartIndex + 1,
      bodyText,
      className: name,
      lineStarts: args.lineStarts,
      moduleId: args.moduleId,
      originPath: args.originPath,
      sanitizedBody,
    })
    const constructorMethod = methods.find(method => method.name === 'constructor')

    classes.push({
      name,
      qualifiedName: `${args.moduleId}::${name}`,
      bases: extractClassBases(headerText),
      dependsOn: dedupeStrings(
        (constructorMethod?.params ?? []).map(dependencyLabelForParam),
      ),
      methods,
      exported: /\bexport\b/.test(match[0]),
      sourceLines: lineRangeFromOffsets(
        args.lineStarts,
        classIndex,
        bodyEndIndex + 1,
      ),
      originPath: args.originPath,
    })
  }

  return classes
}

function extractFunctionDeclarations(args: {
  lineStarts: number[]
  moduleId: string
  sanitizedText: string
  text: string
}): FunctionIR[] {
  const functions: FunctionIR[] = []
  const braceDepths = computeBraceDepths(args.sanitizedText)
  const functionRegex =
    /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>{=;]*>)?\s*\(/g

  for (const match of args.sanitizedText.matchAll(functionRegex)) {
    const name = match[1]
    if (!name) {
      continue
    }

    const functionIndex = (match.index ?? 0) + match[0].lastIndexOf('function')
    if ((braceDepths[functionIndex] ?? 0) !== 0) {
      continue
    }

    const openParenIndex = args.sanitizedText.indexOf('(', functionIndex)
    const closeParenIndex = findMatchingChar(
      args.sanitizedText,
      openParenIndex,
      '(',
      ')',
    )
    if (openParenIndex === -1 || closeParenIndex === -1) {
      continue
    }

    const bodyStartIndex = args.sanitizedText.indexOf(
      '{',
      skipWhitespace(args.sanitizedText, closeParenIndex + 1),
    )
    if (bodyStartIndex === -1) {
      continue
    }

    const bodyEndIndex = findMatchingChar(
      args.sanitizedText,
      bodyStartIndex,
      '{',
      '}',
    )
    if (bodyEndIndex === -1) {
      continue
    }

    functions.push(
      buildFunctionIR({
        bodyText: args.text.slice(bodyStartIndex + 1, bodyEndIndex),
        endOffsetExclusive: bodyEndIndex + 1,
        exported: /\bexport\b/.test(match[0]),
        isAsync: /\basync\b/.test(match[0]),
        isPublic: !name.startsWith('_'),
        kind: 'function',
        lineStarts: args.lineStarts,
        moduleId: args.moduleId,
        name,
        originPath: args.originPath,
        paramsText: args.text.slice(openParenIndex + 1, closeParenIndex),
        returns: extractReturnType(
          args.text.slice(closeParenIndex + 1, bodyStartIndex),
        ),
        startOffset: functionIndex,
      }),
    )
  }

  return functions
}

function extractVariableFunctions(args: {
  lineStarts: number[]
  moduleId: string
  sanitizedText: string
  text: string
}): FunctionIR[] {
  const functions: FunctionIR[] = []
  const braceDepths = computeBraceDepths(args.sanitizedText)
  const variableRegex =
    /(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g

  for (const match of args.sanitizedText.matchAll(variableRegex)) {
    const name = match[1]
    if (!name) {
      continue
    }

    const nameIndex = (match.index ?? 0) + match[0].lastIndexOf(name)
    if ((braceDepths[nameIndex] ?? 0) !== 0) {
      continue
    }

    const assignmentIndex = findAssignmentOperator(
      args.sanitizedText,
      nameIndex + name.length,
    )
    if (assignmentIndex === -1) {
      continue
    }

    let valueIndex = skipWhitespace(args.sanitizedText, assignmentIndex + 1)
    let isAsync = false

    if (
      args.sanitizedText.startsWith('async', valueIndex) &&
      /[\s(]/.test(args.sanitizedText[valueIndex + 5] ?? ' ')
    ) {
      isAsync = true
      valueIndex = skipWhitespace(args.sanitizedText, valueIndex + 5)
    }

    if (args.sanitizedText.startsWith('function', valueIndex)) {
      const openParenIndex = args.sanitizedText.indexOf('(', valueIndex)
      const closeParenIndex = findMatchingChar(
        args.sanitizedText,
        openParenIndex,
        '(',
        ')',
      )
      if (openParenIndex === -1 || closeParenIndex === -1) {
        continue
      }

      const bodyStartIndex = args.sanitizedText.indexOf(
        '{',
        skipWhitespace(args.sanitizedText, closeParenIndex + 1),
      )
      if (bodyStartIndex === -1) {
        continue
      }
      const bodyEndIndex = findMatchingChar(
        args.sanitizedText,
        bodyStartIndex,
        '{',
        '}',
      )
      if (bodyEndIndex === -1) {
        continue
      }

      functions.push(
        buildFunctionIR({
          bodyText: args.text.slice(bodyStartIndex + 1, bodyEndIndex),
          endOffsetExclusive: bodyEndIndex + 1,
          exported: /\bexport\b/.test(match[0]),
          isAsync,
          isPublic: !name.startsWith('_'),
          kind: 'function',
          lineStarts: args.lineStarts,
          moduleId: args.moduleId,
          name,
          originPath: args.originPath,
          paramsText: args.text.slice(openParenIndex + 1, closeParenIndex),
          returns: extractReturnType(
            args.text.slice(closeParenIndex + 1, bodyStartIndex),
          ),
          startOffset: nameIndex,
        }),
      )
      continue
    }

    let paramsText = ''
    let returnType: string | undefined
    let searchFrom = valueIndex

    if (args.sanitizedText[valueIndex] === '(') {
      const closeParenIndex = findMatchingChar(
        args.sanitizedText,
        valueIndex,
        '(',
        ')',
      )
      if (closeParenIndex === -1) {
        continue
      }
      paramsText = args.text.slice(valueIndex + 1, closeParenIndex)
      const arrowIndex = findArrowOperator(
        args.sanitizedText,
        closeParenIndex + 1,
      )
      if (arrowIndex === -1) {
        continue
      }
      returnType = extractReturnType(
        args.text.slice(closeParenIndex + 1, arrowIndex),
      )
      searchFrom = arrowIndex + 2
    } else {
      const singleParamMatch = args.sanitizedText
        .slice(valueIndex)
        .match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*=>/)
      if (!singleParamMatch?.[1]) {
        continue
      }
      paramsText = singleParamMatch[1]
      searchFrom = valueIndex + singleParamMatch[0].length
    }

    const bodyStartIndex = skipWhitespace(args.sanitizedText, searchFrom)
    if (bodyStartIndex >= args.sanitizedText.length) {
      continue
    }

    if (args.sanitizedText[bodyStartIndex] === '{') {
      const bodyEndIndex = findMatchingChar(
        args.sanitizedText,
        bodyStartIndex,
        '{',
        '}',
      )
      if (bodyEndIndex === -1) {
        continue
      }
      functions.push(
        buildFunctionIR({
          bodyText: args.text.slice(bodyStartIndex + 1, bodyEndIndex),
          endOffsetExclusive: bodyEndIndex + 1,
          exported: /\bexport\b/.test(match[0]),
          isAsync,
          isPublic: !name.startsWith('_'),
          kind: 'function',
          lineStarts: args.lineStarts,
          moduleId: args.moduleId,
          name,
          paramsText,
          returns: returnType,
          startOffset: nameIndex,
        }),
      )
      continue
    }

    const expressionEnd = findStatementEnd(args.sanitizedText, bodyStartIndex)
    functions.push(
      buildFunctionIR({
        bodyText: args.text.slice(bodyStartIndex, expressionEnd),
        endOffsetExclusive: expressionEnd,
        exported: /\bexport\b/.test(match[0]),
        isAsync,
        isPublic: !name.startsWith('_'),
        kind: 'function',
        lineStarts: args.lineStarts,
        moduleId: args.moduleId,
        name,
        originPath: args.originPath,
        paramsText,
        returns: returnType,
        startOffset: nameIndex,
      }),
    )
  }

  return functions
}

export function parseTypeScriptLikeModule(context: ParseContext): ModuleIR {
  const moduleId = relativePathToModuleId(context.file.relativePath)
  const text = context.source.text
  const sanitizedText = sanitizeForStructure(text)
  const lineStarts = computeLineStarts(text)

  const classes = extractClasses({
    lineStarts,
    moduleId,
    originPath: context.file.relativePath,
    sanitizedText,
    text,
  })
  const functions = dedupeStrings(
    [
      ...extractFunctionDeclarations({
        lineStarts,
        moduleId,
        originPath: context.file.relativePath,
        sanitizedText,
        text,
      }).map(fn => fn.qualifiedName),
      ...extractVariableFunctions({
        lineStarts,
        moduleId,
        originPath: context.file.relativePath,
        sanitizedText,
        text,
      }).map(fn => fn.qualifiedName),
    ],
  )

  const functionMap = new Map<string, FunctionIR>()
  for (const fn of [
    ...extractFunctionDeclarations({
      lineStarts,
      moduleId,
      originPath: context.file.relativePath,
      sanitizedText,
      text,
    }),
    ...extractVariableFunctions({
      lineStarts,
      moduleId,
      originPath: context.file.relativePath,
      sanitizedText,
      text,
    }),
  ]) {
    if (!functionMap.has(fn.qualifiedName)) {
      functionMap.set(fn.qualifiedName, fn)
    }
  }

  return {
    moduleId,
    sourcePath: context.file.absolutePath,
    relativePath: context.file.relativePath,
    language: context.file.language,
    parseMode: context.source.truncated
      ? 'ts-heuristic-truncated'
      : 'ts-heuristic',
    imports: extractImports(text),
    importStubs: extractImportStubs(text, context.file.relativePath),
    exports: extractExports(text),
    classes,
    functions: functions.map(name => functionMap.get(name)!).filter(Boolean),
    notes: context.source.truncated
      ? [`source truncated to ${context.config.maxFileBytes} bytes before parsing`]
      : [],
    errors: [],
    sourceBytes: context.source.byteSize,
    lineCount: lineStarts.length,
    truncated: context.source.truncated,
  }
}
