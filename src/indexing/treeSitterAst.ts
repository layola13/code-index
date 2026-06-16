import { createRequire } from 'module'
import { dirname, extname, posix } from 'path'

import type { ClassIR, FunctionIR, ModuleIR, ParamIR } from './ir.js'
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
  safePythonIdentifier,
  splitTopLevel,
  stripQuotes,
} from './parserUtils.js'
import { getCodeLanguageForPath } from './config.js'
import {
  loadTreeSitter,
  loadTreeSitterParser,
} from './treeSitter.js'
import { parseGenericModule } from './parsers/generic.js'
import { parsePythonModule } from './parsers/python.js'
import { parseTypeScriptLikeModule } from './parsers/typescriptLike.js'

type SyntaxNode = ReturnType<ReturnType<typeof loadTreeSitterParser>['parse']>['rootNode']

type ParseLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'ocaml'
  | 'ocaml_interface'
  | 'go'
  | 'rust'
  | 'java'
  | 'haxe'
  | 'c'
  | 'cpp'
  | 'zig'
  | 'saasm'
  | 'generic'

type AstModuleResult = {
  classes: ClassIR[]
  errors: string[]
  exportNames: string[]
  importStubs: string[]
  imports: string[]
  functions: FunctionIR[]
  notes: string[]
  language: string
}

const nodeRequire = createRequire(import.meta.url)

type TreeSitterParseLanguage = Exclude<ParseLanguage, 'generic' | 'saasm'>

type LanguageLoaders = {
  javascript: () => unknown
  python: () => unknown
  ocaml: () => unknown
  ocaml_interface: () => unknown
  go: () => unknown
  rust: () => unknown
  java: () => unknown
  haxe: () => unknown
  c: () => unknown
  cpp: () => unknown
  zig: () => unknown
  typescript: () => unknown
  tsx: () => unknown
}

const languageRootPackages: Record<TreeSitterParseLanguage, string> = {
  typescript: 'tree-sitter-typescript',
  tsx: 'tree-sitter-typescript',
  javascript: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  ocaml: 'tree-sitter-ocaml',
  ocaml_interface: 'tree-sitter-ocaml',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  java: 'tree-sitter-java',
  haxe: 'tree-sitter-haxe',
  c: 'tree-sitter-c',
  cpp: 'tree-sitter-cpp',
  zig: '@tree-sitter-grammars/tree-sitter-zig',
}

const parseLanguageByExtension: Array<[RegExp, ParseLanguage]> = [
  [/\.mli$/i, 'ocaml_interface'],
  [/\.ml$/i, 'ocaml'],
  [/\.tsx$/i, 'tsx'],
  [/\.mts$/i, 'typescript'],
  [/\.cts$/i, 'typescript'],
  [/\.ts$/i, 'typescript'],
  [/\.jsx$/i, 'javascript'],
  [/\.mjs$/i, 'javascript'],
  [/\.cjs$/i, 'javascript'],
  [/\.js$/i, 'javascript'],
  [/\.py$/i, 'python'],
  [/\.go$/i, 'go'],
  [/\.sla$/i, 'rust'],
  [/\.rs$/i, 'rust'],
  [/\.java$/i, 'java'],
  [/\.hx$/i, 'haxe'],
  [/\.zig$/i, 'zig'],
  [/\.sa$/i, 'saasm'],
  [/\.sai$/i, 'saasm'],
  [/\.sal$/i, 'saasm'],
  [/\.cpp$/i, 'cpp'],
  [/\.cxx$/i, 'cpp'],
  [/\.cc$/i, 'cpp'],
  [/\.hpp$/i, 'cpp'],
  [/\.hxx$/i, 'cpp'],
  [/\.hh$/i, 'cpp'],
  [/\.h\+\+$/i, 'cpp'],
  [/\.c\+\+$/i, 'cpp'],
  [/\.c$/i, 'c'],
  [/\.h$/i, 'cpp'],
]

const parserCache = new Map<ParseLanguage, ReturnType<typeof loadTreeSitterParser>>()
const languageBindingCache = new Map<ParseLanguage, unknown>()
const structureCache = new Map<string, AstModuleResult>()

function loadLanguageBinding(language: TreeSitterParseLanguage): unknown {
  const cached = languageBindingCache.get(language)
  if (cached) {
    return cached
  }

  const packageName = languageRootPackages[language]
  const resolvedPackageJson = nodeRequire.resolve(`${packageName}/package.json`)
  const packageRoot = dirname(resolvedPackageJson)
  const binding = nodeRequire('node-gyp-build')(packageRoot)

  let value: unknown = binding
  if (language === 'typescript' || language === 'tsx') {
    const typed = binding as { tsx?: unknown; typescript?: unknown }
    value = language === 'tsx' ? typed.tsx : typed.typescript
  } else if (language === 'ocaml' || language === 'ocaml_interface') {
    const typed = binding as { ocaml?: unknown; ocaml_interface?: unknown }
    value = language === 'ocaml_interface' ? typed.ocaml_interface : typed.ocaml
  }

  if (!value) {
    throw new Error(`tree-sitter language binding unavailable for ${language}`)
  }

  languageBindingCache.set(language, value)
  return value
}

function loadParser(language: ParseLanguage): ReturnType<typeof loadTreeSitterParser> {
  const cached = parserCache.get(language)
  if (cached) {
    return cached
  }

  const parser = loadTreeSitterParser()
  if (language === 'generic') {
    parserCache.set(language, parser)
    return parser
  }
  if (language === 'saasm') {
    throw new Error('SA source uses the line-oriented parser, not tree-sitter')
  }

  const binding = loadLanguageBinding(language)
  const languageObject =
    (binding as { language?: unknown }).language ?? binding
  ;(parser as { setLanguage(language?: unknown): void }).setLanguage(languageObject)
  parserCache.set(language, parser)
  return parser
}

function detectAstLanguage(filePath: string, sourceText: string): ParseLanguage {
  const pathLanguage = getCodeLanguageForPath(filePath)
  if (pathLanguage === 'saasm') {
    return 'saasm'
  }

  const extension = extname(filePath).toLowerCase()
  for (const [pattern, language] of parseLanguageByExtension) {
    if (pattern.test(extension)) {
      if (language === 'cpp' && extension === '.h') {
        return /class\s+|namespace\s+|template\s*<|struct\s+[A-Za-z_][A-Za-z0-9_]*/.test(sourceText)
          ? 'cpp'
          : 'c'
      }
      return language
    }
  }

  return 'generic'
}

function getNodeText(sourceText: string, node: SyntaxNode | null | undefined): string {
  if (!node) {
    return ''
  }
  return sourceText.slice(node.startIndex, node.endIndex)
}

function getChildText(sourceText: string, node: SyntaxNode, fieldName: string): string {
  return getNodeText(sourceText, node.childForFieldName(fieldName))
}

function getNamedChildText(sourceText: string, node: SyntaxNode, index: number): string {
  return getNodeText(sourceText, node.namedChild(index))
}

function getQualifiedNameFromNode(sourceText: string, node: SyntaxNode | null | undefined): string {
  const text = normalizeWhitespace(getNodeText(sourceText, node))
  return text.replace(/\s+/g, ' ').trim()
}

function getBodyText(sourceText: string, node: SyntaxNode | null | undefined): string {
  if (!node) {
    return ''
  }
  const text = getNodeText(sourceText, node)
  const openIndex = text.indexOf('{')
  const closeIndex = text.lastIndexOf('}')
  if (openIndex >= 0 && closeIndex > openIndex) {
    return text.slice(openIndex + 1, closeIndex)
  }
  return text
}

function lineRangeForNode(
  lineStarts: readonly number[],
  node: SyntaxNode | null | undefined,
): { start: number; end: number } {
  if (!node) {
    return { start: 1, end: 1 }
  }
  return lineRangeFromOffsets(lineStarts, node.startIndex, node.endIndex)
}

function containsType(node: SyntaxNode | null | undefined, types: readonly string[]): boolean {
  if (!node) {
    return false
  }
  let current: SyntaxNode | null = node
  while (current) {
    if (types.includes(current.type)) {
      return true
    }
    current = current.parent
  }
  return false
}

function hasAncestorType(node: SyntaxNode | null | undefined, type: string): boolean {
  return containsType(node, [type])
}

function isTopLevel(node: SyntaxNode, root: SyntaxNode): boolean {
  const parent = node.parent
  return parent === root || parent?.type === 'export_statement'
}

function nodeDecorators(sourceText: string, node: SyntaxNode): string[] {
  const decorators = node.childrenForFieldName('decorator')
  if (decorators.length === 0) {
    return []
  }
  return dedupeStrings(decorators.map(decorator => normalizeWhitespace(getNodeText(sourceText, decorator))))
}

function renderParamListText(sourceText: string, node: SyntaxNode | null | undefined): string {
  if (!node) {
    return ''
  }
  if (node.type === 'parameters' || node.type === 'formal_parameters' || node.type === 'parameter_list') {
    return getNodeText(sourceText, node).slice(1, -1)
  }
  return getNodeText(sourceText, node)
}

function buildFunctionIR(args: {
  bodyText: string
  decorators?: string[]
  endNode: SyntaxNode
  exported: boolean
  isAsync: boolean
  kind: 'function' | 'method'
  moduleId: string
  name: string
  originPath: string
  paramsText: string
  returnType?: string
  sourceText: string
  startNode: SyntaxNode
  ownerClassName?: string
}): FunctionIR {
  return {
    kind: args.kind,
    name: args.name,
    qualifiedName: args.ownerClassName
      ? `${args.moduleId}::${args.ownerClassName}.${args.name}`
      : `${args.moduleId}::${args.name}`,
    params: parseParametersFromSignature(args.paramsText),
    returns: args.returnType ? cleanTypeReference(args.returnType) : undefined,
    decorators: dedupeStrings(args.decorators ?? []),
    calls: extractCallTargets(args.bodyText),
    awaits: extractAwaitTargets(args.bodyText),
    raises: extractRaisedTargets(args.bodyText),
    isAsync: args.isAsync,
    isPublic: !args.name.startsWith('_'),
    exported: args.exported,
    sourceLines: lineRangeFromOffsets(
      computeLineStarts(args.sourceText),
      args.startNode.startIndex,
      args.endNode.endIndex,
    ),
    originPath: args.originPath,
  }
}

function buildClassIR(args: {
  bases: string[]
  decorators?: string[]
  dependsOn?: string[]
  exported: boolean
  lineStarts: readonly number[]
  methods: FunctionIR[]
  moduleId: string
  name: string
  originPath: string
  sourceText: string
  startNode: SyntaxNode
  endNode: SyntaxNode
  qualifiedNamePrefix?: string
  ownerClassName?: string
}): ClassIR {
  return {
    name: args.name,
    qualifiedName: args.qualifiedNamePrefix
      ? `${args.moduleId}::${args.qualifiedNamePrefix}${args.name}`
      : args.ownerClassName
      ? `${args.moduleId}::${args.ownerClassName}.${args.name}`
      : `${args.moduleId}::${args.name}`,
    bases: dedupeStrings(args.bases),
    dependsOn: dedupeStrings(args.dependsOn ?? []),
    methods: args.methods,
    exported: args.exported,
    sourceLines: lineRangeFromOffsets(
      args.lineStarts,
      args.startNode.startIndex,
      args.endNode.endIndex,
    ),
    originPath: args.originPath,
  }
}

function parseJSImportClause(
  sourceText: string,
  node: SyntaxNode,
  currentRelativePath: string,
): { imports: string[]; stubs: string[] } {
  const moduleSpecifier = stripQuotes(getChildText(sourceText, node, 'source'))
  if (!moduleSpecifier) {
    return { imports: [], stubs: [] }
  }

  const imports: string[] = [moduleSpecifier]
  const stubs: string[] = []
  const clauses = node.namedChildren.filter(child =>
    ['import_clause', 'import_require_clause', 'import_attribute'].includes(child.type),
  )

  for (const clause of clauses) {
    if (clause.type === 'import_clause') {
      const defaultImport = clause.childForFieldName('name')?.text?.trim()
      const namespaceImport = clause.namedChildren.find(child => child.type === 'namespace_import')
      const namedImports = clause.namedChildren.find(child => child.type === 'named_imports')
      const items: string[] = []

      if (defaultImport) {
        items.push(safePythonIdentifier(defaultImport, 'imported_symbol'))
      }

      if (namedImports) {
        for (const specifier of namedImports.namedChildren) {
          if (specifier.type !== 'import_specifier') {
            continue
          }
          const name = specifier.childForFieldName('name')?.text?.trim()
          const alias = specifier.childForFieldName('alias')?.text?.trim()
          if (!name) {
            continue
          }
          const imported = safePythonIdentifier(name, 'symbol')
          const normalizedAlias = alias ? safePythonIdentifier(alias, imported) : null
          items.push(
            normalizedAlias && normalizedAlias !== imported
              ? `${imported} as ${normalizedAlias}`
              : imported,
          )
        }
      }

      if (items.length > 0) {
        stubs.push(`from ${toPythonModuleSpecifier(currentRelativePath, moduleSpecifier) ?? moduleSpecifier} import ${items.join(', ')}`)
      }

      if (namespaceImport) {
        const alias = namespaceImport.childForFieldName('name')?.text?.trim()
        if (alias) {
          const normalizedAlias = safePythonIdentifier(alias, 'namespace_')
          stubs.push(`import ${toPythonModuleSpecifier(currentRelativePath, moduleSpecifier) ?? moduleSpecifier} as ${normalizedAlias}`)
        }
      }
    }
  }

  return {
    imports: dedupeStrings(imports),
    stubs: dedupeStrings(stubs),
  }
}

