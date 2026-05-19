export type CodeLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'ocaml'
  | 'go'
  | 'rust'
  | 'java'
  | 'haxe'
  | 'c'
  | 'cpp'
  | 'zig'
  | 'saasm'
  | 'generic'

export const CODE_INDEX_ARTIFACT_VERSION = 3

export type EdgeKind = 'imports' | 'calls' | 'inherits' | 'depends_on'

export type SourceLineRange = {
  start: number
  end: number
}

export type ParamIR = {
  name: string
  annotation?: string
  defaultValue?: string
}

export type FunctionIR = {
  kind: 'function' | 'method'
  name: string
  qualifiedName: string
  params: ParamIR[]
  returns?: string
  decorators: string[]
  calls: string[]
  awaits: string[]
  raises: string[]
  isAsync: boolean
  isPublic: boolean
  exported: boolean
  sourceLines: SourceLineRange
  originPath?: string
}

export type ClassIR = {
  name: string
  qualifiedName: string
  bases: string[]
  dependsOn: string[]
  methods: FunctionIR[]
  exported: boolean
  sourceLines: SourceLineRange
  originPath?: string
}

export type ModuleIR = {
  moduleId: string
  sourcePath: string
  relativePath: string
  originPath?: string
  originStartCharacter?: number
  originStartLine?: number
  language: string
  parseMode: string
  imports: string[]
  importStubs: string[]
  exports: string[]
  classes: ClassIR[]
  functions: FunctionIR[]
  notes: string[]
  errors: string[]
  sourceBytes: number
  lineCount: number
  truncated: boolean
}

export type EdgeIR = {
  edgeId: string
  kind: EdgeKind
  source: string
  target: string
  sourceFile: string
  sourceSymbol?: string
  lineStart?: number
  lineEnd?: number
  targetFile?: string
  metadata?: Record<string, string | number | boolean>
}

export type CodeIndexManifest = {
  artifactVersion: number
  rootDir: string
  outputDir: string
  createdAt: string
  moduleCount: number
  classCount: number
  functionCount: number
  methodCount: number
  edgeCount: number
  fileLimit?: number
  fileLimitReached: boolean
  truncatedCount: number
  languages: Record<string, number>
  parseModes: Record<string, number>
}
