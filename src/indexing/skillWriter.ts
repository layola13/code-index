import { mkdir, rm, writeFile } from "fs/promises";
import { join, relative } from "path";

export type CodeIndexSkillPaths = {
  claude: string;
  codex: string;
  opencode: string;
};

export function resolveCodeIndexSkillPaths(args: {
  rootDir: string;
}): CodeIndexSkillPaths {
  return {
    claude: join(args.rootDir, ".claude", "skills", "code-index", "SKILL.md"),
    codex: join(args.rootDir, ".codex", "skills", "code-index", "SKILL.md"),
    opencode: join(
      args.rootDir,
      ".opencode",
      "skills",
      "code-index",
      "SKILL.md",
    ),
  };
}

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function formatProjectPath(rootDir: string, targetPath: string): string {
  const relativePath = toPosixPath(relative(rootDir, targetPath));
  if (!relativePath) {
    return ".";
  }
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("/")
  ) {
    return toPosixPath(targetPath);
  }
  return `./${relativePath}`;
}

function formatFrontmatterValue(value: string): string {
  return JSON.stringify(value);
}

function renderSkillMarkdown(args: {
  description: string;
  name: string;
  rootDir: string;
  outputDir: string;
  whenToUse: string;
}): string {
  const outputPath = formatProjectPath(args.rootDir, args.outputDir);
  const architecturePath = `${outputPath}/index/architecture.dot`;
  const summaryPath = `${outputPath}/index/summary.md`;
  const skeletonPath = `${outputPath}/skeleton`;
  const indexPath = `${outputPath}/__index__.py`;
  const modulesPath = `${outputPath}/index/modules.jsonl`;
  const symbolsPath = `${outputPath}/index/symbols.jsonl`;

  return [
    "---",
    `name: ${formatFrontmatterValue(args.name)}`,
    `description: ${formatFrontmatterValue(args.description)}`,
    `when_to_use: ${formatFrontmatterValue(args.whenToUse)}`,
    "---",
    "",
    "# Code Index",
    "",
    "## Instructions",
    `- This is a blocking first step whenever \`${outputPath}/\` already exists and you need repository structure, dependency tracing, symbol lookup, or implementation-file discovery.`,
    `- Start with \`${architecturePath}\` for the smallest file-level dependency map. Outgoing edges show what a file depends on; incoming edges show likely impact.`,
    `- Then use \`${indexPath}\` for entry points, top directories, and high-priority symbols.`,
    `- Read \`${summaryPath}\` for a human-readable overview.`,
    `- Browse \`${skeletonPath}/\` when you need method-level detail; skeleton functions include concise stub calls instead of full method bodies.`,
    "- Treat the code index and skeleton as a code map only. After they identify candidate files, read the original source before asserting implementation details, quoting behavior, or editing code.",
    `- Use \`${modulesPath}\` and \`${symbolsPath}\` only when you need exact module or symbol-level detail.`,
    "- In large repositories, you must use this index before broad repo-wide Grep/Glob scans or raw source-file sweeps until the index proves stale or the needed detail is missing.",
    "- If a file is missing from the DOT, no internal file-level dependency edge was resolved for it; jump straight to the skeleton or JSON index.",
    "- The skeleton is valid Python with lightweight call stubs, inheritance, and constructor assignments for easier grep and AST-based lookup.",
    "- The skeleton is not the source of truth for exact logic, syntax, comments, formatting, or language-specific edge cases; confirm against the original files before making precise code claims.",
    "- Only fall back to full source-file reads when the index is stale, missing, or insufficient for the question at hand.",
    "- If the index is stale after edits, rerun `/index`.",
    "",
  ].join("\n");
}

export async function writeCodeIndexSkills(args: {
  outputDir: string;
  rootDir: string;
}): Promise<CodeIndexSkillPaths> {
  const paths = resolveCodeIndexSkillPaths({
    rootDir: args.rootDir,
  });

  await rm(join(args.rootDir, ".claude", "code_index"), {
    recursive: true,
    force: true,
  });
  await rm(join(args.rootDir, ".agent", "codex_index"), {
    recursive: true,
    force: true,
  });

  await mkdir(join(args.rootDir, ".claude", "skills", "code-index"), {
    recursive: true,
  });
  await mkdir(join(args.rootDir, ".codex", "skills", "code-index"), {
    recursive: true,
  });
  await mkdir(join(args.rootDir, ".opencode", "skills", "code-index"), {
    recursive: true,
  });

  const claudeDescription =
    `Use the generated code index under ${formatProjectPath(args.rootDir, args.outputDir)} as a code map to inspect repo structure, follow imports or calls, and narrow source reads before touching implementation files.`;
  const codexDescription =
    `Use the generated code index under ${formatProjectPath(args.rootDir, args.outputDir)} as a code map to inspect repo structure, follow imports or calls, and narrow source reads before editing implementation files.`;
  const opencodeDescription =
    `Use the generated code index under ${formatProjectPath(args.rootDir, args.outputDir)} as a code map to inspect repo structure, navigate entry points, and find implementation files.`;
  const whenToUse =
    "Use this as a blocking first step when a code index already exists and the task involves repository analysis, architecture tracing, symbol lookup, dependency follow-up, or locating implementation files. In large repos, use it before broad Grep/Glob scans or repo-wide source reads unless the index is stale or missing.";

  await writeFile(
    paths.claude,
    renderSkillMarkdown({
      name: "code-index",
      description: claudeDescription,
      rootDir: args.rootDir,
      outputDir: args.outputDir,
      whenToUse,
    }),
    "utf8",
  );

  await writeFile(
    paths.codex,
    renderSkillMarkdown({
      name: "code-index",
      description: codexDescription,
      rootDir: args.rootDir,
      outputDir: args.outputDir,
      whenToUse,
    }),
    "utf8",
  );

  await writeFile(
    paths.opencode,
    renderSkillMarkdown({
      name: "code-index",
      description: opencodeDescription,
      rootDir: args.rootDir,
      outputDir: args.outputDir,
      whenToUse,
    }),
    "utf8",
  );

  return paths;
}
