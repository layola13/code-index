import type { CodeIndexConfig } from './config.js'
import type { DiscoveredSourceFile } from './discovery.js'
import type { ModuleIR } from './ir.js'
import { relativePathToModuleId } from './parserUtils.js'
import { parseAstModule } from './treeSitterAst.js'
import { parseGenericModule } from './parsers/generic.js'
import { parsePythonModule } from './parsers/python.js'
import { parseTypeScriptLikeModule } from './parsers/typescriptLike.js'
import { readSourceText } from './source.js'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function dedupeStrings(values: readonly string[]): string[] {
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

function buildReadErrorModule(file: DiscoveredSourceFile): ModuleIR {
  return {
    moduleId: relativePathToModuleId(file.relativePath),
    sourcePath: file.absolutePath,
    relativePath: file.relativePath,
    language: file.language,
    parseMode: 'read-error',
    imports: [],
    importStubs: [],
    exports: [],
    classes: [],
    functions: [],
    notes: [],
    errors: ['failed to read source file'],
    sourceBytes: 0,
    lineCount: 0,
    truncated: false,
  }
}

function createParserConfig(maxFileBytes: number): CodeIndexConfig {
  return {
    rootDir: '',
    outputDir: '',
    outputDirName: '',
    maxFileBytes,
    parseWorkers: 1,
    ignoredDirNames: new Set<string>(),
  }
}

function parseModule(context: {
  config: CodeIndexConfig
  file: DiscoveredSourceFile
  source: Awaited<ReturnType<typeof readSourceText>>
}): ModuleIR {
  let astResult: ReturnType<typeof parseAstModule> | null = null
  let astError: unknown = null

  try {
    astResult = parseAstModule({
      filePath: context.file.absolutePath,
      relativePath: context.file.relativePath,
      sourceText: context.source.text,
      moduleId: relativePathToModuleId(context.file.relativePath),
    })
  } catch (error) {
    astError = error
  }

  if (astResult) {
    return {
      moduleId: relativePathToModuleId(context.file.relativePath),
      sourcePath: context.file.absolutePath,
      relativePath: context.file.relativePath,
      language: astResult.language ?? context.file.language,
      parseMode: context.source.truncated ? 'ast-truncated' : 'ast-tree-sitter',
      imports: astResult.imports,
      importStubs: astResult.importStubs,
      exports: astResult.exportNames ?? [],
      classes: astResult.classes,
      functions: astResult.functions,
      notes: astResult.notes ?? [],
      errors: astResult.errors ?? [],
      sourceBytes: context.source.byteSize,
      lineCount: context.source.text.split('\n').length,
      truncated: context.source.truncated,
    }
  }

  const parseErrorMessage = astError
    ? `parse error: ${describeError(astError)}`
    : undefined

  const fallbackModule =
    context.file.language === 'tsx' ||
    context.file.language === 'typescript' ||
    context.file.language === 'javascript'
      ? parseTypeScriptLikeModule(context)
      : context.file.language === 'python'
        ? parsePythonModule(context)
        : parseGenericModule(context)

  if (parseErrorMessage) {
    fallbackModule.errors = dedupeStrings([
      ...fallbackModule.errors,
      parseErrorMessage,
    ])
  }

  fallbackModule.parseMode = context.source.truncated
    ? `fallback-${context.file.language}-truncated`
    : `fallback-${context.file.language}`
  return fallbackModule
}

export type BuiltinParseRequest = {
  file: DiscoveredSourceFile
  maxFileBytes: number
}

export async function parseModuleWithBuiltinParsers(
  args: BuiltinParseRequest,
): Promise<ModuleIR> {
  const config = createParserConfig(args.maxFileBytes)

  let source
  try {
    source = await readSourceText(args.file.absolutePath, config.maxFileBytes)
  } catch (error) {
    const failedModule = buildReadErrorModule(args.file)
    failedModule.errors = [`read error: ${describeError(error)}`]
    return failedModule
  }

  try {
    return parseModule({
      config,
      file: args.file,
      source,
    })
  } catch (error) {
    const parseError = describeError(error)
    const fallbackModule =
      args.file.language === 'typescript' ||
      args.file.language === 'tsx' ||
      args.file.language === 'javascript'
        ? parseTypeScriptLikeModule({
            config,
            file: args.file,
            source,
          })
        : args.file.language === 'python'
          ? parsePythonModule({
              config,
              file: args.file,
              source,
            })
          : parseGenericModule(
              {
                config,
                file: args.file,
                source,
              },
              ['parser fell back to generic pattern matching'],
              [`parse error: ${parseError}`],
            )

    fallbackModule.parseMode = source.truncated
      ? `fallback-${args.file.language}-truncated`
      : `fallback-${args.file.language}`
    fallbackModule.errors = dedupeStrings([
      ...fallbackModule.errors,
      `parse error: ${parseError}`,
    ])
    return fallbackModule
  }
}
