import { mkdir, readFile, rm, stat } from "fs/promises";
import { join } from "path";
import type { CodeIndexBuildOptions } from "./config.js";
import { resolveCodeIndexConfig } from "./config.js";
import { discoverSourceFiles, type DiscoveredSourceFile } from "./discovery.js";
import { emitSkeletonTree } from "./emitter.js";
import {
  fingerprintsEqual,
  fingerprintLoadedSource,
  loadModuleCache,
  writeModuleCache,
  type ModuleCacheFingerprint,
} from "./incremental.js";
import {
  CODE_INDEX_ARTIFACT_VERSION,
  type CodeIndexManifest,
  type ModuleIR,
} from "./ir.js";
import { parseModuleWithBuiltinParsers } from "./parseBuiltin.js";
import { parseModulesWithWorkerPool } from "./parseWorkerPool.js";
import {
  ensureSourceStrategyPluginsLoaded,
  expandSourceFile,
} from "./strategy.js";
import type { SourceUnit } from "./strategyTypes.js";
import type {
  CodeIndexBuildProgress,
  CodeIndexProgressCallback,
} from "./progress.js";
import { createYieldState, maybeYieldToEventLoop } from "./runtime.js";
import { buildEdges, writeIndexFiles } from "./indexWriter.js";
import {
  ensureCodeIndexGitignore,
  resolveCodeIndexGitignoreEntries,
} from "./gitignore.js";
import {
  type CodeIndexSkillPaths,
  writeCodeIndexSkills,
} from "./skillWriter.js";

type ResolvedCodeIndexConfig = ReturnType<typeof resolveCodeIndexConfig>;

type ParseModuleArgs = {
  config: ResolvedCodeIndexConfig;
  file: DiscoveredSourceFile;
  source?: SourceUnit["source"];
};

export type BuildCodeIndexResult = {
  engine: "typescript";
  fileLimitReached: boolean;
  incremental: CodeIndexIncrementalStats;
  maxFiles?: number;
  manifest: CodeIndexManifest;
  outputDir: string;
  parseWorkers: number;
  rootDir: string;
  skillPaths: CodeIndexSkillPaths;
  timings: CodeIndexTimings;
};

export type CodeIndexTimings = {
  buildEdgesMs: number;
  discoverMs: number;
  emitSkeletonMs: number;
  parseMs: number;
  totalMs: number;
  writeIndexFilesMs: number;
  writeSkillsMs: number;
};

export type CodeIndexIncrementalStats = {
  cacheHits: number;
  cacheMisses: number;
  removedFiles: number;
};

const PARSE_PROGRESS_INTERVAL = 32;
const PARSE_PROGRESS_INTERVAL_MS = 250;

async function reportProgress(
  callback: CodeIndexProgressCallback | undefined,
  progress: CodeIndexBuildProgress,
): Promise<void> {
  await callback?.(progress);
}

function createParseProgressReporter(args: {
  onProgress: CodeIndexProgressCallback | undefined;
  removedFiles: number;
  reusedFiles: number;
  total: number;
}) {
  let completed = 0;
  let lastReportedCompleted = -1;
  let lastReportedAt = 0;

  const emit = async (force = false): Promise<void> => {
    if (!args.onProgress) {
      return;
    }
    const now = Date.now();
    if (
      !force &&
      completed !== args.total &&
      completed - lastReportedCompleted < PARSE_PROGRESS_INTERVAL &&
      now - lastReportedAt < PARSE_PROGRESS_INTERVAL_MS
    ) {
      return;
    }
    lastReportedCompleted = completed;
    lastReportedAt = now;
    await args.onProgress({
      phase: "parse",
      message:
        args.total === 0
          ? `Parse complete: reused ${args.reusedFiles} cached files${
              args.removedFiles > 0 ? `, removed ${args.removedFiles}` : ""
            }`
          : `Parsing ${completed}/${args.total} changed files (reused ${args.reusedFiles}${
              args.removedFiles > 0 ? `, removed ${args.removedFiles}` : ""
            })`,
      completed,
      total: args.total,
    });
  };

  return {
    async increment(): Promise<void> {
      completed++;
      await emit();
    },
    async reset(): Promise<void> {
      completed = 0;
      lastReportedCompleted = -1;
      lastReportedAt = 0;
      await emit(true);
    },
    async start(): Promise<void> {
      await emit(true);
    },
    async finish(): Promise<void> {
      completed = args.total;
      await emit(true);
    },
  };
}

