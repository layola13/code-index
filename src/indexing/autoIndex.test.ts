import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  _resetAutoIndexStateForTesting,
  flushPendingAutoIndexForTesting,
  notifyAutoIndexFileMutation,
} from "./autoIndex.js";
import { buildCodeIndex } from "./build.js";

afterEach(async () => {
  await flushPendingAutoIndexForTesting();
  _resetAutoIndexStateForTesting();
});

describe("autoIndex", () => {
  it("rebuilds the nearest initialized index after a file mutation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-code-auto-index-"));

    try {
      await writeFile(
        join(rootDir, "alpha.ts"),
        `export function alpha(): number {
  return helperOne()
}
`,
        "utf8",
      );

      const outputDir = join(rootDir, ".code_index");
      await buildCodeIndex({
        rootDir,
        outputDir,
        workers: 2,
      });

      await writeFile(
        join(rootDir, "alpha.ts"),
        `export function alpha(): number {
  return helperTwo()
}
`,
        "utf8",
      );

      notifyAutoIndexFileMutation(join(rootDir, "alpha.ts"));
      await flushPendingAutoIndexForTesting();

      const skeleton = await readFile(
        join(outputDir, "skeleton", "alpha.py"),
        "utf8",
      );
      expect(skeleton).toContain("return helperTwo(...)");
      expect(skeleton).not.toContain("return helperOne(...)");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("removes stale skeleton files after a deleted file is reported", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "claude-code-auto-index-delete-"),
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
      await buildCodeIndex({
        rootDir,
        outputDir,
        workers: 2,
      });

      const betaFilePath = join(rootDir, "beta.ts");
      const betaSkeletonPath = join(outputDir, "skeleton", "beta.py");
      expect(existsSync(betaSkeletonPath)).toBe(true);

      await rm(betaFilePath, { force: true });
      notifyAutoIndexFileMutation(betaFilePath);
      await flushPendingAutoIndexForTesting();

      expect(existsSync(betaSkeletonPath)).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