function toPythonModuleSpecifier(
  currentRelativePath: string,
  rawSpecifier: string,
): string | null {
  let specifier = normalizeWhitespace(rawSpecifier)
  if (!specifier) {
    return null
  }

  specifier = specifier.replace(/^(node:)/, '')
  specifier = specifier.replace(/\.(?:[cm]?[jt]sx?|py|zig)$/i, '')
  specifier = specifier.replace(/\/index$/i, '')

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

    const leadingDots = '.'.repeat(currentSegments.length - common + 1)
    const remainder = targetSegments
      .slice(common)
      .map(segment => safePythonIdentifier(segment, 'mod'))
      .join('.')
    return remainder ? `${leadingDots}${remainder}` : leadingDots
  }

  return specifier
    .split('/')
    .filter(Boolean)
    .map(segment => safePythonIdentifier(segment, 'mod'))
    .join('.')
}

function parseTSJSImportClause(
  sourceText: string,
  node: SyntaxNode,
  currentRelativePath: string,
): { imports: string[]; stubs: string[] } {
  const moduleSpecifier = stripQuotes(getChildText(sourceText, node, 'source'))
  if (!moduleSpecifier) {
    return { imports: [], stubs: [] }
  }

  const normalizedModuleSpecifier =
    toPythonModuleSpecifier(currentRelativePath, moduleSpecifier) ?? moduleSpecifier
  const stubs: string[] = []
  const imports: string[] = [moduleSpecifier]

  const clause = node.childForFieldName('import_clause')
  if (clause) {
    const items: string[] = []
    const defaultImport = clause.childForFieldName('name')?.text?.trim()
    if (defaultImport) {
      items.push(safePythonIdentifier(defaultImport, 'imported_symbol'))
    }

    const namedImports = clause.namedChildren.find(child => child.type === 'named_imports')
    if (namedImports) {
      for (const specifier of namedImports.namedChildren) {
        if (specifier.type !== 'import_specifier') {
          continue
        }
        const name = specifier.childForFieldName('name')?.text?.trim()
        const alias = specifier.childForFieldName('alias')?.text?.trim()
        if (!name) {
          continue
        }
        const imported = safePythonIdentifier(name, 'symbol')
        const normalizedAlias = alias ? safePythonIdentifier(alias, imported) : null
        items.push(
          normalizedAlias && normalizedAlias !== imported
            ? `${imported} as ${normalizedAlias}`
            : imported,
        )
      }
    }

    const namespaceImport = clause.namedChildren.find(child => child.type === 'namespace_import')
    if (items.length > 0) {
      stubs.push(`from ${normalizedModuleSpecifier} import ${items.join(', ')}`)
    }
    if (namespaceImport) {
      const alias = namespaceImport.childForFieldName('name')?.text?.trim()
      if (alias) {
        stubs.push(`import ${normalizedModuleSpecifier} as ${safePythonIdentifier(alias, 'namespace_')}`)
      }
    }
  } else if (node.type === 'import_statement') {
    stubs.push(`import ${normalizedModuleSpecifier}`)
  }

  return {
    imports: dedupeStrings(imports),
    stubs: dedupeStrings(stubs),
  }
}

function parseExportNamesFromStatement(
  sourceText: string,
  node: SyntaxNode,
): string[] {
  const names: string[] = []
  if (node.childForFieldName('source')) {
    const clause = node.namedChildren.find(child => child.type === 'export_clause')
    if (clause) {
      for (const child of clause.namedChildren) {
        if (child.type !== 'export_specifier') {
          continue
        }
        const alias = child.childForFieldName('alias')?.text?.trim()
        const name = child.childForFieldName('name')?.text?.trim()
        if (alias) {
          names.push(alias)
        } else if (name) {
          names.push(name)
        }
      }
    }
    return dedupeStrings(names)
  }

  const declaration = node.childForFieldName('declaration')
  if (declaration) {
    const declarationName =
      declaration.childForFieldName('name')?.text?.trim() ??
      declaration.namedChildren.find(child =>
        ['class_declaration', 'function_declaration', 'lexical_declaration'].includes(child.type),
      )?.childForFieldName('name')?.text?.trim()
    if (declarationName) {
      names.push(declarationName)
    }
  }

  if (node.children.some(child => child.type === 'default')) {
    names.push('default')
  }

  if (node.children.some(child => child.type === 'export_clause')) {
    const clause = node.namedChildren.find(child => child.type === 'export_clause')
    if (clause) {
      for (const child of clause.namedChildren) {
        if (child.type !== 'export_specifier') {
          continue
        }
        const alias = child.childForFieldName('alias')?.text?.trim()
        const name = child.childForFieldName('name')?.text?.trim()
        if (alias) {
          names.push(alias)
        } else if (name) {
          names.push(name)
        }
      }
    }
  }

  if (node.children.some(child => child.type === 'default')) {
    names.push('default')
  }

  return dedupeStrings(names)
}

function parseTsJsFunctionFromVariable(
  sourceText: string,
  moduleId: string,
  originPath: string,
  lineStarts: readonly number[],
  node: SyntaxNode,
  exported: boolean,
): FunctionIR | null {
  const declaratorName = node.childForFieldName('name')?.text?.trim()
  const value = node.childForFieldName('value')
  if (!declaratorName || !value) {
    return null
  }

  if (!['arrow_function', 'function_expression', 'generator_function'].includes(value.type)) {
    return null
  }

  const params = value.childForFieldName('parameters') ?? value.childForFieldName('parameter')
  const body = value.childForFieldName('body')
  const returnType = value.childForFieldName('return_type')?.text?.trim()
  const bodyText = body ? getBodyText(sourceText, body) : getNodeText(sourceText, value)
  const paramsText = renderParamListText(sourceText, params)
  const startNode = node
  const endNode = value
  const isAsync = /\basync\b/.test(getNodeText(sourceText, value))

  return {
    kind: 'function',
    name: declaratorName,
    qualifiedName: `${moduleId}::${declaratorName}`,
    params: parseParametersFromSignature(paramsText),
    returns: returnType ? cleanTypeReference(returnType) : undefined,
    decorators: [],
    calls: extractCallTargets(bodyText),
    awaits: extractAwaitTargets(bodyText),
    raises: extractRaisedTargets(bodyText),
    isAsync,
    isPublic: !declaratorName.startsWith('_'),
    exported,
    sourceLines: lineRangeFromOffsets(lineStarts, startNode.startIndex, endNode.endIndex),
    originPath,
  }
}

function parseTsJsClassMethods(
  sourceText: string,
  moduleId: string,
  originPath: string,
  lineStarts: readonly number[],
  className: string,
  classBody: SyntaxNode,
  exported: boolean,
): { dependsOn: string[]; methods: FunctionIR[] } {
  const methods: FunctionIR[] = []
  const dependencies: string[] = []

  for (const member of classBody.namedChildren) {
    if (member.type !== 'method_definition') {
      continue
    }
    const nameNode = member.childForFieldName('name')
    const name = normalizeWhitespace(getNodeText(sourceText, nameNode))
    const paramsNode = member.childForFieldName('parameters')
    const bodyNode = member.childForFieldName('body')
    const returnType = member.childForFieldName('return_type')?.text?.trim()
    const isAsync = /\basync\b/.test(getNodeText(sourceText, member))
    const bodyText = bodyNode ? getBodyText(sourceText, bodyNode) : ''
    const decorators = nodeDecorators(sourceText, member)

    if (!name) {
      continue
    }

    const method: FunctionIR = {
      kind: 'method',
      name,
      qualifiedName: `${moduleId}::${className}.${name}`,
      params: parseParametersFromSignature(renderParamListText(sourceText, paramsNode)),
      returns:
        name === 'constructor'
          ? 'None'
          : returnType
            ? cleanTypeReference(returnType)
            : undefined,
      decorators,
      calls: extractCallTargets(bodyText),
      awaits: extractAwaitTargets(bodyText),
      raises: extractRaisedTargets(bodyText),
      isAsync,
      isPublic: !name.startsWith('_'),
      exported,
      sourceLines: lineRangeFromOffsets(lineStarts, member.startIndex, member.endIndex),
      originPath,
    }
    methods.push(method)
  }

  const constructor = methods.find(method => method.name === 'constructor')
  if (constructor) {
    dependencies.push(
      ...constructor.params.map(param => dependencyLabelForParam(param)),
    )
  }

  return {
    dependsOn: dedupeStrings(dependencies),
    methods,
  }
}

function parseTsJsClass(
  sourceText: string,
  moduleId: string,
  originPath: string,
  lineStarts: readonly number[],
  node: SyntaxNode,
  exported: boolean,
): ClassIR | null {
  const name = node.childForFieldName('name')?.text?.trim()
  const body = node.childForFieldName('body')
  if (!name || !body) {
    return null
  }

  const headerText = sourceText.slice(node.startIndex, body.startIndex)
  const bases: string[] = []
  const extendsMatch = headerText.match(/\bextends\s+(.+?)(?:\bimplements\b|$)/)
  if (extendsMatch?.[1]) {
    bases.push(
      ...splitTopLevel(extendsMatch[1], ',').map(base => cleanTypeReference(base)),
    )
  }
  const implementsMatch = headerText.match(/\bimplements\s+(.+)$/)
  if (implementsMatch?.[1]) {
    bases.push(
      ...splitTopLevel(implementsMatch[1], ',').map(base => cleanTypeReference(base)),
    )
  }

  const { dependsOn, methods } = parseTsJsClassMethods(
    sourceText,
    moduleId,
    originPath,
    lineStarts,
    name,
    body,
    exported,
  )

  return buildClassIR({
    bases,
    dependsOn,
    exported,
    lineStarts,
    methods,
    moduleId,
    name,
    originPath,
    sourceText,
    startNode: node,
    endNode: body,
  })
}

