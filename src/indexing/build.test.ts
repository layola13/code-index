import { describe, expect, it } from "bun:test";
import { existsSync } from "fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildCodeIndex } from "./build.js";
import { formatCountSummary } from "./indexWriter.js";
import type { CodeIndexBuildProgress } from "./progress.js";
import webpack from "webpack";
import { build as esbuildBuild } from "esbuild";
import { build as viteBuild } from "vite";
import { minify } from "terser";

async function buildWebpackFixture(args: {
  rootDir: string;
  entryRelativePath: string;
  bundlePath: string;
  sourcemap?: boolean;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    webpack(
      {
        mode: "development",
        entry: join(args.rootDir, args.entryRelativePath),
        output: {
          path: args.rootDir,
          filename: args.bundlePath,
        },
        devtool: args.sourcemap ? "source-map" : false,
        target: "web",
        optimization: {
          minimize: false,
        },
      },
      (error, stats) => {
        if (error) {
          reject(error);
          return;
        }
        if (stats?.hasErrors()) {
          reject(new Error(stats.toString({ colors: false })));
          return;
        }
        resolve();
      },
    );
  });
}

async function buildEsbuildFixture(args: {
  rootDir: string;
  entryRelativePath: string;
  bundlePath: string;
  format?: "iife" | "cjs";
  sourcemap?: boolean;
}): Promise<void> {
  await esbuildBuild({
    entryPoints: [join(args.rootDir, args.entryRelativePath)],
    bundle: true,
    sourcemap: args.sourcemap ?? false,
    outfile: join(args.rootDir, args.bundlePath),
    format: args.format ?? "iife",
    platform: args.format === "cjs" ? "node" : "browser",
    write: true,
    logLevel: "silent",
  });
}

async function buildViteFixture(args: {
  rootDir: string;
  entryRelativePath: string;
  lazyRelativePath?: string;
  sourcemap?: boolean;
}): Promise<{ bundleFilePath: string; assetFiles: string[] }> {
  const htmlPath = join(args.rootDir, "index.html");
  await writeFile(
    htmlPath,
    `<!doctype html><html><body><script type="module" src="/${args.entryRelativePath}"></script></body></html>`,
    "utf8",
  );

  await viteBuild({
    root: args.rootDir,
    build: {
      outDir: "bundle-out",
      emptyOutDir: true,
      sourcemap: args.sourcemap ?? false,
      rollupOptions: {
        input: htmlPath,
      },
    },
  });

  const assetsDir = join(args.rootDir, "bundle-out", "assets");
  const { readdir } = await import("fs/promises");
  const assetFiles = await readdir(assetsDir);
  const bundleFile = assetFiles.find(
    (name) => name.endsWith(".js") && name.startsWith("index-"),
  );
  if (!bundleFile) {
    throw new Error("failed to locate vite bundle");
  }

  return {
    bundleFilePath: join(assetsDir, bundleFile),
    assetFiles,
  };
}

async function buildTerserFixture(args: {
  rootDir: string;
  sourceRelativePath: string;
  bundleRelativePath: string;
  sourcemap?: boolean;
}): Promise<void> {
  const source = await readFile(join(args.rootDir, args.sourceRelativePath), "utf8");
  const result = await minify(
    { [args.sourceRelativePath]: source },
    args.sourcemap
      ? {
          sourceMap: {
            filename: args.bundleRelativePath,
            url: `${args.bundleRelativePath}.map`,
            includeSources: true,
          },
        }
      : undefined,
  );
  if (!result.code) {
    throw new Error("terser failed to produce code");
  }
  await writeFile(join(args.rootDir, args.bundleRelativePath), `${result.code}\n`, "utf8");
  if (args.sourcemap) {
    if (!result.map) {
      throw new Error("terser failed to produce source map");
    }
    await writeFile(join(args.rootDir, `${args.bundleRelativePath}.map`), result.map, "utf8");
  }
}