async function prepareOutputDirectory(outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await mkdir(join(outputDir, "skeleton"), { recursive: true });
  await mkdir(join(outputDir, "index"), { recursive: true });
}

type ParseModuleFn = (args: {
  config: ResolvedCodeIndexConfig;
  file: DiscoveredSourceFile;
  source?: SourceUnit["source"];
}) => Promise<ModuleIR>;

async function parseModuleWithBuiltin(
  args: ParseModuleArgs,
): Promise<ModuleIR> {
  return parseModuleWithBuiltinParsers({
    file: args.file,
    source: args.source,
    maxFileBytes: args.config.maxFileBytes,
  });
}

type ExpandedUnit = {
  index: number
  unit: SourceUnit
}

async function parseExpandedUnitsSequentially(args: {
  config: ResolvedCodeIndexConfig
  entries: readonly ExpandedUnit[]
  modules: ModuleIR[]
  onParsed?: () => void | Promise<void>
  parse: ParseModuleFn
  yieldState: ReturnType<typeof createYieldState>
}): Promise<void> {
  for (const entry of args.entries) {
    await maybeYieldToEventLoop(args.yieldState)
    args.modules[entry.index] = await args.parse({
      config: args.config,
      file: entry.unit.file,
      source: entry.unit.source,
    })
    await args.onParsed?.()
  }
}

async function persistModuleCache(args: {
  config: ResolvedCodeIndexConfig;
  engine: BuildCodeIndexResult["engine"];
  entries: readonly ExpandedUnit[];
  fingerprints: ReadonlyMap<string, ModuleCacheFingerprint>;
  modules: readonly ModuleIR[];
}): Promise<void> {
  try {
    await writeModuleCache({
      engine: args.engine,
      maxFileBytes: args.config.maxFileBytes,
      outputDir: args.config.outputDir,
      rootDir: args.config.rootDir,
      entries: args.entries
      .map((entry) => {
          const fingerprint = args.fingerprints.get(entry.unit.file.relativePath);
          const module = args.modules[entry.index];
          if (!fingerprint || !module) {
            return null;
          }
          return {
            relativePath: entry.unit.file.relativePath,
            fingerprint,
            module,
          };
        })
        .filter(
          (
            value,
          ): value is {
            relativePath: string;
            fingerprint: ModuleCacheFingerprint;
            module: ModuleIR;
          } => Boolean(value),
        ),
    });
  } catch {
    // Incremental cache persistence is best-effort and should not fail indexing.
  }
}

async function cleanupTemporaryPaths(paths: readonly string[]): Promise<void> {
  for (const path of [...paths].reverse()) {
    try {
      await rm(path, { recursive: true, force: true })
    } catch {
      // Best effort cleanup only.
    }
  }
}

async function fingerprintSourceUnit(args: {
  unit: SourceUnit;
}): Promise<ModuleCacheFingerprint | null> {
  const source = args.unit.source
  if (source) {
    return fingerprintLoadedSource(source)
  }

  if (!args.unit.fingerprintPath) {
    return null
  }

  try {
    const text = await readFile(args.unit.fingerprintPath, 'utf8')
    return fingerprintLoadedSource({
      text,
      byteSize: Buffer.byteLength(text, 'utf8'),
      truncated: false,
    })
  } catch {
    return null
  }
}