function parseTsJsModule(args: {
  filePath: string
  moduleId: string
  relativePath: string
  sourceText: string
  language: 'typescript' | 'tsx' | 'javascript'
}): AstModuleResult {
  const key = `${args.language}:${args.filePath}:${args.sourceText.length}:${args.sourceText.slice(0, 32)}`
  const cached = structureCache.get(key)
  if (cached) {
    return cached
  }

  const parser = loadParser(args.language)
  const tree = parser.parse(args.sourceText)
  const root = tree.rootNode as SyntaxNode
  const lineStarts = computeLineStarts(args.sourceText)
  const classes: ClassIR[] = []
  const functions: FunctionIR[] = []
  const imports: string[] = []
  const stubs: string[] = []
  const exports: string[] = []
  const errors: string[] = []

  for (const child of root.namedChildren) {
    if (child.type === 'import_statement') {
      const parsed = parseTSJSImportClause(args.sourceText, child, args.relativePath)
      imports.push(...parsed.imports)
      stubs.push(...parsed.stubs)
      continue
    }

    if (child.type === 'export_statement') {
      exports.push(...parseExportNamesFromStatement(args.sourceText, child))
      const declaration = child.childForFieldName('declaration')
      if (declaration) {
        if (declaration.type === 'class_declaration') {
          const parsed = parseTsJsClass(
            args.sourceText,
            args.moduleId,
            args.relativePath,
            lineStarts,
            declaration,
            true,
          )
          if (parsed) {
            classes.push(parsed)
          }
          continue
        }
        if (declaration.type === 'function_declaration') {
          const name = declaration.childForFieldName('name')?.text?.trim()
          const params = declaration.childForFieldName('parameters')
          const body = declaration.childForFieldName('body')
          const isAsync = /\basync\b/.test(getNodeText(args.sourceText, declaration))
          if (name && body && params) {
            functions.push(
              buildFunctionIR({
                bodyText: getBodyText(args.sourceText, body),
                decorators: nodeDecorators(args.sourceText, declaration),
                endNode: body,
                exported: true,
                isAsync,
                kind: 'function',
                moduleId: args.moduleId,
                name,
                originPath: args.relativePath,
                paramsText: renderParamListText(args.sourceText, params),
                returnType: declaration.childForFieldName('return_type')?.text?.trim(),
                sourceText: args.sourceText,
                startNode: declaration,
                ownerClassName: undefined,
              }),
            )
          }
          continue
        }
        if (declaration.type === 'lexical_declaration') {
          for (const declarator of declaration.namedChildren) {
            if (declarator.type !== 'variable_declarator') {
              continue
            }
            const fn = parseTsJsFunctionFromVariable(
              args.sourceText,
              args.moduleId,
              args.relativePath,
              lineStarts,
              declarator,
              true,
            )
            if (fn) {
              functions.push(fn)
            }
          }
          continue
        }
      }
      continue
    }

    if (child.type === 'class_declaration') {
      const parsed = parseTsJsClass(
        args.sourceText,
        args.moduleId,
        args.relativePath,
        lineStarts,
        child,
        false,
      )
      if (parsed) {
        classes.push(parsed)
      }
      continue
    }

    if (child.type === 'function_declaration') {
      const name = child.childForFieldName('name')?.text?.trim()
      const params = child.childForFieldName('parameters')
      const body = child.childForFieldName('body')
      if (!name || !params || !body) {
        continue
      }

      functions.push(
        buildFunctionIR({
          bodyText: getBodyText(args.sourceText, body),
          decorators: nodeDecorators(args.sourceText, child),
          endNode: body,
          exported: false,
          isAsync: /\basync\b/.test(getNodeText(args.sourceText, child)),
          kind: 'function',
          moduleId: args.moduleId,
          name,
          originPath: args.relativePath,
          paramsText: renderParamListText(args.sourceText, params),
          returnType: child.childForFieldName('return_type')?.text?.trim(),
          sourceText: args.sourceText,
          startNode: child,
          ownerClassName: undefined,
        }),
      )
      continue
    }

    if (child.type === 'lexical_declaration') {
      for (const declarator of child.namedChildren) {
        if (declarator.type !== 'variable_declarator') {
          continue
        }
        const fn = parseTsJsFunctionFromVariable(
          args.sourceText,
          args.moduleId,
          args.relativePath,
          lineStarts,
          declarator,
          false,
        )
        if (fn) {
          functions.push(fn)
        }
      }
      continue
    }
  }

  // Merge in heuristic enrichment for TypeScript/JavaScript files.
  const heuristic = parseTypeScriptLikeModule({
    config: {
      rootDir: '',
      outputDir: '',
      outputDirName: '',
      maxFileBytes: args.sourceText.length,
      parseWorkers: 1,
      ignoredDirNames: new Set<string>(),
      sourceStrategyKinds: new Set<string>(),
    },
    file: {
      absolutePath: args.filePath,
      relativePath: args.relativePath,
      language: args.language === 'javascript' ? 'javascript' : 'typescript',
    },
    source: {
      text: args.sourceText,
      byteSize: args.sourceText.length,
      truncated: false,
    },
  })

  const classMap = new Map(classes.map(cls => [cls.qualifiedName, cls]))
  for (const heuristicClass of heuristic.classes) {
    const target = classMap.get(heuristicClass.qualifiedName)
    if (!target) {
      continue
    }
    target.bases = dedupeStrings([...target.bases, ...heuristicClass.bases])
    target.dependsOn = dedupeStrings([
      ...target.dependsOn,
      ...heuristicClass.dependsOn,
    ])
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
      method.decorators = dedupeStrings([
        ...method.decorators,
        ...heuristicMethod.decorators,
      ])
      method.isAsync = method.isAsync || heuristicMethod.isAsync
      method.exported = method.exported || heuristicMethod.exported
    }
  }

  const functionMap = new Map(functions.map(fn => [fn.qualifiedName, fn]))
  for (const heuristicFunction of heuristic.functions) {
    const fn = functionMap.get(heuristicFunction.qualifiedName)
    if (!fn) {
      functions.push(heuristicFunction)
      continue
    }
    fn.params = fn.params.length > 0 ? fn.params : heuristicFunction.params
    fn.returns = fn.returns ?? heuristicFunction.returns
    fn.calls = dedupeStrings([...fn.calls, ...heuristicFunction.calls])
    fn.awaits = dedupeStrings([...fn.awaits, ...heuristicFunction.awaits])
    fn.raises = dedupeStrings([...fn.raises, ...heuristicFunction.raises])
    fn.decorators = dedupeStrings([...fn.decorators, ...heuristicFunction.decorators])
    fn.isAsync = fn.isAsync || heuristicFunction.isAsync
    fn.exported = fn.exported || heuristicFunction.exported
  }

  const result = {
    classes: dedupeByQualifiedName(classes),
    errors: dedupeStrings([...errors, ...heuristic.errors]),
    exportNames: dedupeStrings([
      ...exports,
      ...heuristic.exports,
      ...classes.filter(cls => cls.exported).map(cls => cls.name),
      ...functions.filter(fn => fn.exported).map(fn => fn.name),
    ]),
    importStubs: dedupeStrings([...stubs, ...heuristic.importStubs]),
    imports: dedupeStrings([...imports, ...heuristic.imports]),
    functions: dedupeByQualifiedName(functions),
    notes: dedupeStrings([...heuristic.notes]),
    language: args.language,
  }
  structureCache.set(key, result)
  return result
}

function parsePythonFunctionFromNode(args: {
  lineStarts: readonly number[]
  moduleId: string
  name: string
  node: SyntaxNode
  originPath: string
  sourceText: string
  decorators: string[]
  exported: boolean
  ownerClassName?: string
  isMethod: boolean
}): FunctionIR {
  const paramsNode = args.node.childForFieldName('parameters')
  const bodyNode = args.node.childForFieldName('body')
  const returnType = args.node.childForFieldName('return_type')?.text?.trim()
  return {
    kind: args.isMethod ? 'method' : 'function',
    name: args.name,
    qualifiedName: args.ownerClassName
      ? `${args.moduleId}::${args.ownerClassName}.${args.name}`
      : `${args.moduleId}::${args.name}`,
    params: parseParametersFromSignature(renderParamListText(args.sourceText, paramsNode)),
    returns: returnType ? cleanTypeReference(returnType) : undefined,
    decorators: dedupeStrings(args.decorators),
    calls: extractCallTargets(getBodyText(args.sourceText, bodyNode)),
    awaits: extractAwaitTargets(getBodyText(args.sourceText, bodyNode)),
    raises: extractRaisedTargets(getBodyText(args.sourceText, bodyNode)),
    isAsync: /\basync\b/.test(getNodeText(args.sourceText, args.node)),
    isPublic: !args.name.startsWith('_'),
    exported: args.exported,
    sourceLines: lineRangeFromOffsets(
      args.lineStarts,
      args.node.startIndex,
      bodyNode?.endIndex ?? args.node.endIndex,
    ),
    originPath: args.originPath,
  }
}

function parsePythonClass(
  sourceText: string,
  moduleId: string,
  originPath: string,
  lineStarts: readonly number[],
  node: SyntaxNode,
  exported: boolean,
): ClassIR | null {
  const name = node.childForFieldName('name')?.text?.trim()
  const body = node.childForFieldName('body')
  if (!name || !body) {
    return null
  }

  const superclasses = node.childForFieldName('superclasses')
  const bases = superclasses
    ? splitTopLevel(getNodeText(sourceText, superclasses).slice(1, -1), ',').map(base =>
        cleanTypeReference(base),
      )
    : []

  const methods: FunctionIR[] = []
  for (const child of body.namedChildren) {
    if (child.type === 'function_definition') {
      const childName = child.childForFieldName('name')?.text?.trim()
      if (!childName) {
        continue
      }
      methods.push(
        parsePythonFunctionFromNode({
          lineStarts,
          moduleId,
          name: childName,
          node: child,
          originPath,
          sourceText,
          decorators: [],
          exported: false,
          ownerClassName: name,
          isMethod: true,
        }),
      )
      continue
    }
    if (child.type === 'decorated_definition') {
      const definition = child.childForFieldName('definition')
      const childName = definition?.childForFieldName('name')?.text?.trim()
      if (!definition || !childName) {
        continue
      }
      if (definition.type === 'function_definition') {
        methods.push(
          parsePythonFunctionFromNode({
            lineStarts,
            moduleId,
            name: childName,
            node: definition,
            originPath,
            sourceText,
            decorators: child.namedChildren
              .filter(inner => inner.type === 'decorator')
              .map(inner => normalizeWhitespace(getNodeText(sourceText, inner).slice(1))),
            exported: false,
            ownerClassName: name,
            isMethod: true,
          }),
        )
      }
    }
  }

  const constructor = methods.find(method => method.name === '__init__')
  const dependsOn = constructor
    ? dedupeStrings(constructor.params.map(param => dependencyLabelForParam(param)))
    : []

  return buildClassIR({
    bases,
    dependsOn,
    exported,
    lineStarts,
    methods,
    moduleId,
    name,
    originPath,
    sourceText,
    startNode: node,
    endNode: body,
  })
}

function parsePythonModuleAst(args: {
  filePath: string
  moduleId: string
  relativePath: string
  sourceText: string
}): AstModuleResult {
  const key = `python:${args.filePath}:${args.sourceText.length}:${args.sourceText.slice(0, 32)}`
  const cached = structureCache.get(key)
  if (cached) {
    return cached
  }

  const parser = loadParser('python')
  const tree = parser.parse(args.sourceText)
  const root = tree.rootNode as SyntaxNode
  const lineStarts = computeLineStarts(args.sourceText)
  const classes: ClassIR[] = []
  const functions: FunctionIR[] = []
  const imports: string[] = []
  const stubs: string[] = []
  const exports: string[] = []

  for (const child of root.namedChildren) {
    if (child.type === 'import_statement') {
      const names = child.childrenForFieldName('name')
      const dotted = names.map(name => stripQuotes(getNodeText(args.sourceText, name))).filter(Boolean)
      imports.push(...dotted)
      stubs.push(...dotted.map(name => `import ${name}`))
      continue
    }

    if (child.type === 'import_from_statement') {
      const moduleName = stripQuotes(getChildText(args.sourceText, child, 'module_name'))
      if (!moduleName) {
        continue
      }
      const names = child.childrenForFieldName('name')
      const importedNames = names.map(name => stripQuotes(getNodeText(args.sourceText, name))).filter(Boolean)
      imports.push(moduleName)
      if (importedNames.length > 0) {
        stubs.push(`from ${moduleName} import ${importedNames.join(', ')}`)
      }
      if (child.namedChildren.some(inner => inner.type === 'wildcard_import')) {
        stubs.push(`from ${moduleName} import *`)
      }
      continue
    }

    if (child.type === 'class_definition') {
      const parsed = parsePythonClass(
        args.sourceText,
        args.moduleId,
        args.relativePath,
        lineStarts,
        child,
        !getNodeText(args.sourceText, child).trim().startsWith('class _'),
      )
      if (parsed) {
        classes.push(parsed)
      }
      continue
    }

    if (child.type === 'decorated_definition') {
      const definition = child.childForFieldName('definition')
      if (!definition) {
        continue
      }
      if (definition.type === 'class_definition') {
        const parsed = parsePythonClass(
          args.sourceText,
          args.moduleId,
          args.relativePath,
          lineStarts,
          definition,
          true,
        )
        if (parsed) {
          classes.push(parsed)
        }
        continue
      }
      if (definition.type === 'function_definition') {
        const name = definition.childForFieldName('name')?.text?.trim()
        if (!name) {
          continue
        }
        const decorators = child.namedChildren
          .filter(inner => inner.type === 'decorator')
          .map(inner => normalizeWhitespace(getNodeText(args.sourceText, inner).slice(1)))
        functions.push(
          parsePythonFunctionFromNode({
            lineStarts,
            moduleId: args.moduleId,
            name,
            node: definition,
            originPath: args.relativePath,
            sourceText: args.sourceText,
            decorators,
            exported: !name.startsWith('_'),
            isMethod: false,
          }),
        )
        continue
      }
    }

    if (child.type === 'function_definition') {
      const name = child.childForFieldName('name')?.text?.trim()
      if (!name) {
        continue
      }
      functions.push(
        parsePythonFunctionFromNode({
          lineStarts,
          moduleId: args.moduleId,
          name,
          node: child,
          originPath: args.relativePath,
          sourceText: args.sourceText,
          decorators: [],
          exported: !name.startsWith('_'),
          isMethod: false,
        }),
      )
      continue
    }
  }

  exports.push(
    ...dedupeStrings([
      ...classes.map(cls => cls.exported ? cls.name : '').filter(Boolean),
      ...functions.map(fn => fn.exported ? fn.name : '').filter(Boolean),
    ]),
  )

  const result = {
    classes: dedupeByQualifiedName(classes),
    errors: [],
    exportNames: exports,
    importStubs: dedupeStrings(stubs),
    imports: dedupeStrings(imports),
    functions: dedupeByQualifiedName(functions),
    notes: [],
    language: 'python',
  }
  structureCache.set(key, result)
  return result
}

function parseGoParameterList(sourceText: string, node: SyntaxNode | null | undefined): ParamIR[] {
  if (!node) {
    return []
  }
  const result: ParamIR[] = []
  for (const child of node.namedChildren) {
    if (child.type !== 'parameter_declaration' && child.type !== 'variadic_parameter_declaration') {
      continue
    }
    const nameNodes = child.childrenForFieldName('name')
    const names = nameNodes.map(name => name.text.trim()).filter(Boolean)
    const type = cleanTypeReference(getChildText(sourceText, child, 'type'))
    if (names.length === 0) {
      result.push({
        name: `arg${result.length + 1}`,
        annotation: type,
      })
      continue
    }
    for (const name of names) {
      result.push({
        name,
        annotation: type,
      })
    }
  }
  return result
}

function parseGoImportSpecs(sourceText: string, node: SyntaxNode): { imports: string[]; stubs: string[] } {
  const imports: string[] = []
  const stubs: string[] = []
  for (const spec of node.descendantsOfType('import_spec')) {
    const pathNode = spec.childForFieldName('path')
    const path = stripQuotes(getNodeText(sourceText, pathNode))
    if (!path) {
      continue
    }
    imports.push(path)
    const alias = spec.childForFieldName('name')?.text?.trim()
    if (alias) {
      stubs.push(`import ${path} as ${safePythonIdentifier(alias, 'pkg')}`)
    } else {
      stubs.push(`import ${path}`)
    }
  }
  return { imports: dedupeStrings(imports), stubs: dedupeStrings(stubs) }
}

