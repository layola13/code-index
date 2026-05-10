import type { FunctionIR, ParamIR, SourceLineRange } from './ir.js'
import { computeLineStarts, lineRangeFromOffsets, normalizeWhitespace, parseParametersFromSignature, safePythonIdentifier, splitTopLevel } from './parserUtils.js'

export type AstNode = {
  type: string
  namedChildCount: number
  namedChildren: AstNode[]
  childForFieldName(fieldName: string): AstNode | null
  text: string
  startIndex: number
  endIndex: number
  startPosition: { row: number; column: number }
  endPosition: { row: number; column: number }
}

export type AstTree = {
  rootNode: AstNode
}

export type AstParser = {
  parse(input: string | ((index: number, position: { row: number; column: number }) => string | undefined)): AstTree | null
}

export function readNodeText(source: string, node: AstNode): string {
  return source.slice(node.startIndex, node.endIndex)
}

export function readNodeFieldText(source: string, node: AstNode, fieldName: string): string {
  const field = node.childForFieldName(fieldName)
  return field ? readNodeText(source, field) : ''
}

export function parseAstParameters(text: string): ParamIR[] {
  return parseParametersFromSignature(text)
}

export function lineRangeForNode(source: string, node: AstNode): SourceLineRange {
  const lineStarts = computeLineStarts(source)
  return lineRangeFromOffsets(lineStarts, node.startIndex, node.endIndex)
}

export function splitTopLevelParams(value: string): string[] {
  return splitTopLevel(value, ',')
}

export function cleanAstName(value: string, fallback: string): string {
  return safePythonIdentifier(normalizeWhitespace(value), fallback)
}

export function nodeTextOrEmpty(source: string, node: AstNode | null | undefined): string {
  return node ? readNodeText(source, node) : ''
}

export function functionIRFromNode(args: {
  bodyText: string
  exported: boolean
  isAsync: boolean
  kind: 'function' | 'method'
  lineStarts: number[]
  moduleId: string
  name: string
  originPath?: string
  paramsText: string
  returnType?: string
  startIndex: number
  endIndex: number
}): FunctionIR {
  return {
    kind: args.kind,
    name: args.name,
    qualifiedName: args.originPath
      ? `${args.moduleId}::${args.originPath}`
      : `${args.moduleId}::${args.name}`,
    params: parseAstParameters(args.paramsText),
    returns: args.returnType,
    decorators: [],
    calls: [],
    awaits: [],
    raises: [],
    isAsync: args.isAsync,
    isPublic: !args.name.startsWith('_'),
    exported: args.exported,
    sourceLines: lineRangeFromOffsets(args.lineStarts, args.startIndex, args.endIndex),
    originPath: args.originPath,
  }
}