async function parseExpandedUnits(args: {
  config: ResolvedCodeIndexConfig;
  engine: BuildCodeIndexResult["engine"];
  files: readonly DiscoveredSourceFile[];
  parse: ParseModuleFn;
}): Promise<{
  changedModulePaths: Set<string>;
  incremental: CodeIndexIncrementalStats;
  modules: ModuleIR[];
  parseWorkers: number;
  previousModulesByPath: Map<string, ModuleIR>;
  removedModulePaths: Set<string>;
}> {
  const expandedEntries: ExpandedUnit[] = []
  const expandYieldState = createYieldState()
  const cleanupPaths: string[] = []

  try {
    await reportProgress(args.config.onProgress, {
      phase: 'expand',
      message: `Expanding ${args.files.length} source files`,
      completed: 0,
      total: args.files.length,
    })

    let expandedFiles = 0
    for (const file of args.files) {
      await maybeYieldToEventLoop(expandYieldState)
      const sourceExpansion = await expandSourceFile({
        enabledKinds: args.config.sourceStrategyKinds,
        file,
        maxFileBytes: args.config.maxFileBytes,
        rootDir: args.config.rootDir,
        discoverPluginManifests: args.config.discoverSourceStrategyPluginManifests,
        pluginManifests: args.config.sourceStrategyPluginManifests,
      })
      cleanupPaths.push(...sourceExpansion.cleanupPaths)
      if (sourceExpansion.units.length > 0) {
        expandedFiles++
      }
      for (const unit of sourceExpansion.units) {
        expandedEntries.push({
          index: expandedEntries.length,
          unit,
        })
      }

      if (args.config.onProgress && expandedFiles % 32 === 0) {
        await args.config.onProgress({
          phase: 'expand',
          message: `Expanded ${expandedFiles}/${args.files.length} source files`,
          completed: expandedFiles,
          total: args.files.length,
        })
      }
    }

    await reportProgress(args.config.onProgress, {
      phase: 'expand',
      message: `Expanded ${expandedFiles}/${args.files.length} source files`,
      completed: expandedFiles,
      total: args.files.length,
    })

    const modules = new Array<ModuleIR>(expandedEntries.length)
    const fingerprints = new Map<string, ModuleCacheFingerprint>()
    const cache = await loadModuleCache({
      engine: args.engine,
      maxFileBytes: args.config.maxFileBytes,
      outputDir: args.config.outputDir,
      rootDir: args.config.rootDir,
    })

    const currentModulePaths = new Set(
      expandedEntries.map(entry => entry.unit.file.relativePath),
    )
    const removedModulePaths = new Set<string>()
    for (const relativePath of cache.keys()) {
      if (!currentModulePaths.has(relativePath)) {
        removedModulePaths.add(relativePath)
      }
    }

    const entriesToParse: ExpandedUnit[] = []
    for (const entry of expandedEntries) {
      const fingerprint = await fingerprintSourceUnit({ unit: entry.unit })
      if (fingerprint) {
        fingerprints.set(entry.unit.file.relativePath, fingerprint)
      }

      const cached = cache.get(entry.unit.file.relativePath)
      if (
        fingerprint &&
        cached &&
        fingerprintsEqual(fingerprint, cached.fingerprint)
      ) {
        modules[entry.index] = cached.module
        continue
      }

      entriesToParse.push(entry)
    }

    const incremental = {
      cacheHits: expandedEntries.length - entriesToParse.length,
      cacheMisses: entriesToParse.length,
      removedFiles: removedModulePaths.size,
    }
    const parseProgress = createParseProgressReporter({
      onProgress: args.config.onProgress,
      removedFiles: incremental.removedFiles,
      reusedFiles: incremental.cacheHits,
      total: incremental.cacheMisses,
    })
    const changedModulePaths = new Set(
      entriesToParse.map(entry => entry.unit.file.relativePath),
    )

    const previousModulesByPath = new Map<string, ModuleIR>(
      [...cache.entries()].map(([relativePath, record]) => [
        relativePath,
        record.module,
      ]),
    )

    if (entriesToParse.length === 0) {
      await parseProgress.start()
      await persistModuleCache({
        config: args.config,
        engine: args.engine,
        entries: expandedEntries,
        fingerprints,
        modules,
      })
      return {
        changedModulePaths,
        incremental,
        modules,
        parseWorkers: 0,
        previousModulesByPath,
        removedModulePaths,
      }
    }

    const sourcesByRelativePath = new Map<string, SourceUnit['source']>(
      entriesToParse.map(entry => [entry.unit.file.relativePath, entry.unit.source]),
    )

    if (args.config.parseWorkers <= 1 || entriesToParse.length <= 1) {
      await parseProgress.start()
      await parseExpandedUnitsSequentially({
        config: args.config,
        entries: entriesToParse,
        modules,
        onParsed: () => parseProgress.increment(),
        parse: args.parse,
        yieldState: createYieldState(),
      })
      await parseProgress.finish()
      await persistModuleCache({
        config: args.config,
        engine: args.engine,
        entries: expandedEntries,
        fingerprints,
        modules,
      })
      return {
        changedModulePaths,
        incremental,
        modules,
        parseWorkers: 1,
        previousModulesByPath,
        removedModulePaths,
      }
    }

    const workerCount = Math.min(args.config.parseWorkers, entriesToParse.length)

    try {
      await parseProgress.start()
      const workerModules = await parseModulesWithWorkerPool({
        files: entriesToParse.map(entry => entry.unit.file),
        maxFileBytes: args.config.maxFileBytes,
        onParsed: () => parseProgress.increment(),
        sources: sourcesByRelativePath,
        workerCount,
      })

      for (const [index, module] of workerModules.entries()) {
        modules[entriesToParse[index]!.index] = module
      }

      await parseProgress.finish()
      await persistModuleCache({
        config: args.config,
        engine: args.engine,
        entries: expandedEntries,
        fingerprints,
        modules,
      })
      return {
        changedModulePaths,
        incremental,
        modules,
        parseWorkers: workerCount,
        previousModulesByPath,
        removedModulePaths,
      }
    } catch {
      await parseProgress.reset()
      await parseExpandedUnitsSequentially({
        config: args.config,
        entries: entriesToParse,
        modules,
        onParsed: () => parseProgress.increment(),
        parse: args.parse,
        yieldState: createYieldState(),
      })
      await parseProgress.finish()
      await persistModuleCache({
        config: args.config,
        engine: args.engine,
        entries: expandedEntries,
        fingerprints,
        modules,
      })
      return {
        changedModulePaths,
        incremental,
        modules,
        parseWorkers: 1,
        previousModulesByPath,
        removedModulePaths,
      }
    }
  } finally {
    await cleanupTemporaryPaths(cleanupPaths)
  }
}

