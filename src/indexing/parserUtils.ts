import type { ParamIR, SourceLineRange } from './ir.js'

const PYTHON_KEYWORDS = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
  'match',
  'case',
])

const CALL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'class',
  'typeof',
  'delete',
  'return',
  'throw',
  'new',
  'await',
  'import',
  'super',
])

type ScannerMode =
  | 'normal'
  | 'line_comment'
  | 'block_comment'
  | 'single_quote'
  | 'double_quote'
  | 'template'
  | 'template_expr'
  | 'regex'

type ScannerFrame =
  | { mode: 'normal' }
  | { mode: 'line_comment' }
  | { mode: 'block_comment' }
  | { mode: 'single_quote' }
  | { mode: 'double_quote' }
  | { mode: 'template' }
  | { mode: 'template_expr'; depth: number }
  | { mode: 'regex'; inCharacterClass: boolean }

export function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/')
}

export function relativePathToModuleId(relativePath: string): string {
  return toPosixPath(relativePath)
}

export function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    const normalized = value.trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function computeLineStarts(text: string): number[] {
  const lineStarts = [0]
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      lineStarts.push(index + 1)
    }
  }
  return lineStarts
}

export function offsetToLine(lineStarts: readonly number[], offset: number): number {
  let low = 0
  let high = lineStarts.length - 1

  while (low <= high) {
    const mid = (low + high) >> 1
    const value = lineStarts[mid] ?? 0

    if (value <= offset) {
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return high + 1
}

export function lineRangeFromOffsets(
  lineStarts: readonly number[],
  startOffset: number,
  endOffsetExclusive: number,
): SourceLineRange {
  const endOffset = Math.max(startOffset, endOffsetExclusive - 1)
  return {
    start: offsetToLine(lineStarts, startOffset),
    end: offsetToLine(lineStarts, endOffset),
  }
}

function isRegexLiteralStart(input: string, index: number): boolean {
  if (input[index] !== '/' || input[index + 1] === '/' || input[index + 1] === '*') {
    return false
  }

  let cursor = index - 1
  while (cursor >= 0 && /\s/.test(input[cursor] ?? '')) {
    cursor--
  }

  if (cursor < 0) {
    return true
  }

  const previousChar = input[cursor] ?? ''
  if ('([{=,:;!?&|+-*%^~<>'.includes(previousChar)) {
    return true
  }

  let wordEnd = cursor
  while (cursor >= 0 && /[A-Za-z_$]/.test(input[cursor] ?? '')) {
    cursor--
  }
  const previousWord = input.slice(cursor + 1, wordEnd + 1)
  return [
    'case',
    'delete',
    'in',
    'instanceof',
    'new',
    'of',
    'return',
    'throw',
    'typeof',
    'void',
    'yield',
  ].includes(previousWord)
}

function pushSameLengthWhitespace(
  out: string[],
  input: string,
  index: number,
  count: number,
): void {
  for (let offset = 0; offset < count; offset++) {
    const char = input[index + offset] ?? ''
    out.push(char === '\n' ? '\n' : ' ')
  }
}

export function sanitizeForStructure(input: string): string {
  const out: string[] = []
  const stack: ScannerFrame[] = [{ mode: 'normal' }]
  let index = 0

  while (index < input.length) {
    const current = stack[stack.length - 1] ?? { mode: 'normal' as ScannerMode }
    const char = input[index] ?? ''
    const next = input[index + 1] ?? ''

    switch (current.mode) {
      case 'normal':
      case 'template_expr':
        if (char === '/' && next === '/') {
          stack.push({ mode: 'line_comment' })
          out.push(' ', ' ')
          index += 2
          continue
        }
        if (char === '/' && next === '*') {
          stack.push({ mode: 'block_comment' })
          out.push(' ', ' ')
          index += 2
          continue
        }
        if (char === "'" && current.mode !== 'regex') {
          stack.push({ mode: 'single_quote' })
          out.push("'")
          index++
          continue
        }
        if (char === '"') {
          stack.push({ mode: 'double_quote' })
          out.push('"')
          index++
          continue
        }
        if (char === '`') {
          stack.push({ mode: 'template' })
          out.push('`')
          index++
          continue
        }
        if (char === '/' && isRegexLiteralStart(input, index)) {
          stack.push({ mode: 'regex', inCharacterClass: false })
          out.push('/')
          index++
          continue
        }
        if (current.mode === 'template_expr') {
          if (char === '{') {
            current.depth++
          } else if (char === '}') {
            current.depth--
            if (current.depth === 0) {
              stack.pop()
            }
          }
        }
        out.push(char)
        index++
        continue

      case 'line_comment':
        if (char === '\n') {
          stack.pop()
          out.push('\n')
        } else {
          out.push(' ')
        }
        index++
        continue

      case 'block_comment':
        if (char === '*' && next === '/') {
          stack.pop()
          out.push(' ', ' ')
          index += 2
          continue
        }
        out.push(char === '\n' ? '\n' : ' ')
        index++
        continue

      case 'single_quote':
      case 'double_quote':
        if (char === '\\') {
          pushSameLengthWhitespace(out, input, index, Math.min(2, input.length - index))
          index += Math.min(2, input.length - index)
          continue
        }
        if (
          (current.mode === 'single_quote' && char === "'") ||
          (current.mode === 'double_quote' && char === '"')
        ) {
          stack.pop()
          out.push(char)
        } else {
          out.push(char === '\n' ? '\n' : ' ')
        }
        index++
        continue

      case 'template':
        if (char === '\\') {
          pushSameLengthWhitespace(out, input, index, Math.min(2, input.length - index))
          index += Math.min(2, input.length - index)
          continue
        }
        if (char === '$' && next === '{') {
          stack.push({ mode: 'template_expr', depth: 1 })
          out.push('$', '{')
          index += 2
          continue
        }
        if (char === '`') {
          stack.pop()
          out.push('`')
        } else {
          out.push(char === '\n' ? '\n' : ' ')
        }
        index++
        continue

      case 'regex':
        if (char === '\\') {
          pushSameLengthWhitespace(out, input, index, Math.min(2, input.length - index))
          index += Math.min(2, input.length - index)
          continue
        }
        if (char === '[') {
          current.inCharacterClass = true
          out.push('[')
          index++
          continue
        }
        if (char === ']' && current.inCharacterClass) {
          current.inCharacterClass = false
          out.push(']')
          index++
          continue
        }
        if (char === '/' && !current.inCharacterClass) {
          stack.pop()
          out.push('/')
          index++
          while (index < input.length && /[A-Za-z]/.test(input[index] ?? '')) {
            out.push(' ')
            index++
          }
          continue
        }
        out.push(char === '\n' ? '\n' : ' ')
        index++
        continue
    }
  }

  return out.join('')
}

export function computeBraceDepths(text: string): number[] {
  const depths = new Array<number>(text.length + 1)
  let depth = 0

  for (let index = 0; index < text.length; index++) {
    depths[index] = depth
    const char = text[index] ?? ''
    if (char === '{') {
      depth++
    } else if (char === '}') {
      depth = Math.max(0, depth - 1)
    }
  }

  depths[text.length] = depth
  return depths
}

export function findMatchingChar(
  text: string,
  openIndex: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0
  for (let index = openIndex; index < text.length; index++) {
    const char = text[index] ?? ''
    if (char === openChar) {
      depth++
      continue
    }
    if (char === closeChar) {
      depth--
      if (depth === 0) {
        return index
      }
    }
  }
  return -1
}

export function skipWhitespace(text: string, index: number): number {
  let cursor = index
  while (cursor < text.length && /\s/.test(text[cursor] ?? '')) {
    cursor++
  }
  return cursor
}

function isPotentialAngleBracket(text: string, index: number): boolean {
  const previous = text[index - 1] ?? ''
  const next = text[index + 1] ?? ''
  return /[\w)\]]/.test(previous) && /[\w([{]/.test(next)
}

function canCloseAngleBracket(text: string, index: number): boolean {
  const previous = text[index - 1] ?? ''
  const next = text[index + 1] ?? ''
  return /[\w)\]]/.test(previous) && /[\w,)\]}|&\s]/.test(next)
}

