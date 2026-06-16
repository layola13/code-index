import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { runIndexHook } from "../scripts/run-index-hook.ts";

describe("runIndexHook logging", () => {
  test("writes start, skip, and finish records to the configured log file", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "code-index-run-hook-"));
    const logPath = join(rootDir, "logs", "hook.log");
    const stateDir = join(rootDir, "state");

    try {
      await mkdir(join(rootDir, "project"), { recursive: true });

      const exitCode = await runIndexHook({
        rawInput: JSON.stringify({
          cwd: join(rootDir, "project"),
          hook_event_name: "PostToolUse",
          session_id: "session-1",
          turn_id: "turn-1",
        }),
        processCwd: "/tmp/unused-process-cwd",
        logPath,
        stateDir,
        buildCodeIndexImpl: async () => {
          throw new Error("boom");
        },
        now: () => new Date("2026-05-19T12:00:00.000Z"),
      });

      expect(exitCode).toBe(1);

      const log = await readFile(logPath, "utf8");
      expect(log).toContain("hook-start event=PostToolUse");
      expect(log).toContain(`resolvedCwd=${JSON.stringify(join(rootDir, "project"))}`);
      expect(log).toContain('session="session-1"');
      expect(log).toContain('turn="turn-1"');
      expect(log).toContain('status=failure');
      expect(log).toContain('error="boom"');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("logs skip records when the resolved cwd is missing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "code-index-run-hook-skip-"));
    const logPath = join(rootDir, "logs", "hook.log");
    const stateDir = join(rootDir, "state");

    try {
      const exitCode = await runIndexHook({
        rawInput: JSON.stringify({
          cwd: join(rootDir, "missing"),
          hook_event_name: "SessionStart",
        }),
        logPath,
        stateDir,
        statSyncImpl: () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        now: () => new Date("2026-05-19T12:00:00.000Z"),
      });

      expect(exitCode).toBe(0);

      const log = await readFile(logPath, "utf8");
      expect(log).toContain("hook-start event=SessionStart");
      expect(log).toContain("reason=missing");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("passes the configured worker count to the index build", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "code-index-run-hook-workers-"));
    const logPath = join(rootDir, "logs", "hook.log");
    const stateDir = join(rootDir, "state");
    const workspaceDir = join(rootDir, "project");

    try {
      await mkdir(workspaceDir, { recursive: true });

      let buildArgs: { rootDir?: string; outputDir?: string; workers?: number } | undefined;
      const exitCode = await runIndexHook({
        rawInput: JSON.stringify({
          cwd: workspaceDir,
          hook_event_name: "SessionStart",
        }),
        logPath,
        stateDir,
        env: {
          CODE_INDEX_HOOK_WORKERS: "3",
        },
        buildCodeIndexImpl: async (args) => {
          buildArgs = args;
        },
        now: () => new Date("2026-05-19T12:00:00.000Z"),
      });

      expect(exitCode).toBe(0);
      expect(buildArgs).toEqual({
        rootDir: workspaceDir,
        outputDir: `${workspaceDir}/.code_index`,
        workers: 3,
      });

      const log = await readFile(logPath, "utf8");
      expect(log).toContain("workers=3");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("skips concurrent work while a build is already running", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "code-index-run-hook-busy-"));
    const logPath = join(rootDir, "logs", "hook.log");
    const stateDir = join(rootDir, "state");
    const workspaceDir = join(rootDir, "project");

    try {
      await mkdir(workspaceDir, { recursive: true });

      let buildCalls = 0;
      let buildEntered = false;
      let releaseBuild: (() => void) | undefined;
      const buildCanFinish = new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      const waitFor = async (predicate: () => boolean): Promise<void> => {
        const deadline = Date.now() + 1000;
        while (!predicate()) {
          if (Date.now() > deadline) {
            throw new Error("timed out waiting for the first build to start");
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };

      const buildCodeIndexImpl = async () => {
        buildCalls += 1;
        buildEntered = true;
        await buildCanFinish;
      };

      const firstRun = runIndexHook({
        rawInput: JSON.stringify({
          cwd: workspaceDir,
          hook_event_name: "PostToolUse",
        }),
        logPath,
        stateDir,
        buildCodeIndexImpl,
        now: () => new Date("2026-05-19T12:00:00.000Z"),
      });

      await waitFor(() => buildEntered);

      const secondRun = runIndexHook({
        rawInput: JSON.stringify({
          cwd: workspaceDir,
          hook_event_name: "PostToolUse",
        }),
        logPath,
        stateDir,
        buildCodeIndexImpl,
        now: () => new Date("2026-05-19T12:00:00.000Z"),
      });

      releaseBuild?.();

      await expect(firstRun).resolves.toBe(0);
      await expect(secondRun).resolves.toBe(0);
      expect(buildCalls).toBe(1);

      const log = await readFile(logPath, "utf8");
      expect(log).toContain("reason=busy");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("throttles repeated rebuilds within one minute", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "code-index-run-hook-throttle-"));
    const logPath = join(rootDir, "logs", "hook.log");
    const stateDir = join(rootDir, "state");
    const workspaceDir = join(rootDir, "project");

    try {
      await mkdir(workspaceDir, { recursive: true });

      let buildCalls = 0;
      const buildCodeIndexImpl = async () => {
        buildCalls += 1;
      };
      const t0 = new Date("2026-05-19T12:00:00.000Z");
      const t0Plus30s = new Date("2026-05-19T12:00:30.000Z");
      const t0Plus61s = new Date("2026-05-19T12:01:01.000Z");

      await expect(
        runIndexHook({
          rawInput: JSON.stringify({
            cwd: workspaceDir,
            hook_event_name: "PostToolUse",
          }),
          logPath,
          stateDir,
          buildCodeIndexImpl,
          now: () => t0,
        }),
      ).resolves.toBe(0);

      await expect(
        runIndexHook({
          rawInput: JSON.stringify({
            cwd: workspaceDir,
            hook_event_name: "PostToolUse",
          }),
          logPath,
          stateDir,
          buildCodeIndexImpl,
          now: () => t0Plus30s,
        }),
      ).resolves.toBe(0);

      await expect(
        runIndexHook({
          rawInput: JSON.stringify({
            cwd: workspaceDir,
            hook_event_name: "PostToolUse",
          }),
          logPath,
          stateDir,
          buildCodeIndexImpl,
          now: () => t0Plus61s,
        }),
      ).resolves.toBe(0);

      expect(buildCalls).toBe(2);

      const log = await readFile(logPath, "utf8");
      expect(log).toContain("reason=cooldown");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