type CodeIndexArtifactPaths = {
  architectureDot: string;
  edgesJsonl: string;
  manifestJson: string;
  modulesJsonl: string;
  pythonIndex: string;
  summaryMd: string;
  symbolsJsonl: string;
};

function resolveCodeIndexArtifactPaths(
  outputDir: string,
): CodeIndexArtifactPaths {
  const indexDir = join(outputDir, "index");
  return {
    architectureDot: join(indexDir, "architecture.dot"),
    edgesJsonl: join(indexDir, "edges.jsonl"),
    manifestJson: join(indexDir, "manifest.json"),
    modulesJsonl: join(indexDir, "modules.jsonl"),
    pythonIndex: join(outputDir, "__index__.py"),
    summaryMd: join(indexDir, "summary.md"),
    symbolsJsonl: join(indexDir, "symbols.jsonl"),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readPreviousManifest(
  outputDir: string,
): Promise<CodeIndexManifest | null> {
  try {
    const raw = await readFile(
      resolveCodeIndexArtifactPaths(outputDir).manifestJson,
      "utf8",
    );
    return JSON.parse(raw) as CodeIndexManifest;
  } catch {
    return null;
  }
}

async function reusePreviousOutputsIfUnchanged(args: {
  config: ResolvedCodeIndexConfig;
  fileLimitReached: boolean;
  incremental: CodeIndexIncrementalStats;
  modules: readonly ModuleIR[];
}): Promise<{
  manifest: CodeIndexManifest;
} | null> {
  if (args.incremental.cacheMisses > 0 || args.incremental.removedFiles > 0) {
    return null;
  }

  const manifest = await readPreviousManifest(args.config.outputDir);
  if (!manifest) {
    return null;
  }

  if (
    manifest.artifactVersion !== CODE_INDEX_ARTIFACT_VERSION ||
    manifest.rootDir !== args.config.rootDir ||
    manifest.outputDir !== args.config.outputDir ||
    manifest.fileLimit !== args.config.maxFiles ||
    manifest.fileLimitReached !== args.fileLimitReached ||
    manifest.moduleCount !== args.modules.length
  ) {
    return null;
  }

  const artifactPaths = resolveCodeIndexArtifactPaths(args.config.outputDir);
  const requiredPaths = [
    artifactPaths.architectureDot,
    artifactPaths.edgesJsonl,
    artifactPaths.manifestJson,
    artifactPaths.modulesJsonl,
    artifactPaths.pythonIndex,
    artifactPaths.summaryMd,
    artifactPaths.symbolsJsonl,
  ];

  for (const requiredPath of requiredPaths) {
    if (!(await pathExists(requiredPath))) {
      return null;
    }
  }

  return {
    manifest,
  };
}

export async function buildCodeIndex(
  options: CodeIndexBuildOptions = {},
): Promise<BuildCodeIndexResult> {
  const config = resolveCodeIndexConfig(options);
  await ensureSourceStrategyPluginsLoaded(
    {
      manifestPaths: [...config.sourceStrategyPluginManifests],
      rootDir: config.rootDir,
      discoverFromRoot: config.discoverSourceStrategyPluginManifests,
    },
  );
  return buildCodeIndexWithDiscovery(options, {
    discover: discoverSourceFiles,
    engine: "typescript",
    parse: parseModuleWithBuiltin,
  });
}

async function buildCodeIndexWithDiscovery(
  options: CodeIndexBuildOptions,
  args: {
    discover: typeof discoverSourceFiles;
    engine: BuildCodeIndexResult["engine"];
    parse: ParseModuleFn;
  },
): Promise<BuildCodeIndexResult> {
  const totalStartedAt = performance.now();
  const config = resolveCodeIndexConfig(options);
  await prepareOutputDirectory(config.outputDir);

  await reportProgress(config.onProgress, {
    phase: "discover",
    message: `Scanning ${config.rootDir} for source files`,
  });
  const discoverStartedAt = performance.now();
  const discovery = await args.discover(config);
  const discoverMs = performance.now() - discoverStartedAt;
  const files = discovery.files;
  await reportProgress(config.onProgress, {
    phase: "discover",
    message: `Found ${files.length} source files`,
    completed: files.length,
    total: files.length,
  });

  const parseStartedAt = performance.now();
  const parsed = await parseExpandedUnits({
    config,
    engine: args.engine,
    files,
    parse: args.parse,
  });
  const parseMs = performance.now() - parseStartedAt;
  const modules = parsed.modules;

  const emitSkeletonStartedAt = performance.now();
  await emitSkeletonTree({
    modules,
    outputDir: config.outputDir,
    changedModulePaths: parsed.changedModulePaths,
    onProgress: config.onProgress,
    previousModulesByPath: parsed.previousModulesByPath,
  });
  const emitSkeletonMs = performance.now() - emitSkeletonStartedAt;

  const reusedOutputs = await reusePreviousOutputsIfUnchanged({
    config,
    fileLimitReached: discovery.fileLimitReached,
    incremental: parsed.incremental,
    modules,
  });

  let buildEdgesMs = 0;
  let writeIndexFilesMs = 0;
  let writeSkillsMs = 0;
  let manifest: CodeIndexManifest;
  let skillPaths: CodeIndexSkillPaths;

  if (reusedOutputs) {
    manifest = reusedOutputs.manifest;
  } else {
    await reportProgress(config.onProgress, {
      phase: "edges",
      message: `Building dependency edges for ${modules.length} modules`,
      completed: modules.length,
      total: modules.length,
    });
    const buildEdgesStartedAt = performance.now();
    const edges = await buildEdges(modules);
    buildEdgesMs = performance.now() - buildEdgesStartedAt;

    await reportProgress(config.onProgress, {
      phase: "write",
      message: `Writing code index artifacts`,
      completed: modules.length,
      total: modules.length,
    });
    const writeIndexFilesStartedAt = performance.now();
    manifest = await writeIndexFiles({
      edges,
      fileLimitReached: discovery.fileLimitReached,
      maxFiles: config.maxFiles,
      modules,
      outputDir: config.outputDir,
      rootDir: config.rootDir,
    });
    writeIndexFilesMs = performance.now() - writeIndexFilesStartedAt;
  }
  await reportProgress(config.onProgress, {
    phase: "skills",
    message: `Refreshing code-index skills`,
  });
  const writeSkillsStartedAt = performance.now();
  skillPaths = await writeCodeIndexSkills({
    outputDir: config.outputDir,
    rootDir: config.rootDir,
  });
  writeSkillsMs = performance.now() - writeSkillsStartedAt;

  const gitignoreEntries = resolveCodeIndexGitignoreEntries({
    outputDir: config.outputDir,
    rootDir: config.rootDir,
    skillPaths: [
      skillPaths.claude,
      skillPaths.codex,
      skillPaths.opencode,
    ],
  });
  await ensureCodeIndexGitignore({
    entries: gitignoreEntries,
    rootDir: config.rootDir,
  });

  const totalMs = performance.now() - totalStartedAt;
  await reportProgress(config.onProgress, {
    phase: "complete",
    message: `Code index ready in ${Math.round(totalMs)}ms`,
    completed: manifest.moduleCount,
    total: manifest.moduleCount,
  });

  return {
    engine: args.engine,
    fileLimitReached: discovery.fileLimitReached,
    incremental: parsed.incremental,
    maxFiles: config.maxFiles,
    manifest,
    outputDir: config.outputDir,
    parseWorkers: parsed.parseWorkers,
    rootDir: config.rootDir,
    skillPaths,
    timings: {
      buildEdgesMs,
      discoverMs,
      emitSkeletonMs,
      parseMs,
      totalMs,
      writeIndexFilesMs,
      writeSkillsMs,
    },
  };
}