function parseGoFunctionLike(
  sourceText: string,
  moduleId: string,
  originPath: string,
  lineStarts: readonly number[],
  node: SyntaxNode,
  ownerClassName?: string,
): FunctionIR | null {
  const nameNode = node.childForFieldName('name')
  const name = nameNode?.text?.trim()
  const parametersNode = node.childForFieldName('parameters')
  const bodyNode = node.childForFieldName('body')
  if (!name || !parametersNode) {
    return null
  }
  const params = parseGoParameterList(sourceText, parametersNode)
  const resultNode = node.childForFieldName('result')
  const returnType = resultNode ? cleanTypeReference(getNodeText(sourceText, resultNode)) : undefined
  const receiverNode = node.childForFieldName('receiver')
  const receiverParams = parseGoParameterList(sourceText, receiverNode)
  const className =
    ownerClassName ??
    (receiverParams[0]?.annotation
      ? receiverParams[0].annotation.replace(/^\*+/, '').replace(/\[.*\]$/, '')
      : undefined)
  const kind = className ? 'method' : 'function'
  const finalParams =
    className && receiverParams.length > 0 ? params : params

  return {
    kind,
    name,
    qualifiedName: className
      ? `${moduleId}::${className}.${name}`
      : `${moduleId}::${name}`,
    params: finalParams,
    returns: returnType,
    decorators: [],
    calls: extractCallTargets(getBodyText(sourceText, bodyNode)),
    awaits: [],
    raises: [],
    isAsync: false,
    isPublic: !name.startsWith('_'),
    exported: true,
    sourceLines: lineRangeFromOffsets(
      lineStarts,
      node.startIndex,
      bodyNode?.endIndex ?? node.endIndex,
    ),
    originPath,
  }
}

function parseGoModuleAst(args: {
  filePath: string
  moduleId: string
  sourceText: string
  relativePath: string
}): AstModuleResult {
  const key = `go:${args.filePath}:${args.sourceText.length}:${args.sourceText.slice(0, 32)}`
  const cached = structureCache.get(key)
  if (cached) {
    return cached
  }

  const parser = loadParser('go')
  const tree = parser.parse(args.sourceText)
  const root = tree.rootNode as SyntaxNode
  const lineStarts = computeLineStarts(args.sourceText)
  const imports: string[] = []
  const stubs: string[] = []
  const classes = new Map<string, ClassIR>()
  const functions: FunctionIR[] = []
  const exportNames: string[] = []

  for (const child of root.namedChildren) {
    if (child.type === 'package_clause') {
      continue
    }

    if (child.type === 'import_declaration') {
      const parsed = parseGoImportSpecs(args.sourceText, child)
      imports.push(...parsed.imports)
      stubs.push(...parsed.stubs)
      continue
    }

    if (child.type === 'type_declaration') {
      for (const typeSpec of child.namedChildren) {
        if (typeSpec.type !== 'type_spec') {
          continue
        }
        const name = typeSpec.childForFieldName('name')?.text?.trim()
        const typeNode = typeSpec.childForFieldName('type')
        if (!name || !typeNode) {
          continue
        }
        const body = typeNode.childForFieldName('body') ?? typeNode.namedChildren.find(n =>
          ['field_declaration_list', 'struct_type', 'interface_type', 'type_identifier'].includes(n.type),
        )
        const classIR = classes.get(name) ?? buildClassIR({
          bases: [],
          dependsOn: [],
          exported: true,
          lineStarts,
          methods: [],
          moduleId: args.moduleId,
          name,
          originPath: args.relativePath,
          sourceText: args.sourceText,
          startNode: typeSpec,
          endNode: body ?? typeSpec,
        })
        classes.set(name, classIR)
      }
      continue
    }

    if (child.type === 'function_declaration') {
      const fn = parseGoFunctionLike(
        args.sourceText,
        args.moduleId,
        args.relativePath,
        lineStarts,
        child,
      )
      if (fn) {
        functions.push(fn)
      }
      continue
    }

    if (child.type === 'method_declaration') {
      const receiverNode = child.childForFieldName('receiver')
      const receiverParams = parseGoParameterList(args.sourceText, receiverNode)
      const receiverType = receiverParams[0]?.annotation?.replace(/^\*+/, '').trim()
      const fn = parseGoFunctionLike(
        args.sourceText,
        args.moduleId,
        args.relativePath,
        lineStarts,
        child,
        receiverType,
      )
      if (!fn) {
        continue
      }
      const className = receiverType ?? 'Receiver'
      const classIR =
        classes.get(className) ??
        buildClassIR({
          bases: [],
          dependsOn: [],
          exported: true,
          lineStarts,
          methods: [],
          moduleId: args.moduleId,
          name: className,
          originPath: args.relativePath,
          sourceText: args.sourceText,
          startNode: child,
          endNode: child,
        })
      classIR.methods.push(fn)
      classes.set(className, classIR)
      continue
    }
  }

  const classList = [...classes.values()]
  const result = {
    classes: dedupeByQualifiedName(classList),
    errors: [],
    exportNames: dedupeStrings([
      ...exportNames,
      ...classList.map(cls => cls.name),
      ...functions.map(fn => fn.name),
    ]),
    importStubs: stubs,
    imports,
    functions,
    notes: [],
    language: 'go',
  }
  structureCache.set(key, result)
  return result
}

function parseRustParameters(sourceText: string, node: SyntaxNode | null | undefined): ParamIR[] {
  if (!node) {
    return []
  }

  const parameters: ParamIR[] = []
  for (const child of node.namedChildren) {
    if (child.type === 'self_parameter') {
      continue
    }
    if (child.type !== 'parameter') {
      continue
    }
    const pattern = child.childForFieldName('pattern')?.text?.trim()
    const type = cleanTypeReference(getChildText(sourceText, child, 'type'))
    if (!pattern) {
      continue
    }
    parameters.push({
      name: safePythonIdentifier(pattern, `arg${parameters.length + 1}`),
      annotation: type,
    })
  }
  return parameters
}

function parseRustFunctionLike(
  sourceText: string,
  moduleId: string,
  originPath: string,
  lineStarts: readonly number[],
  node: SyntaxNode,
  ownerClassName?: string,
): FunctionIR | null {
  const name = node.childForFieldName('name')?.text?.trim()
  const parameters = node.childForFieldName('parameters')
  const body = node.childForFieldName('body')
  if (!name || !parameters) {
    return null
  }
  const returnType = node.childForFieldName('return_type')?.text?.trim()
  const params = parseRustParameters(sourceText, parameters)
  return {
    kind: ownerClassName ? 'method' : 'function',
    name,
    qualifiedName: ownerClassName
      ? `${moduleId}::${ownerClassName}.${name}`
      : `${moduleId}::${name}`,
    params,
    returns: returnType ? cleanTypeReference(returnType) : undefined,
    decorators: [],
    calls: extractCallTargets(getBodyText(sourceText, body)),
    awaits: [],
    raises: [],
    isAsync: false,
    isPublic: true,
    exported: true,
    sourceLines: lineRangeFromOffsets(lineStarts, node.startIndex, body?.endIndex ?? node.endIndex),
    originPath,
  }
}

function parseRustModuleAst(args: {
  filePath: string
  moduleId: string
  sourceText: string
  relativePath: string
}): AstModuleResult {
  const key = `rust:${args.filePath}:${args.sourceText.length}:${args.sourceText.slice(0, 32)}`
  const cached = structureCache.get(key)
  if (cached) {
    return cached
  }

  const parser = loadParser('rust')
  const tree = parser.parse(args.sourceText)
  const root = tree.rootNode as SyntaxNode
  const lineStarts = computeLineStarts(args.sourceText)
  const imports: string[] = []
  const stubs: string[] = []
  const classes = new Map<string, ClassIR>()
  const functions: FunctionIR[] = []

  for (const child of root.namedChildren) {
    if (child.type === 'use_declaration') {
      const spec = normalizeWhitespace(getNodeText(args.sourceText, child))
      imports.push(spec)
      stubs.push(`${spec.endsWith(';') ? spec : `${spec};`}`)
      continue
    }

    if (child.type === 'struct_item' || child.type === 'enum_item' || child.type === 'trait_item' || child.type === 'type_item') {
      const name = child.childForFieldName('name')?.text?.trim()
      if (!name) {
        continue
      }
      const body = child.childForFieldName('body')
      const classIR = buildClassIR({
        bases: [],
        dependsOn: [],
        exported: true,
        lineStarts,
        methods: [],
        moduleId: args.moduleId,
        name,
        originPath: args.relativePath,
        sourceText: args.sourceText,
        startNode: child,
        endNode: body ?? child,
      })
      classes.set(name, classIR)
      if (child.type === 'trait_item' && body) {
        for (const decl of body.namedChildren) {
          if (decl.type !== 'function_item') {
            continue
          }
          const fn = parseRustFunctionLike(args.sourceText, args.moduleId, args.relativePath, lineStarts, decl, name)
          if (fn) {
            classIR.methods.push(fn)
          }
        }
      }
      continue
    }

    if (child.type === 'impl_item') {
      const targetType = child.childForFieldName('type')?.text?.trim()
      const body = child.childForFieldName('body')
      if (!targetType || !body) {
        continue
      }
      const className = cleanTypeReference(targetType)
      const classIR =
        classes.get(className) ??
        buildClassIR({
          bases: [],
          dependsOn: [],
          exported: true,
          lineStarts,
          methods: [],
          moduleId: args.moduleId,
          name: className,
          originPath: args.relativePath,
          sourceText: args.sourceText,
          startNode: child,
          endNode: child,
        })
      for (const decl of body.namedChildren) {
        if (decl.type !== 'function_item') {
          continue
        }
        const fn = parseRustFunctionLike(args.sourceText, args.moduleId, args.relativePath, lineStarts, decl, className)
        if (fn) {
          classIR.methods.push(fn)
        }
      }
      classes.set(className, classIR)
      continue
    }

    if (child.type === 'function_item') {
      const fn = parseRustFunctionLike(args.sourceText, args.moduleId, args.relativePath, lineStarts, child)
      if (fn) {
        functions.push(fn)
      }
      continue
    }
  }

  const classList = [...classes.values()]
  const result = {
    classes: dedupeByQualifiedName(classList),
    errors: [],
    exportNames: dedupeStrings([
      ...classList.map(cls => cls.name),
      ...functions.map(fn => fn.name),
    ]),
    importStubs: stubs,
    imports,
    functions,
    notes: [],
    language: 'rust',
  }
  structureCache.set(key, result)
  return result
}

function parseJavaParameters(sourceText: string, node: SyntaxNode | null | undefined): ParamIR[] {
  if (!node) {
    return []
  }
  const params: ParamIR[] = []
  for (const child of node.namedChildren) {
    if (child.type !== 'formal_parameter' && child.type !== 'receiver_parameter' && child.type !== 'spread_parameter') {
      continue
    }
    const name = child.childForFieldName('name')?.text?.trim()
    const type = cleanTypeReference(
      child.childForFieldName('type')?.text?.trim() ??
        child.children.find(grand => grand.type === 'type')?.text?.trim() ??
        '',
    )
    if (!name) {
      continue
    }
    params.push({
      name: safePythonIdentifier(name, `arg${params.length + 1}`),
      annotation: type || undefined,
    })
  }
  return params
}

function parseJavaFunctionLike(
  sourceText: string,
  moduleId: string,
  originPath: string,
  lineStarts: readonly number[],
  node: SyntaxNode,
  ownerClassName?: string,
): FunctionIR | null {
  const name = node.childForFieldName('name')?.text?.trim()
  const parameters = node.childForFieldName('parameters')
  const body = node.childForFieldName('body')
  if (!name || !parameters) {
    return null
  }
  const returnType = node.childForFieldName('type')?.text?.trim()
  const params = parseJavaParameters(sourceText, parameters)
  return {
    kind: ownerClassName ? 'method' : 'function',
    name,
    qualifiedName: ownerClassName
      ? `${moduleId}::${ownerClassName}.${name}`
      : `${moduleId}::${name}`,
    params,
    returns: returnType ? cleanTypeReference(returnType) : undefined,
    decorators: [],
    calls: extractCallTargets(getBodyText(sourceText, body)),
    awaits: [],
    raises: [],
    isAsync: false,
    isPublic: true,
    exported: true,
    sourceLines: lineRangeFromOffsets(lineStarts, node.startIndex, body?.endIndex ?? node.endIndex),
    originPath,
  }
}

