import { stat } from "fs/promises";
import { dirname, isAbsolute, join, resolve } from "path";
import { registerCleanup } from "../utils/cleanupRegistry.js";
import { getCwd } from "../utils/cwd.js";
import { logForDebugging } from "../utils/debug.js";
import { errorMessage } from "../utils/errors.js";
import { buildCodeIndex } from "./build.js";
import { isGeneratedIndexDirName } from "./config.js";

const AUTO_INDEX_DEBOUNCE_MS = 1000;
const DEFAULT_OUTPUT_DIR_NAME = ".code_index";

type AutoIndexTarget = {
  outputDir: string;
  rootDir: string;
};

let cleanupRegistered = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let runningPromise: Promise<void> | null = null;
const inflightRegistrations = new Set<Promise<void>>();
const pendingTargets = new Map<string, AutoIndexTarget>();

function autoIndexEnabled(): boolean {
  return process.env.CLAUDE_CODE_AUTO_INDEX !== "0";
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function shouldIgnorePath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized
    .split("/")
    .filter(Boolean)
    .some(segment => isGeneratedIndexDirName(segment));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function hasInitializedIndex(outputDir: string): Promise<boolean> {
  return (
    (await pathExists(join(outputDir, "module-cache.v1.json"))) ||
    (await pathExists(join(outputDir, "index", "manifest.json")))
  );
}

async function findAutoIndexTarget(
  pathHint: string,
): Promise<AutoIndexTarget | null> {
  const absolutePath = isAbsolute(pathHint)
    ? pathHint
    : resolve(getCwd(), pathHint);
  let currentDir = dirname(absolutePath);

  while (true) {
    const outputDir = join(currentDir, DEFAULT_OUTPUT_DIR_NAME);
    if (await hasInitializedIndex(outputDir)) {
      return {
        outputDir,
        rootDir: currentDir,
      };
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function registerAutoIndexCleanup(): void {
  if (cleanupRegistered) {
    return;
  }
  cleanupRegistered = true;
  registerCleanup(async () => {
    await flushPendingAutoIndex();
  });
}

async function runPendingAutoIndexTargets(): Promise<void> {
  const targets = [...pendingTargets.values()];
  pendingTargets.clear();

  for (const target of targets) {
    const startedAt = Date.now();
    try {
      const result = await buildCodeIndex({
        outputDir: target.outputDir,
        rootDir: target.rootDir,
      });
      logForDebugging(
        `auto-index: updated ${target.outputDir} in ${Date.now() - startedAt}ms (reused ${result.incremental.cacheHits}, parsed ${result.incremental.cacheMisses}, removed ${result.incremental.removedFiles})`,
        { level: "debug" },
      );
    } catch (error) {
      logForDebugging(
        `auto-index: failed for ${target.outputDir}: ${errorMessage(error)}`,
        { level: "warn" },
      );
    }
  }
}

function scheduleAutoIndexRun(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (runningPromise) {
      scheduleAutoIndexRun();
      return;
    }

    runningPromise = runPendingAutoIndexTargets().finally(() => {
      runningPromise = null;
      if (pendingTargets.size > 0) {
        scheduleAutoIndexRun();
      }
    });
  }, AUTO_INDEX_DEBOUNCE_MS);
  debounceTimer.unref?.();
}

async function flushPendingAutoIndex(): Promise<void> {
  if (inflightRegistrations.size > 0) {
    await Promise.all([...inflightRegistrations]);
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  if (runningPromise) {
    await runningPromise;
  }

  if (pendingTargets.size === 0) {
    return;
  }

  runningPromise = runPendingAutoIndexTargets().finally(() => {
    runningPromise = null;
  });
  await runningPromise;

  if (pendingTargets.size > 0) {
    await flushPendingAutoIndex();
  }
}

export function notifyAutoIndexFileMutation(pathHint: string): void {
  if (!autoIndexEnabled()) {
    return;
  }

  const absolutePath = isAbsolute(pathHint)
    ? pathHint
    : resolve(getCwd(), pathHint);
  if (shouldIgnorePath(absolutePath)) {
    return;
  }

  registerAutoIndexCleanup();
  const registration = findAutoIndexTarget(absolutePath)
    .then((target) => {
      if (!target) {
        return;
      }
      pendingTargets.set(target.outputDir, target);
      scheduleAutoIndexRun();
    })
    .finally(() => {
      inflightRegistrations.delete(registration);
    });
  inflightRegistrations.add(registration);
}

export async function flushPendingAutoIndexForTesting(): Promise<void> {
  await flushPendingAutoIndex();
}

export function _resetAutoIndexStateForTesting(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  cleanupRegistered = false;
  debounceTimer = null;
  runningPromise = null;
  inflightRegistrations.clear();
  pendingTargets.clear();
}
