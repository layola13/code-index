import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { runIndexHook } from "../scripts/run-index-hook.ts";

describe("runIndexHook logging", () => {
  test("writes start, skip, and finish records to the configured log file", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "code-index-run-hook-"));
    const logPath = join(rootDir, "logs", "hook.log");

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

    try {
      const exitCode = await runIndexHook({
        rawInput: JSON.stringify({
          cwd: join(rootDir, "missing"),
          hook_event_name: "SessionStart",
        }),
        logPath,
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
});