function parseJavaModuleAst(args: {
  filePath: string
  moduleId: string
  sourceText: string
  relativePath: string
}): AstModuleResult {
  const key = `java:${args.filePath}:${args.sourceText.length}:${args.sourceText.slice(0, 32)}`
  const cached = structureCache.get(key)
  if (cached) {
    return cached
  }

  const parser = loadParser('java')
  const tree = parser.parse(args.sourceText)
  const root = tree.rootNode as SyntaxNode
  const lineStarts = computeLineStarts(args.sourceText)
  const imports: string[] = []
  const stubs: string[] = []
  const classes = new Map<string, ClassIR>()
  const functions: FunctionIR[] = []

  for (const child of root.namedChildren) {
    if (child.type === 'package_declaration') {
      continue
    }
    if (child.type === 'import_declaration') {
      const specifier = getNodeText(args.sourceText, child).replace(/^import\s+/, '').replace(/;$/, '').trim()
      if (specifier) {
        imports.push(specifier)
        stubs.push(`import ${specifier}`)
      }
      continue
    }
    if (child.type === 'class_declaration' || child.type === 'interface_declaration' || child.type === 'enum_declaration') {
      const name = child.childForFieldName('name')?.text?.trim()
      const body = child.childForFieldName('body')
      if (!name || !body) {
        continue
      }
      const superclass = child.childForFieldName('superclass')?.text?.replace(/^extends\s+/, '').trim()
      const interfaces = child.childForFieldName('interfaces')?.text?.replace(/^implements\s+/, '').trim()
      const bases = dedupeStrings(
        [
          superclass,
          interfaces,
        ]
          .filter(Boolean)
          .flatMap(value => splitTopLevel(value as string, ',').map(part => cleanTypeReference(part))),
      )

      const methods: FunctionIR[] = []
      for (const member of body.namedChildren) {
        if (member.type === 'method_declaration') {
          const fn = parseJavaFunctionLike(
            args.sourceText,
            args.moduleId,
            args.relativePath,
            lineStarts,
            member,
            name,
          )
          if (fn) {
            methods.push(fn)
          }
          continue
        }
        if (member.type === 'constructor_declaration' || member.type === 'compact_constructor_declaration') {
          const fn = parseJavaFunctionLike(
            args.sourceText,
            args.moduleId,
            args.relativePath,
            lineStarts,
            member,
            name,
          )
          if (fn) {
            fn.name = 'constructor'
            fn.returns = 'None'
            methods.push(fn)
          }
        }
      }

      classes.set(name, buildClassIR({
        bases,
        dependsOn: [],
        exported: true,
        lineStarts,
        methods,
        moduleId: args.moduleId,
        name,
        originPath: args.relativePath,
        sourceText: args.sourceText,
        startNode: child,
        endNode: body,
      }))
      continue
    }
    if (child.type === 'method_declaration') {
      const fn = parseJavaFunctionLike(args.sourceText, args.moduleId, args.relativePath, lineStarts, child)
      if (fn) {
        functions.push(fn)
      }
    }
  }

  const classList = [...classes.values()]
  const result = {
    classes: dedupeByQualifiedName(classList),
    errors: [],
    exportNames: dedupeStrings([
      ...classList.map(cls => cls.name),
      ...functions.map(fn => fn.name),
    ]),
    importStubs: stubs,
    imports,
    functions,
    notes: [],
    language: 'java',
  }
  structureCache.set(key, result)
  return result
}

function parseHaxeParameters(sourceText: string, node: SyntaxNode | null | undefined): ParamIR[] {
  if (!node) {
    return []
  }

  const params: ParamIR[] = []
  for (const child of node.namedChildren) {
    if (child.type !== 'function_arg') {
      continue
    }
    const rawText = normalizeWhitespace(getNodeText(sourceText, child))
    if (!rawText) {
      continue
    }
    const name = child.childForFieldName('name')?.text?.trim()
    const typeNode = child.childForFieldName('type')
    const annotation =
      typeNode?.text?.trim() ??
      rawText.split(':').slice(1).join(':').trim() ??
      undefined
    params.push({
      name: safePythonIdentifier(
        name ?? rawText.split(':')[0] ?? `arg${params.length + 1}`,
        `arg${params.length + 1}`,
      ),
      annotation: annotation ? cleanTypeReference(annotation) : undefined,
    })
  }

  if (params.length > 0) {
    return params
  }

  return []
}

function parseHaxeFunctionLike(
  sourceText: string,
  moduleId: string,
  originPath: string,
  lineStarts: readonly number[],
  node: SyntaxNode,
  ownerClassName?: string,
): FunctionIR | null {
  const name = node.childForFieldName('name')?.text?.trim()
  const body = node.childForFieldName('body')
  const returnType =
    node.childForFieldName('return_type')?.text?.trim() ??
    node.childForFieldName('type')?.text?.trim()
  if (!name) {
    return null
  }

  return {
    kind: ownerClassName ? 'method' : 'function',
    name,
    qualifiedName: ownerClassName
      ? `${moduleId}::${ownerClassName}.${name}`
      : `${moduleId}::${name}`,
    params: parseHaxeParameters(sourceText, node),
    returns: returnType ? cleanTypeReference(returnType) : undefined,
    decorators: [],
    calls: extractCallTargets(getBodyText(sourceText, body)),
    awaits: [],
    raises: [],
    isAsync: /\basync\b/.test(getNodeText(sourceText, node)),
    isPublic: !name.startsWith('_'),
    exported: true,
    sourceLines: lineRangeFromOffsets(lineStarts, node.startIndex, body?.endIndex ?? node.endIndex),
    originPath,
  }
}

function parseHaxeModuleAst(args: {
  filePath: string
  moduleId: string
  relativePath: string
  sourceText: string
}): AstModuleResult {
  const key = `haxe:${args.filePath}:${args.sourceText.length}:${args.sourceText.slice(0, 32)}`
  const cached = structureCache.get(key)
  if (cached) {
    return cached
  }

  const parser = loadParser('haxe')
  const tree = parser.parse(args.sourceText)
  const root = tree.rootNode as SyntaxNode
  const lineStarts = computeLineStarts(args.sourceText)
  const imports: string[] = []
  const stubs: string[] = []
  const classes = new Map<string, ClassIR>()
  const functions: FunctionIR[] = []

  for (const child of root.namedChildren) {
    if (child.type === 'package_statement') {
      continue
    }
    if (child.type === 'import_statement') {
      const spec = normalizeWhitespace(getNodeText(args.sourceText, child))
        .replace(/^import\s+/, '')
        .replace(/;$/, '')
        .trim()
      if (spec) {
        imports.push(spec)
        stubs.push(`import ${spec}`)
      }
      continue
    }
    if (child.type === 'class_declaration' || child.type === 'interface_declaration' || child.type === 'typedef_declaration') {
      const name = child.childForFieldName('name')?.text?.trim()
      const body = child.childForFieldName('body')
      if (!name || !body) {
        continue
      }
      const methods: FunctionIR[] = []
      for (const member of body.namedChildren) {
        if (member.type === 'function_declaration') {
          const fn = parseHaxeFunctionLike(args.sourceText, args.moduleId, args.relativePath, lineStarts, member, name)
          if (fn) {
            methods.push(fn)
          }
          continue
        }
        if (member.type === 'class_declaration' || member.type === 'interface_declaration') {
          const nested = parseHaxeClass(
            args.sourceText,
            args.moduleId,
            args.relativePath,
            lineStarts,
            member,
          )
          if (nested) {
            classes.set(nested.name, nested)
          }
        }
      }
      classes.set(name, buildClassIR({
        bases: [],
        dependsOn: [],
        exported: true,
        lineStarts,
        methods,
        moduleId: args.moduleId,
        name,
        originPath: args.relativePath,
        sourceText: args.sourceText,
        startNode: child,
        endNode: body,
      }))
      continue
    }

    if (child.type === 'function_declaration') {
      const fn = parseHaxeFunctionLike(args.sourceText, args.moduleId, args.relativePath, lineStarts, child)
      if (fn) {
        functions.push(fn)
      }
    }
  }

  const classList = [...classes.values()]
  const result = {
    classes: dedupeByQualifiedName(classList),
    errors: [],
    exportNames: dedupeStrings([
      ...classList.map(cls => cls.name),
      ...functions.map(fn => fn.name),
    ]),
    importStubs: stubs,
    imports,
    functions,
    notes: [],
    language: 'haxe',
  }
  structureCache.set(key, result)
  return result
}

function parseHaxeClass(
  sourceText: string,
  moduleId: string,
  originPath: string,
  lineStarts: readonly number[],
  node: SyntaxNode,
): ClassIR | null {
  const name = node.childForFieldName('name')?.text?.trim()
  const body = node.childForFieldName('body')
  if (!name || !body) {
    return null
  }
  const methods: FunctionIR[] = []
  for (const member of body.namedChildren) {
    if (member.type === 'function_declaration') {
      const fn = parseHaxeFunctionLike(sourceText, moduleId, originPath, lineStarts, member, name)
      if (fn) {
        methods.push(fn)
      }
    }
  }
  return buildClassIR({
    bases: [],
    dependsOn: [],
    exported: true,
    lineStarts,
    methods,
    moduleId,
    name,
    originPath,
    sourceText,
    startNode: node,
    endNode: body,
  })
}

