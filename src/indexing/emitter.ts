import { mkdir, rm, stat, writeFile } from "fs/promises";
import { dirname, join, parse } from "path";
import type { ClassIR, FunctionIR, ModuleIR } from "./ir.js";
import { pythonizeType, safePythonIdentifier } from "./parserUtils.js";
import type { CodeIndexProgressCallback } from "./progress.js";
import { createYieldState, maybeYieldToEventLoop } from "./runtime.js";

const EMIT_PROGRESS_INTERVAL = 128;
const EMIT_PROGRESS_INTERVAL_MS = 250;

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function renderParam(param: FunctionIR["params"][number]): string {
  const name = safePythonIdentifier(param.name, "arg");
  const annotation = pythonizeType(param.annotation);
  return `${name}: ${annotation}`;
}

function normalizeReferenceExpression(raw: string): string | null {
  const superPlaceholder = "__cc_super__";
  let value = raw.trim();
  if (!value) {
    return null;
  }

  value = value.replace(/\?\./g, ".");
  value = value.replace(/!/g, "");
  value = value.replace(/\bthis\b/g, "self");
  value = value.replace(/\bsuper\(\)\b/g, superPlaceholder);
  value = value.replace(/\bsuper\b/g, superPlaceholder);
  value = value.replace(/\bsuper\(\)\./g, `${superPlaceholder}.`);
  value = value.replace(/\bsuper\./g, `${superPlaceholder}.`);
  value = value.replace(/\bnew\s+/g, "");
  value = value.replace(/\$/g, "_");
  value = value.replace(/#/g, "_");

  const segments = value.split(".").filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  const normalizedSegments: string[] = [];
  for (const segment of segments) {
    if (segment === superPlaceholder) {
      normalizedSegments.push("super()");
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      return null;
    }
    normalizedSegments.push(safePythonIdentifier(segment, "ref"));
  }

  return normalizedSegments.join(".");
}

function renderCallExpression(target: string): string | null {
  const expr = normalizeReferenceExpression(target);
  if (!expr) {
    return null;
  }
  return `${expr}(...)`;
}

function renderRaiseExpression(target: string): string | null {
  const expr = normalizeReferenceExpression(target);
  if (!expr) {
    return null;
  }
  return `${expr}(...)`;
}

function renderFunctionBody(
  fn: FunctionIR,
  options: { indent: string; insideClass: boolean },
): string[] {
  const bodyIndent = `${options.indent}    `;
  const lines: string[] = [];

  if (options.insideClass && ["constructor", "__init__"].includes(fn.name)) {
    for (const param of fn.params) {
      if (["this", "self", "cls"].includes(param.name)) {
        continue;
      }
      const name = safePythonIdentifier(param.name, "arg");
      lines.push(`${bodyIndent}self.${name} = ${name}`);
    }
  }

  const awaitTargets = dedupeStrings(fn.awaits)
    .map(renderCallExpression)
    .filter((value): value is string => Boolean(value));
  const awaitSet = new Set(awaitTargets);

  const raiseTargets = dedupeStrings(fn.raises)
    .map(renderRaiseExpression)
    .filter((value): value is string => Boolean(value));
  const raiseSet = new Set(raiseTargets);

  const callTargets = dedupeStrings(fn.calls)
    .map(renderCallExpression)
    .filter((value): value is string => Boolean(value))
    .filter((value) => !awaitSet.has(value))
    .filter((value) => !raiseSet.has(value));

  for (const target of awaitTargets) {
    lines.push(`${bodyIndent}await ${target}`);
  }

  const shouldReturnLastCall =
    pythonizeType(fn.returns) !== "None" && callTargets.length > 0;

  for (const [index, target] of callTargets.entries()) {
    const isLast = index === callTargets.length - 1;
    if (shouldReturnLastCall && isLast) {
      lines.push(`${bodyIndent}return ${target}`);
    } else {
      lines.push(`${bodyIndent}${target}`);
    }
  }

  for (const target of raiseTargets) {
    lines.push(`${bodyIndent}raise ${target}`);
  }

  if (lines.length === 0) {
    return [`${bodyIndent}...`];
  }

  return lines;
}

function renderFunction(
  fn: FunctionIR,
  options: { indent: string; insideClass: boolean },
): string[] {
  const indent = options.indent;
  const lines: string[] = [];

  if (fn.originPath) {
    lines.push(`${indent}# @origin ${fn.originPath}:${fn.sourceLines.start}`);
  }

  const functionName =
    fn.name === "constructor"
      ? "__init__"
      : safePythonIdentifier(fn.name, "generated_function");
  const params = fn.params
    .filter((param) => !["this", "self", "cls"].includes(param.name))
    .map(renderParam);

  if (options.insideClass) {
    params.unshift("self");
  }

  const returns =
    functionName === "__init__" ? "None" : pythonizeType(fn.returns);
  const prefix = fn.isAsync ? "async " : "";
  lines.push(
    `${indent}${prefix}def ${functionName}(${params.join(", ")}) -> ${returns}:`,
  );
  lines.push(...renderFunctionBody(fn, options));
  return lines;
}

function renderClass(cls: ClassIR): string[] {
  const lines: string[] = [];
  const className = safePythonIdentifier(cls.name, "GeneratedClass");
  const bases = cls.bases
    .map(normalizeReferenceExpression)
    .filter((value): value is string => Boolean(value));
  lines.push(
    bases.length > 0
      ? `class ${className}(${bases.join(", ")}):`
      : `class ${className}:`,
  );

  if (cls.methods.length === 0) {
    lines.push("    ...");
    return lines;
  }

  const renderedMethods = cls.methods.flatMap((method, index) => [
    ...(index === 0 ? [] : [""]),
    ...renderFunction(method, { indent: "    ", insideClass: true }),
  ]);
  lines.push(...renderedMethods);
  return lines;
}

function renderModuleSkeleton(module: ModuleIR): string {
  const lines: string[] = ["from __future__ import annotations"];

  if (module.importStubs.length > 0) {
    lines.push("", ...dedupeStrings(module.importStubs));
  }

  lines.push("");

  if (module.classes.length === 0 && module.functions.length === 0) {
    lines.push("...");
    return lines.join("\n") + "\n";
  }

  const body: string[] = [];
  for (const cls of module.classes) {
    if (body.length > 0) {
      body.push("");
    }
    body.push(...renderClass(cls));
  }

  for (const fn of module.functions) {
    if (body.length > 0) {
      body.push("");
    }
    body.push(...renderFunction(fn, { indent: "", insideClass: false }));
  }

  return [...lines, ...body].join("\n") + "\n";
}

function getSkeletonRelativePath(
  relativePath: string,
  usedPaths: Set<string>,
): string {
  const parsed = parse(relativePath);
  let candidate = join(parsed.dir, `${parsed.name}.py`).replaceAll("\\", "/");
  if (!usedPaths.has(candidate)) {
    usedPaths.add(candidate);
    return candidate;
  }

  const disambiguated = join(
    parsed.dir,
    `${parsed.name}__${parsed.base.replace(/[^A-Za-z0-9]+/g, "_")}.py`,
  ).replaceAll("\\", "/");
  usedPaths.add(disambiguated);
  return disambiguated;
}

function buildSkeletonAssignmentMap(
  modules: readonly ModuleIR[],
): Map<string, string> {
  const usedPaths = new Set<string>();
  const assignments = new Map<string, string>();
  const sortedModules = [...modules].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );

  for (const module of sortedModules) {
    assignments.set(
      module.relativePath,
      getSkeletonRelativePath(module.relativePath, usedPaths),
    );
  }

  return assignments;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function emitSkeletonTree(args: {
  modules: readonly ModuleIR[];
  outputDir: string;
  changedModulePaths?: ReadonlySet<string>;
  onProgress?: CodeIndexProgressCallback;
  previousModulesByPath?: ReadonlyMap<string, ModuleIR>;
}): Promise<void> {
  const { modules, outputDir } = args;
  const skeletonRoot = join(outputDir, "skeleton");
  const yieldState = createYieldState();
  const currentAssignments = buildSkeletonAssignmentMap(modules);
  const previousModules = args.previousModulesByPath
    ? [...args.previousModulesByPath.values()]
    : [];
  const previousAssignments = buildSkeletonAssignmentMap(previousModules);
  const total = modules.length;
  let completed = 0;
  let lastReportedCompleted = -1;
  let lastReportedAt = 0;

  const reportProgress = async (force = false): Promise<void> => {
    if (!args.onProgress) {
      return;
    }

    const now = Date.now();
    if (
      !force &&
      completed !== total &&
      completed - lastReportedCompleted < EMIT_PROGRESS_INTERVAL &&
      now - lastReportedAt < EMIT_PROGRESS_INTERVAL_MS
    ) {
      return;
    }

    lastReportedCompleted = completed;
    lastReportedAt = now;
    await args.onProgress({
      phase: "emit",
      message: `Updating skeleton ${completed}/${total} modules`,
      completed,
      total,
    });
  };

  const markProcessed = async (): Promise<void> => {
    completed++;
    await reportProgress();
  };

  await mkdir(skeletonRoot, { recursive: true });
  await reportProgress(true);

  const staleTargets = new Set<string>();
  for (const [relativePath, previousTarget] of previousAssignments.entries()) {
    const currentTarget = currentAssignments.get(relativePath);
    if (!currentTarget || currentTarget !== previousTarget) {
      staleTargets.add(previousTarget);
    }
  }

  for (const staleTarget of staleTargets) {
    await maybeYieldToEventLoop(yieldState);
    await rm(join(skeletonRoot, staleTarget), { force: true });
  }

  for (const module of modules) {
    await maybeYieldToEventLoop(yieldState);
    const relativeTarget = currentAssignments.get(module.relativePath);
    if (!relativeTarget) {
      await markProcessed();
      continue;
    }

    const previousTarget = previousAssignments.get(module.relativePath);
    const shouldWrite =
      !args.previousModulesByPath?.has(module.relativePath) ||
      args.changedModulePaths?.has(module.relativePath) ||
      previousTarget !== relativeTarget;

    if (!shouldWrite) {
      await markProcessed();
      continue;
    }

    const targetPath = join(skeletonRoot, relativeTarget);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, renderModuleSkeleton(module), "utf8");
    await markProcessed();
  }

  const overview = "...\n";
  const overviewPath = join(skeletonRoot, "__root__.py");
  const shouldWriteOverview =
    !args.previousModulesByPath ||
    args.previousModulesByPath.size === 0 ||
    Boolean(args.changedModulePaths?.size) ||
    staleTargets.size > 0 ||
    !(await pathExists(overviewPath));

  if (shouldWriteOverview) {
    await writeFile(overviewPath, overview, "utf8");
  }

  if (lastReportedCompleted !== completed) {
    await reportProgress(true);
  }
}