export function splitTopLevel(
  input: string,
  separator: string = ',',
): string[] {
  const parts: string[] = []
  let start = 0
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let angleDepth = 0
  let quote: "'" | '"' | '`' | null = null
  let escaping = false

  for (let index = 0; index < input.length; index++) {
    const char = input[index] ?? ''

    if (quote) {
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

    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }

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
    if (char === '<' && isPotentialAngleBracket(input, index)) {
      angleDepth++
      continue
    }
    if (char === '>' && angleDepth > 0 && canCloseAngleBracket(input, index)) {
      angleDepth--
      continue
    }

    if (
      char === separator &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      angleDepth === 0
    ) {
      parts.push(input.slice(start, index))
      start = index + 1
    }
  }

  parts.push(input.slice(start))
  return parts.map(part => part.trim()).filter(Boolean)
}

export function findTopLevelChar(
  input: string,
  candidates: readonly string[],
): number {
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let angleDepth = 0
  let quote: "'" | '"' | '`' | null = null
  let escaping = false

  for (let index = 0; index < input.length; index++) {
    const char = input[index] ?? ''

    if (quote) {
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

    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }

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
    if (char === '<' && isPotentialAngleBracket(input, index)) {
      angleDepth++
      continue
    }
    if (char === '>' && angleDepth > 0 && canCloseAngleBracket(input, index)) {
      angleDepth--
      continue
    }

    if (
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      angleDepth === 0 &&
      candidates.includes(char)
    ) {
      return index
    }
  }

  return -1
}