function parseCOrCppParameters(sourceText: string, node: SyntaxNode | null | undefined): ParamIR[] {
  if (!node) {
    return []
  }
  const text = getNodeText(sourceText, node)
  const inner = text.slice(1, -1).trim()
  if (!inner) {
    return []
  }
  if (inner === 'void') {
    return []
  }
  return splitTopLevel(inner, ',').map((part, index) => {
    const normalized = normalizeWhitespace(part)
    const declaratorMatch = normalized.match(
      /^(.*?)([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?$/,
    )
    const name = declaratorMatch?.[2] ? safePythonIdentifier(declaratorMatch[2], `arg${index + 1}`) : `arg${index + 1}`
    const annotation = cleanTypeReference(
      declaratorMatch?.[1] ? declaratorMatch[1].trim() : normalized,
    )
    return {
      name,
      annotation: annotation || undefined,
    }
  })
}

function extractCOrCppFunctionNameInfo(
  sourceText: string,
  node: SyntaxNode | null | undefined,
): { owner?: string; name?: string } {
  if (!node) {
    return {}
  }

  const nestedDeclarator =
    node.childForFieldName('declarator') ??
    node.namedChildren.find(child =>
      child.type === 'function_declarator' ||
      child.type === 'pointer_declarator' ||
      child.type === 'reference_declarator' ||
      child.type === 'parenthesized_declarator' ||
      child.type === 'qualified_identifier' ||
      child.type === 'identifier' ||
      child.type === 'field_identifier' ||
      child.type === 'type_identifier' ||
      child.type === 'destructor_name' ||
      child.type === 'operator_name' ||
      child.type === 'operator_cast' ||
      child.type === 'template_function' ||
      child.type === 'template_method' ||
      child.type === 'template_type',
    )

  if (nestedDeclarator && nestedDeclarator !== node) {
    const nestedInfo = extractCOrCppFunctionNameInfo(sourceText, nestedDeclarator)
    if (nestedInfo.name) {
      return nestedInfo
    }
  }

  const text = normalizeWhitespace(getNodeText(sourceText, node))
  if (!text) {
    return {}
  }

  let owner: string | undefined
  let name = text
  if (text.includes('::')) {
    const parts = text.split('::').map(part => part.trim()).filter(Boolean)
    name = parts.pop() ?? text
    owner = parts.length > 0 ? parts.join('::') : undefined
  }

  name = normalizeWhitespace(name).replace(/\s*\([^()]*\)\s*$/, '').trim()
  if (!name) {
    return {}
  }

  return {
    owner,
    name,
  }
}

function parseCOrCppFunctionFromDeclarator(args: {
  bodyNode?: SyntaxNode | null
  declaratorNode: SyntaxNode | null | undefined
  lineStarts: readonly number[]
  moduleId: string
  originPath: string
  ownerClassName?: string
  returnTypeText?: string
  sourceText: string
}): FunctionIR | null {
  const declaratorNode = args.declaratorNode
  if (!declaratorNode) {
    return null
  }

  const { owner, name } = extractCOrCppFunctionNameInfo(args.sourceText, declaratorNode)
  if (!name) {
    return null
  }

  const parametersNode =
    declaratorNode.childForFieldName('parameters') ??
    declaratorNode.descendantsOfType('parameter_list')[0] ??
    null
  const qualifiedOwner =
    args.ownerClassName ?? owner?.replace(/::/g, '.')
  const bodyText = getBodyText(args.sourceText, args.bodyNode)

  return {
    kind: args.ownerClassName ? 'method' : 'function',
    name,
    qualifiedName: qualifiedOwner
      ? `${args.moduleId}::${qualifiedOwner}.${name}`
      : `${args.moduleId}::${name}`,
    params: parseCOrCppParameters(args.sourceText, parametersNode),
    returns: args.returnTypeText ? cleanTypeReference(args.returnTypeText) : undefined,
    decorators: [],
    calls: extractCallTargets(bodyText),
    awaits: [],
    raises: [],
    isAsync: false,
    isPublic: true,
    exported: true,
    sourceLines: lineRangeFromOffsets(
      args.lineStarts,
      declaratorNode.startIndex,
      args.bodyNode?.endIndex ?? declaratorNode.endIndex,
    ),
    originPath: args.originPath,
  }
}

function parseCFunctionLike(
  sourceText: string,
  moduleId: string,
  originPath: string,
  lineStarts: readonly number[],
  node: SyntaxNode,
  ownerClassName?: string,
): FunctionIR | null {
  const declarator = node.childForFieldName('declarator')
  const body = node.childForFieldName('body')
  const typeNode = node.childForFieldName('type')
  if (!declarator || !typeNode) {
    return null
  }
  return parseCOrCppFunctionFromDeclarator({
    bodyNode: body,
    declaratorNode: declarator,
    lineStarts,
    moduleId,
    originPath,
    ownerClassName,
    returnTypeText: typeNode.text.trim(),
    sourceText,
  })
}

function parseCOrCppClass(
  sourceText: string,
  moduleId: string,
  originPath: string,
  lineStarts: readonly number[],
  node: SyntaxNode,
): ClassIR | null {
  const name = node.childForFieldName('name')?.text?.trim()
  const body = node.childForFieldName('body')
  if (!name || !body) {
    return null
  }
  const bases = node.namedChildren
    .filter(child => child.type === 'base_class_clause')
    .map(child => cleanTypeReference(normalizeWhitespace(getNodeText(sourceText, child)).replace(/^:\s*/, '').replace(/^public\s+|^private\s+|^protected\s+/, '')))
  const methods: FunctionIR[] = []
  for (const member of body.namedChildren) {
    if (member.type === 'field_declaration' || member.type === 'function_definition') {
      const declarators = member.childrenForFieldName('declarator')
      for (const declarator of declarators) {
        const fn = parseCOrCppFunctionFromDeclarator({
          bodyNode: member.type === 'function_definition' ? member.childForFieldName('body') : null,
          declaratorNode: declarator,
          lineStarts,
          moduleId,
          originPath,
          ownerClassName: name,
          returnTypeText: getChildText(sourceText, member, 'type'),
          sourceText,
        })
        if (fn) {
          methods.push(fn)
        }
      }
    }
  }
  return buildClassIR({
    bases,
    dependsOn: [],
    exported: true,
    lineStarts,
    methods,
    moduleId,
    name,
    originPath,
    sourceText,
    startNode: node,
    endNode: body,
  })
}

function parseCppModuleAst(args: {
  filePath: string
  moduleId: string
  relativePath: string
  sourceText: string
  language: 'c' | 'cpp'
}): AstModuleResult {
  const key = `${args.language}:${args.filePath}:${args.sourceText.length}:${args.sourceText.slice(0, 32)}`
  const cached = structureCache.get(key)
  if (cached) {
    return cached
  }

  const parser = loadParser(args.language)
  const tree = parser.parse(args.sourceText)
  const root = tree.rootNode as SyntaxNode
  const lineStarts = computeLineStarts(args.sourceText)
  const imports: string[] = []
  const stubs: string[] = []
  const classes = new Map<string, ClassIR>()
  const functions: FunctionIR[] = []

  for (const child of root.namedChildren) {
    if (child.type === 'preproc_include') {
      const pathNode = child.childForFieldName('path')
      const pathText = stripQuotes(getNodeText(args.sourceText, pathNode))
      if (pathText) {
        imports.push(pathText)
        stubs.push(`#include ${pathText}`)
      }
      continue
    }
    if (child.type === 'namespace_definition') {
      const body = child.childForFieldName('body')
      if (body) {
        for (const member of body.namedChildren) {
          if (member.type === 'class_specifier' || member.type === 'struct_specifier' || member.type === 'enum_specifier') {
            const classIR = parseCOrCppClass(args.sourceText, args.moduleId, args.relativePath, lineStarts, member)
            if (classIR) {
              classes.set(classIR.name, classIR)
            }
          }
          if (member.type === 'function_definition') {
            const fn = parseCFunctionLike(args.sourceText, args.moduleId, args.relativePath, lineStarts, member)
            if (fn) {
              functions.push(fn)
            }
          }
        }
      }
      continue
    }
    if (child.type === 'class_specifier' || child.type === 'struct_specifier' || child.type === 'enum_specifier') {
      const classIR = parseCOrCppClass(args.sourceText, args.moduleId, args.relativePath, lineStarts, child)
      if (classIR) {
        classes.set(classIR.name, classIR)
      }
      continue
    }
    if (child.type === 'function_definition') {
      const fn = parseCFunctionLike(args.sourceText, args.moduleId, args.relativePath, lineStarts, child)
      if (fn) {
        functions.push(fn)
      }
    }
  }

  const classList = [...classes.values()]
  const result = {
    classes: dedupeByQualifiedName(classList),
    errors: [],
    exportNames: dedupeStrings([
      ...classList.map(cls => cls.name),
      ...functions.map(fn => fn.name),
    ]),
    importStubs: stubs,
    imports,
    functions,
    notes: [],
    language: args.language,
  }
  structureCache.set(key, result)
  return result
}

function parseZigFunctionLike(
  sourceText: string,
  moduleId: string,
  originPath: string,
  lineStarts: readonly number[],
  node: SyntaxNode,
  ownerClassName?: string,
): FunctionIR | null {
  const name = node.childForFieldName('name')?.text?.trim()
  const parameters =
    node.namedChildren.find(child => child.type === 'parameters')
  const body = node.childForFieldName('body')
  const returnType = node.childForFieldName('type')?.text?.trim()
  if (!name || !parameters) {
    return null
  }
  return {
    kind: ownerClassName ? 'method' : 'function',
    name,
    qualifiedName: ownerClassName
      ? `${moduleId}::${ownerClassName}.${name}`
      : `${moduleId}::${name}`,
    params: parseParametersFromSignature(getNodeText(sourceText, parameters).slice(1, -1)),
    returns: returnType ? cleanTypeReference(returnType) : undefined,
    decorators: [],
    calls: extractCallTargets(getBodyText(sourceText, body)),
    awaits: [],
    raises: [],
    isAsync: false,
    isPublic: true,
    exported: true,
    sourceLines: lineRangeFromOffsets(lineStarts, node.startIndex, body?.endIndex ?? node.endIndex),
    originPath,
  }
}

function parseZigModuleAst(args: {
  filePath: string
  moduleId: string
  relativePath: string
  sourceText: string
}): AstModuleResult {
  const key = `zig:${args.filePath}:${args.sourceText.length}:${args.sourceText.slice(0, 32)}`
  const cached = structureCache.get(key)
  if (cached) {
    return cached
  }

  const parser = loadParser('zig')
  const tree = parser.parse(args.sourceText)
  const root = tree.rootNode as SyntaxNode
  const lineStarts = computeLineStarts(args.sourceText)
  const imports: string[] = []
  const stubs: string[] = []
  const classes = new Map<string, ClassIR>()
  const functions: FunctionIR[] = []

  for (const child of root.namedChildren) {
    if (child.type === 'variable_declaration') {
      const declarationText = normalizeWhitespace(getNodeText(args.sourceText, child))
      const importMatch = declarationText.match(
        /^(?:pub\s+)?const\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*@import\((.+)\);?$/,
      )
      if (importMatch?.[1]) {
        const spec = stripQuotes(importMatch[1])
        if (spec) {
          imports.push(spec)
          stubs.push(`import ${spec}`)
        }
        continue
      }
    }

    if (child.type === 'using_namespace_declaration') {
      const spec = normalizeWhitespace(getNodeText(args.sourceText, child)).replace(/;$/, '')
      if (spec) {
        imports.push(spec)
        stubs.push(spec.endsWith(';') ? spec : `${spec};`)
      }
      continue
    }

    if (child.type === 'function_declaration') {
      const fn = parseZigFunctionLike(args.sourceText, args.moduleId, args.relativePath, lineStarts, child)
      if (fn) {
        functions.push(fn)
      }
      continue
    }

    if (child.type === 'variable_declaration') {
      const name = child.childForFieldName('name')?.text?.trim() ?? child.namedChildren.find(n => n.type === 'identifier')?.text?.trim()
      const structDecl = child.namedChildren.find(n =>
        ['struct_declaration', 'enum_declaration'].includes(n.type),
      )
      if (name && structDecl) {
        const methods: FunctionIR[] = []
        for (const member of structDecl.namedChildren) {
          if (member.type === 'function_declaration') {
            const fn = parseZigFunctionLike(
              args.sourceText,
              args.moduleId,
              args.relativePath,
              lineStarts,
              member,
              name,
            )
            if (fn) {
              methods.push(fn)
            }
          }
        }
        classes.set(
          name,
          buildClassIR({
            bases: [],
            dependsOn: [],
            exported: true,
            lineStarts,
            methods,
            moduleId: args.moduleId,
            name,
            originPath: args.relativePath,
            sourceText: args.sourceText,
            startNode: child,
            endNode: structDecl,
          }),
        )
      }
      continue
    }

    if (child.type === 'struct_declaration' || child.type === 'enum_declaration') {
      const name = child.childForFieldName('name')?.text?.trim()
      if (!name) {
        continue
      }
      const methods: FunctionIR[] = []
      for (const member of child.namedChildren) {
        if (member.type === 'function_declaration') {
          const fn = parseZigFunctionLike(args.sourceText, args.moduleId, args.relativePath, lineStarts, member, name)
          if (fn) {
            methods.push(fn)
          }
        }
      }
      classes.set(
        name,
        buildClassIR({
          bases: [],
          dependsOn: [],
          exported: true,
          lineStarts,
          methods,
          moduleId: args.moduleId,
          name,
          originPath: args.relativePath,
          sourceText: args.sourceText,
          startNode: child,
          endNode: child.childForFieldName('body') ?? child,
        }),
      )
    }
  }

  const classList = [...classes.values()]
  const result = {
    classes: dedupeByQualifiedName(classList),
    errors: [],
    exportNames: dedupeStrings([
      ...classList.map(cls => cls.name),
      ...functions.map(fn => fn.name),
    ]),
    importStubs: stubs,
    imports,
    functions,
    notes: [],
  }
  structureCache.set(key, result)
  return result
}

function splitOcamlTopLevelArrows(typeText: string): string[] {
  const parts: string[] = []
  let current = ''
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let angleDepth = 0
  let quote: "'" | '"' | null = null
  let escaping = false

  for (let index = 0; index < typeText.length; index++) {
    const char = typeText[index] ?? ''
    const next = typeText[index + 1] ?? ''

    if (quote) {
      current += char
      if (escaping) {
        escaping = false
        continue
      }
      if (char === '\\') {
        escaping = true
        continue
      }
      if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }

    if (char === '(') {
      parenDepth++
      current += char
      continue
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
      current += char
      continue
    }
    if (char === '[') {
      bracketDepth++
      current += char
      continue
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
      current += char
      continue
    }
    if (char === '{') {
      braceDepth++
      current += char
      continue
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
      current += char
      continue
    }
    if (char === '<') {
      angleDepth++
      current += char
      continue
    }
    if (char === '>') {
      if (angleDepth > 0) {
        angleDepth--
      }
      current += char
      continue
    }

    if (
      char === '-' &&
      next === '>' &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      angleDepth === 0
    ) {
      parts.push(current.trim())
      current = ''
      index++
      continue
    }

    current += char
  }

  if (current.trim()) {
    parts.push(current.trim())
  }

  return parts
}

function parseOcamlArrowParameter(
  part: string,
  index: number,
): ParamIR {
  const normalized = normalizeWhitespace(part)
  if (!normalized) {
    return {
      name: `arg${index + 1}`,
    }
  }

  let value = normalized
  if (value.startsWith('(') && value.endsWith(')')) {
    value = value.slice(1, -1).trim()
  }

  if (value.startsWith('~') || value.startsWith('?')) {
    value = value.slice(1).trim()
  }

  const colonIndex = value.indexOf(':')
  if (colonIndex >= 0) {
    const name = value.slice(0, colonIndex).trim()
    const annotation = cleanTypeReference(value.slice(colonIndex + 1))
    return {
      name: safePythonIdentifier(name || `arg${index + 1}`, `arg${index + 1}`),
      annotation: annotation || undefined,
    }
  }

  return {
    name: `arg${index + 1}`,
    annotation: cleanTypeReference(value) || undefined,
  }
}

function parseOcamlFunctionSignature(
  typeText: string,
): { params: ParamIR[]; returns?: string } {
  const normalized = normalizeWhitespace(typeText)
  if (!normalized) {
    return { params: [] }
  }

  const parts = splitOcamlTopLevelArrows(normalized)
  if (parts.length === 0) {
    return { params: [] }
  }

  if (parts.length === 1) {
    return { params: [], returns: cleanTypeReference(parts[0] ?? '') || undefined }
  }

  const params = parts.slice(0, -1).map((part, index) => parseOcamlArrowParameter(part, index))
  const returns = cleanTypeReference(parts[parts.length - 1] ?? '') || undefined
  return { params, returns }
}

function parseOcamlParameterNode(
  sourceText: string,
  node: SyntaxNode,
  index: number,
): ParamIR {
  const rawText = normalizeWhitespace(getNodeText(sourceText, node))
  if (!rawText) {
    return {
      name: `arg${index + 1}`,
    }
  }

  if (rawText.startsWith('(') && rawText.endsWith(')') && rawText.includes(':')) {
    const inner = rawText.slice(1, -1)
    const colonIndex = inner.indexOf(':')
    const name = inner.slice(0, colonIndex).trim()
    const annotation = cleanTypeReference(inner.slice(colonIndex + 1))
    return {
      name: safePythonIdentifier(name || `arg${index + 1}`, `arg${index + 1}`),
      annotation: annotation || undefined,
    }
  }

  if (rawText.startsWith('~') || rawText.startsWith('?')) {
    const inner = rawText.slice(1).trim()
    const colonIndex = inner.indexOf(':')
    const name = colonIndex >= 0 ? inner.slice(0, colonIndex).trim() : inner
    const annotation =
      colonIndex >= 0 ? cleanTypeReference(inner.slice(colonIndex + 1)) : undefined
    return {
      name: safePythonIdentifier(name || `arg${index + 1}`, `arg${index + 1}`),
      annotation: annotation || undefined,
    }
  }

  if (/^[A-Za-z_][A-Za-z0-9_']*$/.test(rawText)) {
    return {
      name: safePythonIdentifier(rawText, `arg${index + 1}`),
    }
  }

  return {
    name: `arg${index + 1}`,
    annotation: cleanTypeReference(rawText) || undefined,
  }
}

function ocamlNodeHasDescendantType(
  node: SyntaxNode | null | undefined,
  types: readonly string[],
): boolean {
  if (!node) {
    return false
  }
  if (types.includes(node.type)) {
    return true
  }
  for (const child of node.namedChildren) {
    if (ocamlNodeHasDescendantType(child, types)) {
      return true
    }
  }
  return false
}

function ocamlNodeTextForTypes(
  sourceText: string,
  node: SyntaxNode | null | undefined,
  types: readonly string[],
): string {
  if (!node) {
    return ''
  }
  if (types.includes(node.type)) {
    return normalizeWhitespace(getNodeText(sourceText, node))
  }
  for (const child of node.namedChildren) {
    const text = ocamlNodeTextForTypes(sourceText, child, types)
    if (text) {
      return text
    }
  }
  return ''
}

function ocamlModuleReferenceText(
  sourceText: string,
  node: SyntaxNode | null | undefined,
): string {
  return ocamlNodeTextForTypes(sourceText, node, [
    'extended_module_path',
    'module_name',
    'module_path',
    'module_type_name',
    'module_type_path',
  ])
}

function parseOcamlFunctionLike(
  sourceText: string,
  moduleId: string,
  originPath: string,
  lineStarts: readonly number[],
  node: SyntaxNode,
  args: {
    bodyNode?: SyntaxNode | null
    exported: boolean
    ownerClassName?: string
    paramsNodeTypes?: readonly string[]
  },
): FunctionIR | null {
  const name = node.childForFieldName('name')?.text?.trim()
  if (!name) {
    return null
  }

  const params: ParamIR[] = []
  const paramsNodeTypes = args.paramsNodeTypes ?? ['parameter']
  let parameterIndex = 0
  for (const child of node.namedChildren) {
    if (!paramsNodeTypes.includes(child.type)) {
      continue
    }
    params.push(parseOcamlParameterNode(sourceText, child, parameterIndex))
    parameterIndex++
  }

  const bodyNode = args.bodyNode ?? node.childForFieldName('body') ?? node.namedChildren.at(-1) ?? null
  const bodyText = bodyNode ? getNodeText(sourceText, bodyNode) : ''
  const isAsync = /\basync\b/.test(getNodeText(sourceText, node))

  return {
    kind: args.ownerClassName ? 'method' : 'function',
    name,
    qualifiedName: args.ownerClassName
      ? `${moduleId}::${args.ownerClassName}.${name}`
      : `${moduleId}::${name}`,
    params,
    returns: undefined,
    decorators: [],
    calls: extractCallTargets(bodyText),
    awaits: extractAwaitTargets(bodyText),
    raises: extractRaisedTargets(bodyText),
    isAsync,
    isPublic: !name.startsWith('_'),
    exported: args.exported,
    sourceLines: lineRangeFromOffsets(
      lineStarts,
      node.startIndex,
      bodyNode?.endIndex ?? node.endIndex,
    ),
    originPath,
  }
}

function ocamlQualifiedClassName(
  moduleId: string,
  scopePath: readonly string[],
  name: string,
): string {
  const prefix = scopePath.length > 0 ? `${scopePath.join('.')}.` : ''
  return `${moduleId}::${prefix}${name}`
}

function ocamlQualifiedFunctionName(
  moduleId: string,
  scopePath: readonly string[],
  name: string,
): string {
  const prefix = scopePath.length > 0 ? `${scopePath.join('.')}.` : ''
  return `${moduleId}::${prefix}${name}`
}

function parseOcamlClassMethods(args: {
  bodyNode: SyntaxNode | null | undefined
  moduleId: string
  originPath: string
  scopePath: readonly string[]
  sourceText: string
  lineStarts: readonly number[]
  className: string
  exported: boolean
}): { bases: string[]; methods: FunctionIR[] } {
  const methods: FunctionIR[] = []
  const bases: string[] = []
  const body = args.bodyNode
  if (!body) {
    return { bases, methods }
  }

  for (const child of body.namedChildren) {
    if (child.type === 'method_definition') {
      const fn = parseOcamlFunctionLike(
        args.sourceText,
        args.moduleId,
        args.originPath,
        args.lineStarts,
        child,
        {
          bodyNode: child.childForFieldName('body'),
          exported: args.exported,
          ownerClassName: args.scopePath.length > 0
            ? `${args.scopePath.join('.')}.${args.className}`
            : args.className,
        },
      )
      if (fn) {
        methods.push(fn)
      }
      continue
    }

    if (child.type === 'method_specification') {
      const nameNode =
        child.childForFieldName('name') ??
        child.namedChildren.find(inner => inner.type === 'method_name')
      const name = nameNode ? normalizeWhitespace(getNodeText(args.sourceText, nameNode)) : ''
      if (!name) {
        continue
      }
      const signatureNode = child.namedChildren.find(inner =>
        inner.type === 'function_type' ||
        inner.type === 'type_constructor_path' ||
        inner.type === 'type_variable' ||
        inner.type === 'generic_type' ||
        inner.type === '_type',
      )
      const signature = signatureNode ? getNodeText(args.sourceText, signatureNode) : ''
      const parsed = parseOcamlFunctionSignature(signature)
      methods.push({
        kind: 'method',
        name,
        qualifiedName: `${ocamlQualifiedClassName(args.moduleId, args.scopePath, args.className)}.${name}`,
        params: parsed.params,
        returns: parsed.returns,
        decorators: [],
        calls: [],
        awaits: [],
        raises: [],
        isAsync: false,
        isPublic: !name.startsWith('_'),
        exported: args.exported,
        sourceLines: lineRangeFromOffsets(
          args.lineStarts,
          child.startIndex,
          signatureNode?.endIndex ?? child.endIndex,
        ),
        originPath: args.originPath,
      })
      continue
    }

    if (child.type === 'inheritance_definition' || child.type === 'inheritance_specification') {
      const inherited = normalizeWhitespace(getNodeText(args.sourceText, child))
        .replace(/^inherit\s+/, '')
        .replace(/^:\s*/, '')
        .trim()
      if (inherited) {
        bases.push(inherited)
      }
    }
  }

  return {
    bases: dedupeStrings(bases),
    methods,
  }
}

function parseOcamlTypeDefinition(args: {
  bodyNode: SyntaxNode | null | undefined
  exported: boolean
  lineStarts: readonly number[]
  moduleId: string
  originPath: string
  startNode: SyntaxNode
  scopePath: readonly string[]
  sourceText: string
  typeName: string
}): ClassIR {
  const bases: string[] = []
  const dependsOn: string[] = []
  const body = args.bodyNode

  return buildClassIR({
    bases,
    dependsOn,
    exported: args.exported,
    lineStarts: args.lineStarts,
    methods: [],
    moduleId: args.moduleId,
    name: args.typeName,
    originPath: args.originPath,
    sourceText: args.sourceText,
    startNode: args.startNode,
    endNode: body ?? args.bodyNode ?? args.startNode,
    qualifiedNamePrefix: args.scopePath.length > 0 ? `${args.scopePath.join('.')}.` : '',
  })
}

function parseOcamlAstModule(args: {
  filePath: string
  moduleId: string
  relativePath: string
  sourceText: string
  language: 'ocaml' | 'ocaml_interface'
}): AstModuleResult {
  const key = `${args.language}:${args.filePath}:${args.sourceText.length}:${args.sourceText.slice(0, 32)}`
  const cached = structureCache.get(key)
  if (cached) {
    return cached
  }

  const parser = loadParser(args.language)
  const tree = parser.parse(args.sourceText)
  const root = tree.rootNode as SyntaxNode
  const lineStarts = computeLineStarts(args.sourceText)
  const classes: ClassIR[] = []
  const functions: FunctionIR[] = []
  const imports: string[] = []
  const stubs: string[] = []
  const errors: string[] = []
  const notes: string[] = []
  const exports: string[] = []

  function visit(node: SyntaxNode, scopePath: readonly string[]): void {
    switch (node.type) {
      case 'open_module':
      case 'include_module': {
        const modulePathNode = node.childForFieldName('module') ?? node.namedChildren.find(child => child.type === 'module_path')
        const modulePath = modulePathNode ? normalizeWhitespace(getNodeText(args.sourceText, modulePathNode)) : ''
        if (modulePath) {
          imports.push(modulePath)
          stubs.push(`${node.type === 'include_module' ? 'include' : 'open'} ${modulePath}`)
        }
        return
      }
      case 'include_module_type': {
        const moduleReference = ocamlModuleReferenceText(args.sourceText, node)
        if (moduleReference) {
          imports.push(moduleReference)
        }
        const stub = normalizeWhitespace(getNodeText(args.sourceText, node))
        if (stub) {
          stubs.push(stub)
        }
        return
      }
      case 'value_definition': {
        for (const child of node.namedChildren) {
          if (child.type !== 'let_binding') {
            continue
          }
          const nameNode =
            child.childForFieldName('pattern')?.descendantsOfType('value_name')[0] ??
            child.namedChildren.find(inner =>
              inner.type === 'value_name' || inner.type === 'parenthesized_operator',
            )
          const name = nameNode ? normalizeWhitespace(getNodeText(args.sourceText, nameNode)) : ''
          if (!name) {
            continue
          }
          const params: ParamIR[] = []
          const bodyNode = child.childForFieldName('body') ?? child.namedChildren.at(-1) ?? null
          let bodyExpression = bodyNode
          let childIndex = 0
          for (const bindingChild of child.namedChildren) {
            if (bindingChild === nameNode) {
              continue
            }
            if (bindingChild.type !== 'parameter') {
              continue
            }
            params.push(parseOcamlParameterNode(args.sourceText, bindingChild, childIndex))
            childIndex++
          }

          if (bodyExpression?.type === 'fun_expression') {
            const nestedParams: ParamIR[] = []
            let nestedIndex = 0
            for (const lambdaChild of bodyExpression.namedChildren) {
              if (lambdaChild.type !== 'parameter') {
                continue
              }
              nestedParams.push(parseOcamlParameterNode(args.sourceText, lambdaChild, nestedIndex))
              nestedIndex++
            }
            params.push(...nestedParams)
            bodyExpression = bodyExpression.childForFieldName('body') ?? bodyExpression.namedChildren.at(-1) ?? bodyExpression
          }

          const isCallable =
            params.length > 0 ||
            ocamlNodeHasDescendantType(bodyExpression, [
              'fun_expression',
              'function_expression',
            ])
          if (!isCallable) {
            continue
          }

          const fn = {
            kind: 'function' as const,
            name,
            qualifiedName: ocamlQualifiedFunctionName(args.moduleId, scopePath, name),
            params,
            returns: undefined,
            decorators: [],
            calls: extractCallTargets(bodyExpression ? getNodeText(args.sourceText, bodyExpression) : ''),
            awaits: extractAwaitTargets(bodyExpression ? getNodeText(args.sourceText, bodyExpression) : ''),
            raises: extractRaisedTargets(bodyExpression ? getNodeText(args.sourceText, bodyExpression) : ''),
            isAsync: /\basync\b/.test(getNodeText(args.sourceText, child)),
            isPublic: !name.startsWith('_'),
            exported: true,
            sourceLines: lineRangeFromOffsets(
              lineStarts,
              child.startIndex,
              bodyExpression?.endIndex ?? child.endIndex,
            ),
            originPath: args.relativePath,
          } satisfies FunctionIR
          functions.push(fn)
        }
        return
      }
      case 'class_type_definition': {
        const classTypeBinding = node.namedChildren.find(child => child.type === 'class_type_binding')
        if (!classTypeBinding) {
          return
        }
        const nameNode =
          classTypeBinding.childForFieldName('name') ??
          classTypeBinding.namedChildren.find(child => child.type === 'class_type_name')
        const className = nameNode ? normalizeWhitespace(getNodeText(args.sourceText, nameNode)) : ''
        if (!className) {
          return
        }
        const bodyNode = classTypeBinding.childForFieldName('body') ?? classTypeBinding.namedChildren.find(child =>
          child.type === 'class_body_type' ||
          child.type === '_simple_class_type' ||
          child.type === 'object_expression',
        )
        const parsedClass = parseOcamlClassMethods({
          bodyNode,
          className,
          exported: true,
          lineStarts,
          moduleId: args.moduleId,
          originPath: args.relativePath,
          scopePath,
          sourceText: args.sourceText,
        })
        classes.push(
          buildClassIR({
            bases: parsedClass.bases,
            dependsOn: [],
            exported: true,
            lineStarts,
            methods: parsedClass.methods,
            moduleId: args.moduleId,
            name: className,
            originPath: args.relativePath,
            sourceText: args.sourceText,
            startNode: classTypeBinding,
            endNode: bodyNode ?? classTypeBinding,
            qualifiedNamePrefix: scopePath.length > 0 ? `${scopePath.join('.')}.` : '',
          }),
        )
        return
      }
      case 'value_specification': {
        const nameNode = node.childForFieldName('name') ?? node.namedChildren.find(child => child.type === 'value_name' || child.type === 'parenthesized_operator')
        const name = nameNode ? normalizeWhitespace(getNodeText(args.sourceText, nameNode)) : ''
        if (!name) {
          return
        }
        const typeNode = node.namedChildren.find(child =>
          child.type === 'function_type' ||
          child.type === 'type_constructor_path' ||
          child.type === 'type_variable' ||
          child.type === 'tuple_type' ||
          child.type === 'constrained_type' ||
          child.type === 'polymorphic_variant_type',
        ) ?? node.namedChildren.at(-1) ?? null
        const signatureText = typeNode ? getNodeText(args.sourceText, typeNode) : ''
        const parsed = parseOcamlFunctionSignature(signatureText)
        functions.push({
          kind: 'function',
          name,
          qualifiedName: ocamlQualifiedFunctionName(args.moduleId, scopePath, name),
          params: parsed.params,
          returns: parsed.returns,
          decorators: [],
          calls: [],
          awaits: [],
          raises: [],
          isAsync: false,
          isPublic: !name.startsWith('_'),
          exported: true,
          sourceLines: lineRangeFromOffsets(lineStarts, node.startIndex, node.endIndex),
          originPath: args.relativePath,
        })
        return
      }
      case 'class_definition': {
        const classBinding = node.namedChildren.find(child => child.type === 'class_binding')
        if (!classBinding) {
          return
        }
        const nameNode = classBinding.childForFieldName('name') ?? classBinding.namedChildren.find(child => child.type === 'class_name')
        const className = nameNode ? normalizeWhitespace(getNodeText(args.sourceText, nameNode)) : ''
        if (!className) {
          return
        }
        const bodyNode = classBinding.childForFieldName('body') ?? classBinding.namedChildren.find(child =>
          child.type === 'object_expression' || child.type === 'class_body_type',
        )
        const parsedClass = parseOcamlClassMethods({
          bodyNode,
          className,
          exported: true,
          lineStarts,
          moduleId: args.moduleId,
          originPath: args.relativePath,
          scopePath,
          sourceText: args.sourceText,
        })
        classes.push(
          buildClassIR({
            bases: parsedClass.bases,
            dependsOn: [],
            exported: true,
            lineStarts,
            methods: parsedClass.methods,
            moduleId: args.moduleId,
            name: className,
            originPath: args.relativePath,
            sourceText: args.sourceText,
            startNode: classBinding,
            endNode: bodyNode ?? classBinding,
            qualifiedNamePrefix: scopePath.length > 0 ? `${scopePath.join('.')}.` : '',
          }),
        )
        return
      }
      case 'type_definition': {
        for (const typeBinding of node.namedChildren) {
          if (typeBinding.type !== 'type_binding') {
            continue
          }
          const nameNode = typeBinding.childForFieldName('name') ?? typeBinding.namedChildren.find(child =>
            child.type === 'type_constructor' || child.type === 'type_constructor_path',
          )
          const typeName = nameNode ? normalizeWhitespace(getNodeText(args.sourceText, nameNode)) : ''
          if (!typeName) {
            continue
          }
          const bodyNode = typeBinding.childForFieldName('body') ?? typeBinding.namedChildren.find(child =>
            child.type === 'record_declaration' || child.type === 'variant_declaration',
          )
          classes.push(
            parseOcamlTypeDefinition({
              bodyNode,
              exported: true,
              lineStarts,
              moduleId: args.moduleId,
              originPath: args.relativePath,
              startNode: typeBinding,
              scopePath,
              sourceText: args.sourceText,
              typeName,
            }),
          )
        }
        return
      }
      case 'exception_definition': {
        const constructorNode = node.namedChildren.find(child => child.type === 'constructor_declaration')
        const nameNode = constructorNode?.childForFieldName('name') ?? constructorNode?.namedChildren.find(child => child.type === 'constructor_name')
        const exceptionName = nameNode ? normalizeWhitespace(getNodeText(args.sourceText, nameNode)) : ''
        if (!exceptionName) {
          return
        }
        classes.push(
          buildClassIR({
            bases: [],
            dependsOn: [],
            exported: true,
            lineStarts,
            methods: [],
            moduleId: args.moduleId,
            name: exceptionName,
            originPath: args.relativePath,
            sourceText: args.sourceText,
            startNode: constructorNode ?? node,
            endNode: constructorNode ?? node,
            qualifiedNamePrefix: scopePath.length > 0 ? `${scopePath.join('.')}.` : '',
          }),
        )
        return
      }
      case 'module_definition': {
        const moduleBinding = node.namedChildren.find(child => child.type === 'module_binding')
        if (!moduleBinding) {
          return
        }
        const nameNode = moduleBinding.childForFieldName('name') ?? moduleBinding.namedChildren.find(child => child.type === 'module_name')
        const moduleName = nameNode ? normalizeWhitespace(getNodeText(args.sourceText, nameNode)) : ''
        if (!moduleName) {
          return
        }
        const bodyNode = moduleBinding.childForFieldName('body') ?? moduleBinding.namedChildren.find(child =>
          child.type === 'structure' ||
          child.type === 'signature' ||
          child.type === 'module_path',
        )
        if (!bodyNode) {
          return
        }
        if (bodyNode.type === 'module_path') {
          const modulePath = normalizeWhitespace(getNodeText(args.sourceText, bodyNode))
          if (modulePath) {
            imports.push(modulePath)
            stubs.push(`module ${moduleName} = ${modulePath}`)
          }
          return
        }

        visit(bodyNode, [...scopePath, moduleName])
        return
      }
      case 'structure':
      case 'signature': {
        for (const child of node.namedChildren) {
          visit(child, scopePath)
        }
        return
      }
      case 'module_type_definition': {
        const nameNode = node.childForFieldName('name') ?? node.namedChildren.find(child => child.type === 'module_type_name')
        const moduleTypeName = nameNode ? normalizeWhitespace(getNodeText(args.sourceText, nameNode)) : ''
        if (moduleTypeName) {
          notes.push(`module type ${scopePath.length > 0 ? `${scopePath.join('.')}.` : ''}${moduleTypeName}`)
        }
        const bodyNode =
          node.childForFieldName('body') ??
          node.namedChildren.find(child =>
            child.type === 'signature' ||
            child.type === 'module_type_of' ||
            child.type === 'module_type_path' ||
            child.type === 'parenthesized_module_type',
          )
        if (!bodyNode) {
          return
        }
        if (bodyNode.type === 'signature') {
          visit(bodyNode, [...scopePath, moduleTypeName].filter(Boolean))
          return
        }
        const moduleReference = ocamlModuleReferenceText(args.sourceText, bodyNode)
        if (moduleReference) {
          imports.push(moduleReference)
          stubs.push(`module type ${moduleTypeName} = ${normalizeWhitespace(getNodeText(args.sourceText, bodyNode))}`)
        }
        return
      }
      default:
        for (const child of node.namedChildren) {
          if (
            child.type === 'structure' ||
            child.type === 'signature' ||
            child.type === 'module_definition' ||
            child.type === 'module_type_definition' ||
            child.type === 'value_definition' ||
            child.type === 'value_specification' ||
            child.type === 'class_definition' ||
            child.type === 'class_type_definition' ||
            child.type === 'type_definition' ||
            child.type === 'exception_definition' ||
            child.type === 'open_module' ||
            child.type === 'include_module' ||
            child.type === 'include_module_type'
          ) {
            visit(child, scopePath)
          }
        }
    }
  }

  visit(root, [])

  const result = {
    classes: dedupeByQualifiedName(classes),
    errors: dedupeStrings(errors),
    exportNames: dedupeStrings([
      ...exports,
      ...classes.filter(cls => cls.exported).map(cls => cls.name),
      ...functions.filter(fn => fn.exported).map(fn => fn.name),
    ]),
    importStubs: dedupeStrings(stubs),
    imports: dedupeStrings(imports),
    functions: dedupeByQualifiedName(functions),
    notes: dedupeStrings(notes),
    language: 'ocaml',
  }
  structureCache.set(key, result)
  return result
}

function dedupeByQualifiedName<T extends { qualifiedName: string }>(items: readonly T[]): T[] {
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

function parseGenericAstFallback(args: {
  filePath: string
  moduleId: string
  relativePath: string
  sourceText: string
}): AstModuleResult {
  const result = parseGenericModule(
    {
      config: {
        rootDir: '',
        outputDir: '',
        outputDirName: '',
        maxFileBytes: args.sourceText.length,
        parseWorkers: 1,
        ignoredDirNames: new Set<string>(),
        sourceStrategyKinds: new Set<string>(),
      },
      file: {
        absolutePath: args.filePath,
        relativePath: args.relativePath,
        language: 'generic',
      },
      source: {
        text: args.sourceText,
        byteSize: args.sourceText.length,
        truncated: false,
      },
    },
  )

  return {
    classes: result.classes,
    errors: result.errors,
    exportNames: result.exports,
    importStubs: result.importStubs,
    imports: result.imports,
    functions: result.functions,
    notes: result.notes,
    language: 'generic',
  }
}

function parseAstOnlyModule(args: {
  filePath: string
  language: ParseLanguage
  moduleId: string
  relativePath: string
  sourceText: string
}): AstModuleResult {
  switch (args.language) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
      return parseTsJsModule({
        filePath: args.filePath,
        language: args.language,
        moduleId: args.moduleId,
        relativePath: args.relativePath,
        sourceText: args.sourceText,
      })
    case 'python':
      return parsePythonModuleAst({
        filePath: args.filePath,
        moduleId: args.moduleId,
        relativePath: args.relativePath,
        sourceText: args.sourceText,
      })
    case 'ocaml':
      return parseOcamlAstModule({
        filePath: args.filePath,
        language: 'ocaml',
        moduleId: args.moduleId,
        relativePath: args.relativePath,
        sourceText: args.sourceText,
      })
    case 'ocaml_interface':
      return parseOcamlAstModule({
        filePath: args.filePath,
        language: 'ocaml_interface',
        moduleId: args.moduleId,
        relativePath: args.relativePath,
        sourceText: args.sourceText,
      })
    case 'go':
      return parseGoModuleAst({
        filePath: args.filePath,
        moduleId: args.moduleId,
        relativePath: args.relativePath,
        sourceText: args.sourceText,
      })
    case 'rust':
      return parseRustModuleAst({
        filePath: args.filePath,
        moduleId: args.moduleId,
        relativePath: args.relativePath,
        sourceText: args.sourceText,
      })
    case 'java':
      return parseJavaModuleAst({
        filePath: args.filePath,
        moduleId: args.moduleId,
        relativePath: args.relativePath,
        sourceText: args.sourceText,
      })
    case 'haxe':
      return parseHaxeModuleAst({
        filePath: args.filePath,
        moduleId: args.moduleId,
        relativePath: args.relativePath,
        sourceText: args.sourceText,
      })
    case 'c':
    case 'cpp':
      return parseCppModuleAst({
        filePath: args.filePath,
        language: args.language,
        moduleId: args.moduleId,
        relativePath: args.relativePath,
        sourceText: args.sourceText,
      })
    case 'zig':
      return parseZigModuleAst({
        filePath: args.filePath,
        moduleId: args.moduleId,
        relativePath: args.relativePath,
        sourceText: args.sourceText,
      })
    case 'saasm':
      return parseGenericAstFallback({
        filePath: args.filePath,
        moduleId: args.moduleId,
        relativePath: args.relativePath,
        sourceText: args.sourceText,
      })
    case 'generic':
      return parseGenericAstFallback({
        filePath: args.filePath,
        moduleId: args.moduleId,
        relativePath: args.relativePath,
        sourceText: args.sourceText,
      })
  }
}

function mergeModuleResults(
  astResult: AstModuleResult,
  heuristicResult: ModuleIR,
): AstModuleResult {
  const classes = astResult.classes.map(cls => ({ ...cls }))
  const functions = astResult.functions.map(fn => ({ ...fn }))
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
    classes: dedupeByQualifiedName(classes),
    errors: dedupeStrings([...astResult.errors, ...heuristicResult.errors]),
    exportNames: dedupeStrings([
      ...astResult.exportNames,
      ...heuristicResult.exports,
      ...classes.filter(cls => cls.exported).map(cls => cls.name),
      ...functions.filter(fn => fn.exported).map(fn => fn.name),
    ]),
    importStubs: dedupeStrings([...astResult.importStubs, ...heuristicResult.importStubs]),
    imports: dedupeStrings([...astResult.imports, ...heuristicResult.imports]),
    functions: dedupeByQualifiedName(functions),
    notes: dedupeStrings([...astResult.notes, ...heuristicResult.notes]),
    language: astResult.language ?? heuristicResult.language,
  }
}

export function parseAstModule(args: {
  filePath: string
  moduleId: string
  relativePath?: string
  sourceText: string
}): {
  classes: ClassIR[]
  errors: string[]
  exportNames: string[]
  importStubs: string[]
  imports: string[]
  functions: FunctionIR[]
  notes: string[]
  language: string
} | null {
  const relativePath = args.relativePath ?? args.filePath
  const language = detectAstLanguage(args.filePath, args.sourceText)
  try {
    const astResult = parseAstOnlyModule({
      filePath: args.filePath,
      language,
      moduleId: args.moduleId,
      relativePath,
      sourceText: args.sourceText,
    })

    if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
      return mergeModuleResults(
        astResult,
        parseTypeScriptLikeModule({
          config: {
            rootDir: '',
            outputDir: '',
            outputDirName: '',
            maxFileBytes: args.sourceText.length,
            parseWorkers: 1,
            ignoredDirNames: new Set<string>(),
            sourceStrategyKinds: new Set<string>(),
          },
          file: {
            absolutePath: args.filePath,
            relativePath,
            language: language === 'javascript' ? 'javascript' : 'typescript',
          },
          source: {
            text: args.sourceText,
            byteSize: args.sourceText.length,
            truncated: false,
          },
        }),
      )
    }

    if (language === 'python') {
      return mergeModuleResults(
        astResult,
        parsePythonModule({
          config: {
            rootDir: '',
            outputDir: '',
            outputDirName: '',
            maxFileBytes: args.sourceText.length,
            parseWorkers: 1,
            ignoredDirNames: new Set<string>(),
            sourceStrategyKinds: new Set<string>(),
          },
          file: {
            absolutePath: args.filePath,
            relativePath,
            language: 'python',
          },
          source: {
            text: args.sourceText,
            byteSize: args.sourceText.length,
            truncated: false,
          },
        }),
      )
    }

    return astResult
  } catch (error) {
    return null
  }
}