async function createExternalBundleStrategyPluginPackage(): Promise<{
  manifestPath: string;
  pluginRoot: string;
}> {
  const pluginRoot = await mkdtemp(join(tmpdir(), "claude-code-index-external-plugin-"));
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify(
      {
        name: "external-bundle-plugin",
        version: "0.0.0",
        sourceStrategyPluginEntry: "./index.ts",
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(pluginRoot, "index.ts"),
    [
      "",
      "export function getSourceStrategyPlugins() {",
      "  return [{",
      "    kind: 'external-bundle',",
      "    detect({ headText, tailText, hasSourceMapComment }) {",
      "      if (hasSourceMapComment) return null",
      "      const text = `${headText}\\n${tailText}`",
      "      return text.includes('__external_bundle__')",
      "        ? { kind: 'external-bundle', confidence: 1, reason: 'external marker' }",
      "        : null",
      "    },",
      "    async expand({ file, tempRootDir }) {",
      "      const { mkdir, writeFile } = await import('fs/promises')",
      "      const { join } = await import('path')",
      "      const tempPath = join(tempRootDir, 'external-bundle', 'chunks', 'external.js')",
      "      await mkdir(join(tempRootDir, 'external-bundle', 'chunks'), { recursive: true })",
      "      await writeFile(tempPath, 'export function externalValue() { return 123 }\\n', 'utf8')",
      "      return {",
      "        cleanupPaths: [join(tempRootDir, 'external-bundle')],",
      "        units: [{",
      "          file: {",
      "            absolutePath: tempPath,",
      "            relativePath: 'chunks/external.js',",
      "            language: file.language,",
      "            originPath: file.relativePath,",
      "            originStartLine: 1,",
      "            originStartCharacter: 1,",
      "          },",
      "          originFile: file,",
      "          fingerprintPath: tempPath,",
      "          strategyKind: 'external-bundle',",
      "        }],",
      "      }",
      "    },",
      "  }]",
      "}",
      "",
    ].join("\n"),
    "utf8",
  )
  return {
    manifestPath: join(pluginRoot, ".codex-plugin", "plugin.json"),
    pluginRoot,
  }
}

describe("buildCodeIndex", () => {
  it("emits skeleton, json indexes, dot map, and skills for ts and python inputs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-code-index-"));

    try {
      await mkdir(join(rootDir, "src"), { recursive: true });

      await writeFile(
        join(rootDir, "service.ts"),
        `import { join } from 'path'
import { db } from './db'
import type { Cart, Order } from './types'
export class OrderService extends BaseService {
  constructor(private readonly paymentService: PaymentService, private readonly db: Database) {}
  async createOrder(userId: string, cart: Cart): Promise<Order> {
    join('orders', userId)
    await this.paymentService.charge(userId)
    return db.save(cart)
  }
}
export const helper = async (value: string): Promise<void> => {
  await logValue(value)
}
`,
        "utf8",
      );

      await writeFile(
        join(rootDir, "db.ts"),
        `export const db = {
  save(value: unknown): unknown {
    return value
  },
}
`,
        "utf8",
      );

      await writeFile(
        join(rootDir, "types.ts"),
        `export type Cart = {
  id: string
}

export type Order = {
  id: string
}
`,
        "utf8",
      );

      await writeFile(
        join(rootDir, "src", "utils.ts"),
        `export const formatOrder = 'format-order'
`,
        "utf8",
      );

      await writeFile(
        join(rootDir, "entry.ts"),
        `import React from 'react'
import { formatOrder } from 'src/utils.js'

export const ENTRY = formatOrder
`,
        "utf8",
      );

      await writeFile(
        join(rootDir, "worker.py"),
        `import os

class Worker(BaseWorker):
    def __init__(self, client: Client, repo: Repo):
        self.client = client
        self.repo = repo

    async def run(self, task_id: str) -> Result:
        await self.client.fetch(task_id)
        return self.repo.save(task_id)

def top_level(value: str) -> None:
    raise RuntimeError(value)
`,
        "utf8",
      );

      const result = await buildCodeIndex({
        rootDir,
        outputDir: join(rootDir, ".code_index"),
        workers: 2,
      });

      expect(result.manifest.moduleCount).toBe(6);
      expect(result.manifest.fileLimitReached).toBe(false);
      expect(result.incremental.cacheHits).toBe(0);
      expect(result.incremental.cacheMisses).toBe(6);
      expect(result.manifest.classCount).toBe(2);
      expect(result.manifest.functionCount).toBe(2);

      const serviceSkeleton = await readFile(
        join(rootDir, ".code_index", "skeleton", "service.py"),
        "utf8",
      );
      expect(serviceSkeleton).toContain("from __future__ import annotations");
      expect(serviceSkeleton).toContain("from .db import db");
      expect(serviceSkeleton).toContain("from .types import Cart, Order");
      expect(serviceSkeleton).toContain("class OrderService(BaseService):");
      expect(serviceSkeleton).toContain(
        "def __init__(self, paymentService: PaymentService, db: Database) -> None:",
      );
      expect(serviceSkeleton).toContain("self.paymentService = paymentService");
      expect(serviceSkeleton).toContain("self.db = db");
      expect(serviceSkeleton).toContain(
        "await self.paymentService.charge(...)",
      );
      expect(serviceSkeleton).toContain("return db.save(...)");
      expect(serviceSkeleton).toContain(
        "async def helper(value: str) -> None:",
      );
      expect(serviceSkeleton).toContain("await logValue(...)");

      const workerSkeleton = await readFile(
        join(rootDir, ".code_index", "skeleton", "worker.py"),
        "utf8",
      );
      expect(workerSkeleton).toContain("import os");
      expect(workerSkeleton).toContain("class Worker(BaseWorker):");
      expect(workerSkeleton).toContain(
        "def __init__(self, client: Client, repo: Repo) -> None:",
      );
      expect(workerSkeleton).toContain("self.client = client");
      expect(workerSkeleton).toContain("self.repo = repo");
      expect(workerSkeleton).toContain(
        "async def run(self, task_id: str) -> Result:",
      );
      expect(workerSkeleton).toContain("await self.client.fetch(...)");
      expect(workerSkeleton).toContain("return self.repo.save(...)");
      expect(workerSkeleton).toContain("raise RuntimeError(...)");
      expect(workerSkeleton).not.toContain("\n    RuntimeError(...)\n");

      const rootSkeleton = await readFile(
        join(rootDir, ".code_index", "skeleton", "__root__.py"),
        "utf8",
      );
      expect(rootSkeleton).toBe("...\n");

      const manifestText = await readFile(
        join(rootDir, ".code_index", "index", "manifest.json"),
        "utf8",
      );
      expect(manifestText).toContain('"moduleCount": 6');

      const edgesText = await readFile(
        join(rootDir, ".code_index", "index", "edges.jsonl"),
        "utf8",
      );
      expect(edgesText).toContain('"kind":"imports"');
      expect(edgesText).toContain('"kind":"calls"');

      const architectureDot = await readFile(
        join(rootDir, ".code_index", "index", "architecture.dot"),
        "utf8",
      );
      expect(architectureDot).toStartWith("digraph{");
      expect(architectureDot).not.toContain("subgraph");
      expect(architectureDot).not.toContain("color=");
      expect(architectureDot).not.toContain("shape=");
      expect(architectureDot).not.toContain("worker.py");
      expect(architectureDot).not.toContain("react");
      expect(architectureDot).not.toContain("path");
      expect(architectureDot).not.toContain("OrderService");

      const nodeToPath = new Map<string, string>();
      const fileEdges: string[] = [];
      for (const line of architectureDot.trim().split("\n")) {
        const nodeMatch = line.match(/^(n[0-9a-z]+)\[label="([^"]+)"\]$/);
        if (nodeMatch?.[1] && nodeMatch[2]) {
          nodeToPath.set(nodeMatch[1], nodeMatch[2]);
        }

        const edgeMatch = line.match(/^(n[0-9a-z]+)->(n[0-9a-z]+)$/);
        if (edgeMatch?.[1] && edgeMatch[2]) {
          const sourcePath = nodeToPath.get(edgeMatch[1]);
          const targetPath = nodeToPath.get(edgeMatch[2]);
          if (sourcePath && targetPath) {
            fileEdges.push(`${sourcePath}->${targetPath}`);
          }
        }
      }

      expect(fileEdges).toContain("entry.ts->src/utils.ts");
      expect(fileEdges).toContain("service.ts->db.ts");
      expect(fileEdges).toContain("service.ts->types.ts");

      const claudeSkillText = await readFile(
        join(rootDir, ".claude", "skills", "code-index", "SKILL.md"),
        "utf8",
      );
      expect(claudeSkillText).toContain('name: "code-index"');
      expect(claudeSkillText).toContain("when_to_use:");
      expect(claudeSkillText).toContain(
        "`./.code_index/index/architecture.dot`",
      );
      expect(claudeSkillText).toContain("`./.code_index/skeleton/`");
      expect(claudeSkillText).toContain(
        "This is a blocking first step whenever",
      );
      expect(claudeSkillText).toContain(
        "you must use this index before broad repo-wide Grep/Glob scans",
      );
      expect(claudeSkillText).toContain("If a file is missing from the DOT");
      expect(claudeSkillText).toContain(
        "valid Python with lightweight call stubs",
      );
      expect(claudeSkillText).toContain("code map only");
      expect(claudeSkillText).toContain("read the original source");
      expect(claudeSkillText).not.toContain("references.jsonl");
      expect(claudeSkillText).not.toContain("source_lines");

      const codexSkillText = await readFile(
        join(rootDir, ".codex", "skills", "code-index", "SKILL.md"),
        "utf8",
      );
      expect(codexSkillText).toContain('name: "code-index"');
      expect(codexSkillText).toContain("when_to_use:");
      expect(codexSkillText).toContain(
        "`./.code_index/index/architecture.dot`",
      );
      expect(codexSkillText).toContain("`./.code_index/index/summary.md`");
      expect(codexSkillText).toContain(
        "Only fall back to full source-file reads",
      );
      expect(codexSkillText).toContain(
        "valid Python with lightweight call stubs",
      );
      expect(codexSkillText).toContain("code map only");
      expect(codexSkillText).toContain("read the original source");
      expect(codexSkillText).not.toContain("references.jsonl");
      expect(codexSkillText).not.toContain("source_lines");

      const opencodeSkillText = await readFile(
        join(rootDir, ".opencode", "skills", "code-index", "SKILL.md"),
        "utf8",
      );
      expect(opencodeSkillText).toContain('name: "code-index"');
      expect(opencodeSkillText).toContain(
        "`./.code_index/index/architecture.dot`",
      );
      expect(opencodeSkillText).toContain("method-level detail");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("counts supported AST languages in the manifest and emits usable artifacts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-code-index-multi-lang-"));

    try {
      await mkdir(join(rootDir, "src"), { recursive: true });

      await writeFile(
        join(rootDir, "service.tsx"),
        `import React from 'react'
export function View() {
  return <div />
}
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "main.go"),
        `package main

import "fmt"

type Worker struct {}

func (w *Worker) Run(task string) string {
  fmt.Println(task)
  return task
}
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "main.rs"),
        `use std::fmt;

pub struct Worker;

impl Worker {
  pub fn run(&self, task: &str) -> &str {
    task
  }
}
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "Main.java"),
        `package demo;

import java.util.List;

public class Main {
  public static String run(String task) {
    return task;
  }
}
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "Main.hx"),
        `package demo;

import foo.Bar;

class Main {
  public static function run(task:String):String {
    return task;
  }
}
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "main.zig"),
        `const std = @import("std");

pub const Worker = struct {
  pub fn run(self: *Worker, task: []const u8) []const u8 {
    return task;
  }
};
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "main.c"),
        `#include <stdio.h>

int run(int value) {
  return value;
}
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "main.cpp"),
        `#include <vector>

class Worker {
public:
  int run(int value) { return value; }
};
`,
        "utf8",
      );

      const result = await buildCodeIndex({
        rootDir,
        outputDir: join(rootDir, ".code_index"),
        workers: 2,
      });

      expect(result.manifest.moduleCount).toBe(8);
      expect(result.manifest.languages.tsx).toBe(1);
      expect(result.manifest.languages.go).toBe(1);
      expect(result.manifest.languages.rust).toBe(1);
      expect(result.manifest.languages.java).toBe(1);
      expect(result.manifest.languages.haxe).toBe(1);
      expect(result.manifest.languages.zig).toBe(1);
      expect(result.manifest.languages.c).toBe(1);
      expect(result.manifest.languages.cpp).toBe(1);

      const modulesText = await readFile(
        join(rootDir, ".code_index", "index", "modules.jsonl"),
        "utf8",
      );
      expect(modulesText).toContain('"path":"service.tsx"');
      expect(modulesText).toContain('"lang":"tsx"');
      expect(modulesText).toContain('"path":"main.go"');
      expect(modulesText).toContain('"lang":"go"');
      expect(modulesText).toContain('"path":"main.c"');
      expect(modulesText).toContain('"lang":"c"');

      const summaryText = await readFile(
        join(rootDir, ".code_index", "index", "summary.md"),
        "utf8",
      );
      expect(summaryText).toContain("- tsx: 1");
      expect(summaryText).toContain("- go: 1");
      expect(summaryText).toContain("- rust: 1");
      expect(summaryText).toContain("- java: 1");
      expect(summaryText).toContain("- haxe: 1");
      expect(summaryText).toContain("- zig: 1");
      expect(summaryText).toContain("- c: 1");
      expect(summaryText).toContain("- cpp: 1");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("formats language counts in a stable order", () => {
    expect(
      formatCountSummary({
        rust: 1,
        go: 2,
        tsx: 3,
        c: 4,
      }),
    ).toBe("c: 4 | go: 2 | rust: 1 | tsx: 3");
  });

  it("skips heavy default ignore directories and reports when max-files is reached", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-code-index-limit-"));

    try {
      await mkdir(join(rootDir, "Source"), { recursive: true });
      await mkdir(join(rootDir, "Intermediate"), { recursive: true });
      await mkdir(join(rootDir, "ThirdParty"), { recursive: true });
      await mkdir(join(rootDir, ".index_bench"), { recursive: true });
      await mkdir(join(rootDir, ".code_index_cmp"), { recursive: true });

      await writeFile(
        join(rootDir, "Source", "game.ts"),
        `export const game = 1
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "Source", "engine.ts"),
        `export const engine = 2
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "Intermediate", "generated.ts"),
        `export const generated = true
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "ThirdParty", "dep.cpp"),
        `int dep() { return 1; }
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, ".index_bench", "generated.ts"),
        `export const generatedBench = true
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, ".code_index_cmp", "generated.ts"),
        `export const generatedCompare = true
`,
        "utf8",
      );

      const result = await buildCodeIndex({
        rootDir,
        outputDir: join(rootDir, ".code_index"),
        maxFiles: 1,
        workers: 2,
      });

      expect(result.manifest.moduleCount).toBe(1);
      expect(result.manifest.fileLimit).toBe(1);
      expect(result.manifest.fileLimitReached).toBe(true);

      const modulesText = await readFile(
        join(rootDir, ".code_index", "index", "modules.jsonl"),
        "utf8",
      );
      expect(modulesText).toContain('"path":"Source/engine.ts"');
      expect(modulesText).not.toContain("Intermediate/generated.ts");
      expect(modulesText).not.toContain("ThirdParty/dep.cpp");
      expect(modulesText).not.toContain(".index_bench/generated.ts");
      expect(modulesText).not.toContain(".code_index_cmp/generated.ts");

      const summaryText = await readFile(
        join(rootDir, ".code_index", "index", "summary.md"),
        "utf8",
      );
      expect(summaryText).toContain("- file_limit: 1");
      expect(summaryText).toContain("- file_limit_reached: yes");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reuses cached modules and only reparses changed files", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "claude-code-index-incremental-"),
    );

    try {
      await writeFile(
        join(rootDir, "alpha.ts"),
        `export const alpha = 1
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "beta.ts"),
        `export const beta = alpha + 1
`,
        "utf8",
      );

      const outputDir = join(rootDir, ".code_index");
      const firstResult = await buildCodeIndex({
        rootDir,
        outputDir,
        workers: 2,
      });

      expect(firstResult.incremental.cacheHits).toBe(0);
      expect(firstResult.incremental.cacheMisses).toBe(2);
      expect(firstResult.incremental.removedFiles).toBe(0);

      const alphaSkeletonPath = join(outputDir, "skeleton", "alpha.py");
      const betaSkeletonPath = join(outputDir, "skeleton", "beta.py");
      const rootSkeletonPath = join(outputDir, "skeleton", "__root__.py");
      const manifestPath = join(outputDir, "index", "manifest.json");
      const modulesIndexPath = join(outputDir, "index", "modules.jsonl");
      const symbolsIndexPath = join(outputDir, "index", "symbols.jsonl");
      const edgesIndexPath = join(outputDir, "index", "edges.jsonl");
      const summaryPath = join(outputDir, "index", "summary.md");
      const architecturePath = join(outputDir, "index", "architecture.dot");

      const alphaSkeletonBefore = await stat(alphaSkeletonPath);
      const betaSkeletonBefore = await stat(betaSkeletonPath);
      const rootSkeletonBefore = await stat(rootSkeletonPath);
      const manifestBefore = await stat(manifestPath);
      const modulesIndexBefore = await stat(modulesIndexPath);
      const symbolsIndexBefore = await stat(symbolsIndexPath);
      const edgesIndexBefore = await stat(edgesIndexPath);
      const summaryBefore = await stat(summaryPath);
      const architectureBefore = await stat(architecturePath);

      await new Promise((resolve) => setTimeout(resolve, 20));

      const secondResult = await buildCodeIndex({
        rootDir,
        outputDir,
        workers: 2,
      });

      expect(secondResult.incremental.cacheHits).toBe(2);
      expect(secondResult.incremental.cacheMisses).toBe(0);
      expect(secondResult.incremental.removedFiles).toBe(0);
      expect(secondResult.timings.buildEdgesMs).toBe(0);
      expect(secondResult.timings.writeIndexFilesMs).toBe(0);
      expect(secondResult.timings.writeSkillsMs).toBeGreaterThan(0);

      const alphaSkeletonNoChange = await stat(alphaSkeletonPath);
      const betaSkeletonNoChange = await stat(betaSkeletonPath);
      const rootSkeletonNoChange = await stat(rootSkeletonPath);
      const manifestNoChange = await stat(manifestPath);
      const modulesIndexNoChange = await stat(modulesIndexPath);
      const symbolsIndexNoChange = await stat(symbolsIndexPath);
      const edgesIndexNoChange = await stat(edgesIndexPath);
      const summaryNoChange = await stat(summaryPath);
      const architectureNoChange = await stat(architecturePath);

      expect(alphaSkeletonNoChange.mtimeMs).toBe(alphaSkeletonBefore.mtimeMs);
      expect(betaSkeletonNoChange.mtimeMs).toBe(betaSkeletonBefore.mtimeMs);
      expect(rootSkeletonNoChange.mtimeMs).toBe(rootSkeletonBefore.mtimeMs);
      expect(manifestNoChange.mtimeMs).toBe(manifestBefore.mtimeMs);
      expect(modulesIndexNoChange.mtimeMs).toBe(modulesIndexBefore.mtimeMs);
      expect(symbolsIndexNoChange.mtimeMs).toBe(symbolsIndexBefore.mtimeMs);
      expect(edgesIndexNoChange.mtimeMs).toBe(edgesIndexBefore.mtimeMs);
      expect(summaryNoChange.mtimeMs).toBe(summaryBefore.mtimeMs);
      expect(architectureNoChange.mtimeMs).toBe(architectureBefore.mtimeMs);

      await new Promise((resolve) => setTimeout(resolve, 20));
      await writeFile(
        join(rootDir, "beta.ts"),
        `export const beta = alpha + 2
`,
        "utf8",
      );

      const thirdResult = await buildCodeIndex({
        rootDir,
        outputDir,
        workers: 2,
      });

      expect(thirdResult.incremental.cacheHits).toBe(1);
      expect(thirdResult.incremental.cacheMisses).toBe(1);
      expect(thirdResult.incremental.removedFiles).toBe(0);

      const alphaSkeletonAfter = await stat(alphaSkeletonPath);
      const betaSkeletonAfter = await stat(betaSkeletonPath);
      expect(alphaSkeletonAfter.mtimeMs).toBe(alphaSkeletonBefore.mtimeMs);
      expect(betaSkeletonAfter.mtimeMs).toBeGreaterThan(
        betaSkeletonBefore.mtimeMs,
      );

      const cacheText = await readFile(
        join(outputDir, "module-cache.v1.json"),
        "utf8",
      );
      expect(cacheText).toContain('"relativePath":"alpha.ts"');
      expect(cacheText).toContain('"relativePath":"beta.ts"');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("updates the root gitignore with the generated index directory", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-code-index-gitignore-"));

    try {
      await writeFile(
        join(rootDir, ".gitignore"),
        "node_modules\n",
        "utf8",
      );
      await writeFile(
        join(rootDir, "main.ts"),
        `export const value = 1
`,
        "utf8",
      );

      const outputDir = join(rootDir, ".code_index");
      await buildCodeIndex({
        rootDir,
        outputDir,
        workers: 2,
      });

      const gitignoreAfterFirstBuild = await readFile(
        join(rootDir, ".gitignore"),
        "utf8",
      );
      expect(gitignoreAfterFirstBuild).toContain("node_modules");
      expect(gitignoreAfterFirstBuild).toContain("# code-index generated artifacts");
      expect(gitignoreAfterFirstBuild).toContain(".code_index");
      expect(gitignoreAfterFirstBuild).toContain(".claude/skills/code-index");
      expect(gitignoreAfterFirstBuild).toContain(".codex/skills/code-index");
      expect(gitignoreAfterFirstBuild).toContain(".opencode/skills/code-index");

      await buildCodeIndex({
        rootDir,
        outputDir,
        workers: 2,
      });

      const gitignoreAfterSecondBuild = await readFile(
        join(rootDir, ".gitignore"),
        "utf8",
      );
      expect(gitignoreAfterSecondBuild).toBe(gitignoreAfterFirstBuild);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("refreshes code-index skills even when source artifacts are fully reused", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-code-index-skill-"));

    try {
      await writeFile(
        join(rootDir, "alpha.ts"),
        `export const alpha = 1
`,
        "utf8",
      );

      const outputDir = join(rootDir, ".code_index");
      await buildCodeIndex({
        rootDir,
        outputDir,
        workers: 2,
      });

      const skillPath = join(
        rootDir,
        ".codex",
        "skills",
        "code-index",
        "SKILL.md",
      );
      await writeFile(skillPath, "STALE\n", "utf8");

      const result = await buildCodeIndex({
        rootDir,
        outputDir,
        workers: 2,
      });

      const skillText = await readFile(skillPath, "utf8");
      expect(result.incremental.cacheHits).toBe(1);
      expect(result.incremental.cacheMisses).toBe(0);
      expect(result.timings.writeIndexFilesMs).toBe(0);
      expect(result.timings.writeSkillsMs).toBeGreaterThan(0);
      expect(skillText).not.toBe("STALE\n");
      expect(skillText).toContain('name: "code-index"');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("removes stale skeleton files when indexed source files are deleted", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-code-index-delete-"));

    try {
      await writeFile(
        join(rootDir, "alpha.ts"),
        `export const alpha = 1
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "beta.ts"),
        `export const beta = alpha + 1
`,
        "utf8",
      );

      const outputDir = join(rootDir, ".code_index");
      await buildCodeIndex({
        rootDir,
        outputDir,
        workers: 2,
      });

      const betaSkeletonPath = join(outputDir, "skeleton", "beta.py");
      expect(existsSync(betaSkeletonPath)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 20));
      await rm(join(rootDir, "beta.ts"));

      const result = await buildCodeIndex({
        rootDir,
        outputDir,
        workers: 2,
      });

      expect(result.incremental.cacheHits).toBe(1);
      expect(result.incremental.cacheMisses).toBe(0);
      expect(result.incremental.removedFiles).toBe(1);
      expect(result.manifest.moduleCount).toBe(1);
      expect(existsSync(betaSkeletonPath)).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reports build progress across startup-relevant phases", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "claude-code-index-progress-"),
    );

    try {
      await writeFile(
        join(rootDir, "alpha.ts"),
        `export function alpha(): number {
  return beta()
}
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "beta.ts"),
        `export function beta(): number {
  return 1
}
`,
        "utf8",
      );

      const progress: CodeIndexBuildProgress[] = [];
      await buildCodeIndex({
        rootDir,
        outputDir: join(rootDir, ".code_index"),
        onProgress(event) {
          progress.push(event);
        },
        workers: 2,
      });

      expect(progress.length).toBeGreaterThan(0);
      expect(progress.some((event) => event.phase === "discover")).toBe(true);
      expect(progress.some((event) => event.phase === "parse")).toBe(true);
      expect(progress.some((event) => event.phase === "emit")).toBe(true);
      expect(progress.some((event) => event.phase === "complete")).toBe(true);

      const emitEvents = progress.filter((event) => event.phase === "emit");
      expect(emitEvents.some((event) => /Updating skeleton \d+\/2 modules/.test(event.message))).toBe(true);
      expect(emitEvents.some((event) => (event.completed ?? 0) < (event.total ?? 0))).toBe(true);
      expect(progress.at(-1)?.phase).toBe("complete");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("skips bundle output when no source strategy is enabled and indexes raw sources normally", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-code-index-strategy-skip-"));

    try {
      await writeFile(
        join(rootDir, "raw.ts"),
        `export function rawValue(): number {
  return 1
}
`,
        "utf8",
      );

      await mkdir(join(rootDir, "bundle-src"), { recursive: true });
      await writeFile(
        join(rootDir, "bundle-src", "entry.js"),
        `import {value} from './value.js'
console.log(value)
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "bundle-src", "value.js"),
        `export const value = 2
`,
        "utf8",
      );
      await buildWebpackFixture({
        rootDir,
        entryRelativePath: "bundle-src/entry.js",
        bundlePath: "bundle.js",
        sourcemap: false,
      });
      await rm(join(rootDir, "bundle-src"), { recursive: true, force: true });

      const result = await buildCodeIndex({
        rootDir,
        outputDir: join(rootDir, ".code_index"),
        workers: 2,
      });

      expect(result.manifest.moduleCount).toBe(1);
      expect(result.manifest.parseModes["ast-tree-sitter"] ?? 0).toBe(1);

      const modulesJsonl = await readFile(
        join(rootDir, ".code_index", "index", "modules.jsonl"),
        "utf8",
      );
      expect(modulesJsonl).toContain("raw.ts");
      expect(modulesJsonl).not.toContain("bundle-src/entry.js");
      expect(modulesJsonl).not.toContain("bundle.js");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("expands bundle sources when the matching strategy is enabled", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-code-index-strategy-expand-"));

    try {
      await mkdir(join(rootDir, "bundle-src"), { recursive: true });
      await writeFile(
        join(rootDir, "bundle-src", "entry.js"),
        `export class BundleThing {
  value() {
    return 42
  }
}
console.log(new BundleThing().value())
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "bundle-src", "value.js"),
        `export const value = 42
`,
        "utf8",
      );
      await buildWebpackFixture({
        rootDir,
        entryRelativePath: "bundle-src/entry.js",
        bundlePath: "bundle.js",
      });
      await rm(join(rootDir, "bundle-src"), { recursive: true, force: true });

      const result = await buildCodeIndex({
        rootDir,
        outputDir: join(rootDir, ".code_index"),
        workers: 2,
        sourceStrategyKinds: ["webpack"],
      });

      expect(result.manifest.moduleCount).toBe(1);
      expect(result.manifest.classCount).toBe(1);
      expect(result.manifest.parseModes["ast-tree-sitter"] ?? 0).toBe(1);

      const modulesJsonl = await readFile(
        join(rootDir, ".code_index", "index", "modules.jsonl"),
        "utf8",
      );
      expect(modulesJsonl).toContain('"origin_path":"bundle.js"');
      expect(modulesJsonl).toContain('"path":"chunks/bundle-001.js"');

      const skeleton = await readFile(
        join(rootDir, ".code_index", "skeleton", "chunks", "bundle-001.py"),
        "utf8",
      );
      expect(skeleton).toContain("class BundleThing:");
      expect(skeleton).toContain("def value(");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("expands real esbuild output when the esbuild strategy is enabled", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-code-index-esbuild-"));

    try {
      await mkdir(join(rootDir, "bundle-src"), { recursive: true });
      await writeFile(
        join(rootDir, "bundle-src", "entry.js"),
        `import {value} from './value.js'
console.log(value)
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "bundle-src", "value.js"),
        `export const value = 42
`,
        "utf8",
      );
      await buildEsbuildFixture({
        rootDir,
        entryRelativePath: "bundle-src/entry.js",
        bundlePath: "bundle.js",
        sourcemap: false,
      });
      await rm(join(rootDir, "bundle-src"), { recursive: true, force: true });

      const result = await buildCodeIndex({
        rootDir,
        outputDir: join(rootDir, ".code_index"),
        workers: 2,
        sourceStrategyKinds: ["esbuild"],
      });

      expect(result.manifest.moduleCount).toBe(2);
      expect(result.manifest.parseModes["ast-tree-sitter"] ?? 0).toBe(2);

      const modulesJsonl = await readFile(
        join(rootDir, ".code_index", "index", "modules.jsonl"),
        "utf8",
      );
      expect(modulesJsonl).toContain('"origin_path":"bundle.js"');
      expect(modulesJsonl).toContain('"path":"src/value.js"');
      expect(modulesJsonl).toContain('"path":"src/entry.js"');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("expands real terser output when the minified-js strategy is enabled", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-code-index-terser-"));

    try {
      await mkdir(join(rootDir, "bundle-src"), { recursive: true });
      await writeFile(
        join(rootDir, "bundle-src", "entry.js"),
        `function hello(name) {
  return 'hi ' + name
}
console.log(hello('world'))
`,
        "utf8",
      );
      await buildTerserFixture({
        rootDir,
        sourceRelativePath: "bundle-src/entry.js",
        bundleRelativePath: "bundle.js",
        sourcemap: false,
      });
      await rm(join(rootDir, "bundle-src"), { recursive: true, force: true });

      const result = await buildCodeIndex({
        rootDir,
        outputDir: join(rootDir, ".code_index"),
        workers: 2,
        sourceStrategyKinds: ["minified-js"],
      });

      expect(result.manifest.moduleCount).toBe(2);
      expect(result.manifest.parseModes["ast-tree-sitter"] ?? 0).toBe(2);

      const modulesJsonl = await readFile(
        join(rootDir, ".code_index", "index", "modules.jsonl"),
        "utf8",
      );
      expect(modulesJsonl).toContain('"origin_path":"bundle.js"');
      expect(modulesJsonl).toContain('"path":"chunks/bundle-001.js"');
      expect(modulesJsonl).toContain('"path":"chunks/bundle-002.js"');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("expands real vite output when the vite strategy is enabled", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-code-index-vite-"));

    try {
      await mkdir(join(rootDir, "app"), { recursive: true });
      await writeFile(
        join(rootDir, "app", "main.js"),
        `import('./lazy.js').then(m => console.log(m.value))
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "app", "lazy.js"),
        `export const value = 42
`,
        "utf8",
      );
      const { bundleFilePath, assetFiles } = await buildViteFixture({
        rootDir,
        entryRelativePath: "app/main.js",
        sourcemap: false,
      });
      expect(bundleFilePath).toContain("bundle-out/assets/index-");
      expect(assetFiles.some((name) => name.startsWith("lazy-") && name.endsWith(".js"))).toBe(true);
      await rm(join(rootDir, "app"), { recursive: true, force: true });

      const result = await buildCodeIndex({
        rootDir,
        outputDir: join(rootDir, ".code_index"),
        workers: 2,
        sourceStrategyKinds: ["vite"],
      });

      expect(result.manifest.moduleCount).toBe(0);
      expect(result.manifest.parseModes["ast-tree-sitter"] ?? 0).toBe(0);

      const modulesJsonl = await readFile(
        join(rootDir, ".code_index", "index", "modules.jsonl"),
        "utf8",
      );
      expect(modulesJsonl.trim()).toBe("");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("skips bundle output that carries a sourcemap even when a strategy is enabled", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-code-index-sourcemap-skip-"));

    try {
      await mkdir(join(rootDir, "bundle-src"), { recursive: true });
      await writeFile(
        join(rootDir, "bundle-src", "entry.js"),
        `import {value} from './value.js'
console.log(value)
`,
        "utf8",
      );
      await writeFile(
        join(rootDir, "bundle-src", "value.js"),
        `export const value = 42
`,
        "utf8",
      );
      await buildWebpackFixture({
        rootDir,
        entryRelativePath: "bundle-src/entry.js",
        bundlePath: "bundle.js",
        sourcemap: true,
      });
      await rm(join(rootDir, "bundle-src"), { recursive: true, force: true });

      const result = await buildCodeIndex({
        rootDir,
        outputDir: join(rootDir, ".code_index"),
        workers: 2,
        sourceStrategyKinds: ["webpack"],
      });

      expect(result.manifest.moduleCount).toBe(0);
      const modulesJsonl = await readFile(
        join(rootDir, ".code_index", "index", "modules.jsonl"),
        "utf8",
      );
      expect(modulesJsonl.trim()).toBe("");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("expands third-party minified js without sourcemaps using the first 1000 chars", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "claude-code-index-thirdparty-minified-"),
    );

    try {
      const distHead = (
        await readFile(join(process.cwd(), "dist", "augment.mjs"), "utf8")
      ).slice(0, 1000);

      await mkdir(join(rootDir, "bundle"), { recursive: true });
      await writeFile(join(rootDir, "bundle", "augment.mjs"), distHead, "utf8");

      const result = await buildCodeIndex({
        rootDir,
        outputDir: join(rootDir, ".code_index"),
        workers: 2,
      });

      expect(result.manifest.moduleCount).toBeGreaterThan(0);

      const modulesJsonl = await readFile(
        join(rootDir, ".code_index", "index", "modules.jsonl"),
        "utf8",
      );
      expect(modulesJsonl).toContain('"path":"chunks/augment-001.js"');

      const chunkSkeletonDir = join(
        rootDir,
        ".code_index",
        "skeleton",
        "chunks",
      );
      expect(existsSync(chunkSkeletonDir)).toBe(true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("loads and applies an external source strategy plugin manifest", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-code-index-external-plugin-"));
    let pluginRoot: string | undefined;

    try {
      const created = await createExternalBundleStrategyPluginPackage();
      const { manifestPath } = created;
      pluginRoot = created.pluginRoot;

      await writeFile(
        join(rootDir, "bundle.js"),
        [
          "/* __external_bundle__ */",
          "console.log('external bundle')",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await buildCodeIndex({
        rootDir,
        outputDir: join(rootDir, ".code_index"),
        sourceStrategyKinds: ["external-bundle"],
        sourceStrategyPluginManifests: [manifestPath],
      });

      expect(result.manifest.moduleCount).toBe(1);

      const modulesJsonl = await readFile(
        join(rootDir, ".code_index", "index", "modules.jsonl"),
        "utf8",
      );
      expect(modulesJsonl).toContain('"path":"chunks/external.js"');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
      if (pluginRoot) {
        await rm(pluginRoot, { recursive: true, force: true });
      }
    }
  });
});