function isPrimitiveTypeName(value: string): boolean {
  return [
    'Any',
    'None',
    'bool',
    'bytes',
    'dict',
    'float',
    'int',
    'list',
    'object',
    'set',
    'str',
    'tuple',
  ].includes(value)
}

export function cleanTypeReference(value: string): string {
  return normalizeWhitespace(value)
    .replace(/^:\s*/, '')
    .replace(/[=;,{]+$/, '')
    .trim()
}

export function pythonizeType(rawType: string | undefined): string {
  const original = cleanTypeReference(rawType ?? '')
  if (!original) {
    return 'Any'
  }

  let value = original

  value = value.replace(/\breadonly\s+/g, '')
  value = value.replace(/\bundefined\b/g, 'None')
  value = value.replace(/\bnull\b/g, 'None')
  value = value.replace(/\bvoid\b/g, 'None')
  value = value.replace(/\bstring\b/g, 'str')
  value = value.replace(/\bboolean\b/g, 'bool')
  value = value.replace(/\bnumber\b/g, 'float')
  value = value.replace(/\bunknown\b/g, 'Any')
  value = value.replace(/\bnever\b/g, 'Any')
  value = value.replace(/\bobject\b/g, 'Any')
  value = value.replace(/\bPromise<([^>]+)>/g, '$1')
  value = value.replace(/\bReadonlyArray<([^>]+)>/g, 'list[$1]')
  value = value.replace(/\bArray<([^>]+)>/g, 'list[$1]')
  value = value.replace(/\bSet<([^>]+)>/g, 'set[$1]')
  value = value.replace(/\bMap<([^,>]+),\s*([^>]+)>/g, 'dict[$1, $2]')
  value = value.replace(/\bRecord<([^,>]+),\s*([^>]+)>/g, 'dict[$1, $2]')
  value = value.replace(/([A-Za-z_][A-Za-z0-9_$.]*)\[\]/g, 'list[$1]')
  value = value.replace(/[!?]/g, '')
  value = value.replace(/\$/g, '_')
  value = value.replace(/\s*\|\s*/g, ' | ')

  if (
    /[{};&]|=>|\bextends\b|\bimplements\b|\bkeyof\b|\btypeof\b|\binfer\b/.test(
      value,
    )
  ) {
    return 'Any'
  }

  if (value.includes('<') || value.includes('>')) {
    return 'Any'
  }

  value = value.replace(/[^A-Za-z0-9_.,[\]()| ]/g, '')
  value = normalizeWhitespace(value)

  if (!value || /^[0-9]/.test(value)) {
    return 'Any'
  }

  const segments = value
    .split(/[|,\[\]() ]+/)
    .map(segment => segment.trim())
    .filter(Boolean)

  if (
    segments.some(
      segment =>
        !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(segment) &&
        !['list', 'dict', 'set', 'tuple', 'Any', 'None'].includes(segment),
    )
  ) {
    return 'Any'
  }

  return value
}

export function dependencyLabelForParam(param: ParamIR): string {
  const annotation = cleanTypeReference(param.annotation ?? '')
  if (annotation) {
    for (const part of annotation.split(/[|,&]/)) {
      const token = part.trim()
      const outer = token.match(/[A-Za-z_][A-Za-z0-9_.]*/)
      if (outer && !isPrimitiveTypeName(pythonizeType(outer[0]))) {
        return outer[0]
      }
    }
  }

  return param.name
}

export function safePythonIdentifier(
  value: string,
  fallback: string = 'value',
): string {
  const stripped = value
    .trim()
    .replace(/^[@#]+/, '')
    .replace(/[^A-Za-z0-9_]/g, '_')

  const normalized = stripped || fallback
  const withPrefix = /^[0-9]/.test(normalized) ? `_${normalized}` : normalized
  if (PYTHON_KEYWORDS.has(withPrefix)) {
    return `${withPrefix}_`
  }
  return withPrefix
}

export function parseParametersFromSignature(paramsText: string): ParamIR[] {
  return splitTopLevel(paramsText, ',')
    .map((rawParam, index) => parseSingleParameter(rawParam, index))
    .filter((param): param is ParamIR => param !== null)
}

function parseSingleParameter(
  rawParam: string,
  index: number,
): ParamIR | null {
  let value = normalizeWhitespace(rawParam)
  if (!value) {
    return null
  }

  value = value.replace(
    /^(?:(?:public|private|protected|readonly|override|declare|required|final|static)\s+)+/g,
    '',
  )

  if (value.startsWith('...')) {
    value = `rest_${value.slice(3).trim()}`
  }

  const assignmentIndex = findTopLevelChar(value, ['='])
  const defaultValue =
    assignmentIndex >= 0
      ? normalizeWhitespace(value.slice(assignmentIndex + 1))
      : undefined

  if (assignmentIndex >= 0) {
    value = value.slice(0, assignmentIndex).trim()
  }

  const annotationIndex = findTopLevelChar(value, [':'])
  const annotation =
    annotationIndex >= 0
      ? cleanTypeReference(value.slice(annotationIndex + 1))
      : undefined

  let namePart =
    annotationIndex >= 0 ? value.slice(0, annotationIndex).trim() : value

  namePart = namePart.replace(/[!?]$/, '')
  const normalizedNamePart = namePart
    .replace(/^(?:&\s*|mut\s+|ref\s+|const\s+)+/g, '')
    .trim()

  if (
    normalizedNamePart === 'this' ||
    normalizedNamePart === 'self' ||
    normalizedNamePart === 'cls'
  ) {
    return null
  }

  let name = normalizedNamePart
  if (name.startsWith('{') || name.startsWith('[')) {
    name = `arg${index + 1}`
  }

  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    name = `arg${index + 1}`
  }

  return {
    name,
    annotation,
    defaultValue,
  }
}

export function extractCallTargets(bodyText: string): string[] {
  const sanitized = sanitizeForStructure(bodyText)
  const calls: string[] = []
  const callRegex =
    /\b(?:new\s+)?([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\(/g

  for (const match of sanitized.matchAll(callRegex)) {
    const target = match[1]?.trim()
    if (!target) {
      continue
    }
    const root = target.split('.')[0] ?? target
    if (CALL_KEYWORDS.has(root)) {
      continue
    }

    const matchIndex = match.index ?? 0
    const previousSlice = sanitized.slice(Math.max(0, matchIndex - 12), matchIndex)
    if (
      /\b(?:function|def|class|new)\s*$/.test(previousSlice) ||
      /(^|[^\w$.])(?:if|for|while|switch|catch)\s*$/.test(previousSlice)
    ) {
      continue
    }

    calls.push(target)
  }

  return dedupeStrings(calls)
}

export function extractAwaitTargets(bodyText: string): string[] {
  const sanitized = sanitizeForStructure(bodyText)
  const awaits: string[] = []
  const awaitRegex =
    /\bawait\s+([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\(/g

  for (const match of sanitized.matchAll(awaitRegex)) {
    const target = match[1]?.trim()
    if (target) {
      awaits.push(target)
    }
  }

  return dedupeStrings(awaits)
}

export function extractRaisedTargets(bodyText: string): string[] {
  const raises: string[] = []
  const normalized = sanitizeForStructure(bodyText)

  for (const match of normalized.matchAll(/\bthrow\s+new\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    if (match[1]) {
      raises.push(match[1])
    }
  }

  for (const match of normalized.matchAll(/\braise\s+([A-Za-z_][A-Za-z0-9_.]*)/g)) {
    if (match[1]) {
      raises.push(match[1])
    }
  }

  return dedupeStrings(raises)
}
