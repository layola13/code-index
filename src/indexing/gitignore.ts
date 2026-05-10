import { readFile, writeFile } from "fs/promises";
import { dirname, relative } from "path";

const MANAGED_BLOCK_START = "# code-index generated artifacts";
const MANAGED_BLOCK_END = "# end code-index generated artifacts";

function normalizeEntry(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/g, "");
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function resolveGitignoreEntry(rootDir: string, targetPath: string): string | null {
  const relativePath = normalizeEntry(relative(rootDir, targetPath));
  if (
    !relativePath ||
    relativePath === "." ||
    relativePath.startsWith("..") ||
    relativePath.startsWith("/")
  ) {
    return null;
  }

  return `${relativePath}/`;
}

function splitLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized) {
    return [];
  }
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function joinLines(lines: readonly string[], newline: string): string {
  if (lines.length === 0) {
    return "";
  }
  return `${lines.join(newline)}${newline}`;
}

function renderGitignoreContent(
  content: string,
  entries: readonly string[],
): string | null {
  const normalizedEntries = dedupeStrings(
    entries.map(entry => normalizeEntry(entry)).filter(Boolean),
  );
  if (normalizedEntries.length === 0) {
    return null;
  }

  const normalizedContent = content.replace(/\r\n/g, "\n");
  const lines = splitLines(content);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const startIndex = lines.indexOf(MANAGED_BLOCK_START);
  const endIndex =
    startIndex >= 0 ? lines.indexOf(MANAGED_BLOCK_END, startIndex + 1) : -1;

  if (startIndex >= 0 && endIndex >= startIndex) {
    const updatedLines = [
      ...lines.slice(0, startIndex),
      MANAGED_BLOCK_START,
      ...normalizedEntries,
      MANAGED_BLOCK_END,
      ...lines.slice(endIndex + 1),
    ];
    const updatedContent = joinLines(updatedLines, newline);
    return updatedContent === normalizedContent ? null : updatedContent;
  }

  const existingEntries = new Set(
    lines.map(line => normalizeEntry(line)).filter(Boolean),
  );
  const entriesToAdd = normalizedEntries.filter(
    entry => !existingEntries.has(entry),
  );
  if (entriesToAdd.length === 0) {
    return null;
  }

  const updatedLines =
    lines.length === 0
      ? [MANAGED_BLOCK_START, ...entriesToAdd, MANAGED_BLOCK_END]
      : lines[lines.length - 1] === ""
        ? [...lines, MANAGED_BLOCK_START, ...entriesToAdd, MANAGED_BLOCK_END]
        : [...lines, "", MANAGED_BLOCK_START, ...entriesToAdd, MANAGED_BLOCK_END];
  return joinLines(updatedLines, newline);
}

export function resolveCodeIndexGitignoreEntries(args: {
  outputDir: string;
  rootDir: string;
  skillPaths: readonly string[];
}): string[] {
  const entries = [
    resolveGitignoreEntry(args.rootDir, args.outputDir),
    ...args.skillPaths.map(skillPath =>
      resolveGitignoreEntry(args.rootDir, dirname(skillPath)),
    ),
  ].filter((value): value is string => Boolean(value));

  return dedupeStrings(entries);
}

export async function ensureCodeIndexGitignore(args: {
  entries: readonly string[];
  rootDir: string;
}): Promise<void> {
  const gitignorePath = `${args.rootDir}/.gitignore`;
  let content = "";

  try {
    content = await readFile(gitignorePath, "utf8");
  } catch {
    content = "";
  }

  const updated = renderGitignoreContent(content, args.entries);
  if (updated === null) {
    return;
  }

  await writeFile(gitignorePath, updated, "utf8");
}
