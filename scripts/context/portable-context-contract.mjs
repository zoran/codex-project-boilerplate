import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  repositoryCodexHomeGitignoreBehaviorFindings,
  repositoryCodexHomeGitignoreFindings,
} from "../repository/source-inventory.mjs";

export const supportedCodexStartCommand = 'codex update && CODEX_HOME="$PWD" codex --cd "$PWD"';

export const portableContextContractFiles = Object.freeze([
  ".agents/skills/context-retrieval/SKILL.md",
  ".agents/skills/context-retrieval/agents/openai.yaml",
  ".agents/skills/project-implementation/SKILL.md",
  ".agents/skills/resume-project/SKILL.md",
  ".agents/skills/task-quality/SKILL.md",
  ".codex/agents/default.toml",
  ".codex/agents/explorer.toml",
  ".codex/agents/worker.toml",
  ".codex/hooks.json",
  ".codex/README.md",
  ".gitignore",
  "AGENTS.md",
  "README.md",
  "docs/context-index.md",
  "docs/project.md",
  "instructions.md",
  "package.json",
  "scripts/context/check-context-index.mjs",
  "scripts/context/clean-context-index.mjs",
  "scripts/context/context-maintenance-safety.mjs",
  "scripts/context/context-maintenance.mjs",
  "scripts/context/context-maintenance.test.mjs",
  "scripts/context/context-lifecycle.test.mjs",
  "scripts/context/context-worker-output.mjs",
  "scripts/context/index-codebase.mjs",
  "scripts/context/portable-context-contract.mjs",
  "scripts/context/refresh-context-index-on-stop.mjs",
  "scripts/context/refresh-context-index-on-stop.sh",
  "scripts/context/search-context.mjs",
  "scripts/context/source-policy.mjs",
  "scripts/context/terminal-output.mjs",
  "scripts/context/terminal-output.test.mjs",
  "scripts/goals/goal-publication-precondition.mjs",
  "scripts/goals/goal-publication-precondition.test.mjs",
  "scripts/repository/source-inventory.mjs",
  "scripts/repository/stable-file-snapshot.mjs",
  "scripts/repository/stable-file-snapshot.test.mjs",
  "scripts/setup/check-prereqs.sh",
  "scripts/setup/codex-launcher.test.mjs",
  "scripts/setup/setup-regression-fixtures.mjs",
  "scripts/setup/start-codex.sh",
  "scripts/setup/validate-codex-bootstrap.sh",
  "scripts/setup/validate-codex-config.mjs",
  "scripts/verify/format-project.mjs",
  "scripts/verify/adaptive-surfaces.mjs",
  "scripts/verify/adaptive-surfaces.test.mjs",
  "scripts/verify/image-assets.mjs",
  "scripts/verify/image-assets.test.mjs",
  "scripts/verify/secret-patterns.mjs",
  "scripts/verify/surface-quality.mjs",
  "scripts/verify/surface-quality.test.mjs",
]);

const requiredContent = new Map([
  [
    "AGENTS.md",
    [
      "no reliable exact",
      "cross-file",
      "context:search",
      "matched source",
      "whole-repository course check",
      "every significant implementation milestone",
      "pre-descent mask",
      "pnpm goal:new",
      "pushes the current branch",
      supportedCodexStartCommand,
    ],
  ],
  ["README.md", [supportedCodexStartCommand, "pnpm goal:new"]],
  [
    "docs/context-index.md",
    ["opportunistic maintenance", "strictly read-only", "source classifications"],
  ],
  [".codex/README.md", [supportedCodexStartCommand, "repository-root Codex runtime"]],
  [".codex/hooks.json", ["Stop", "refresh-context-index-on-stop.sh"]],
  [
    "docs/project.md",
    [
      supportedCodexStartCommand,
      "repository-root Codex runtime",
      "whole-repository course checks",
      "every significant implementation milestone",
      "pre-descent mask",
      "pnpm goal:new",
      "pushes the current branch",
    ],
  ],
  [
    "instructions.md",
    [
      "no reliable exact",
      "cross-file",
      "context:search",
      "matched source",
      "whole-repository course check",
      "every significant implementation milestone",
      "pre-descent mask",
      "pnpm goal:new",
      "pushes the current branch",
      supportedCodexStartCommand,
    ],
  ],
  [
    ".agents/skills/context-retrieval/SKILL.md",
    ["broad orientation", "A failed `rg` search", "read every matched source"],
  ],
  [
    ".agents/skills/context-retrieval/agents/openai.yaml",
    ["$context-retrieval", "allow_implicit_invocation: true"],
  ],
  [
    ".agents/skills/project-implementation/SKILL.md",
    [
      "no reliable exact anchor",
      "context:search",
      "matched source",
      "whole-repository course check",
      "every significant implementation milestone",
    ],
  ],
  [
    ".agents/skills/resume-project/SKILL.md",
    [
      "no reliable exact anchor",
      "context:search",
      "matched source",
      "whole-repository course check",
      "Every resume and context-recovery point",
    ],
  ],
  [
    ".agents/skills/task-quality/SKILL.md",
    ["whole-repository course check", "push the current branch", "pnpm goal:new"],
  ],
  [
    ".codex/agents/default.toml",
    ["context:search", "matched source", "whole-repository course check"],
  ],
  [
    ".codex/agents/explorer.toml",
    ["context:search", "matched source", "whole-repository course check"],
  ],
  [
    ".codex/agents/worker.toml",
    ["context:search", "matched source", "whole-repository course check"],
  ],
  [
    "scripts/repository/source-inventory.mjs",
    [
      "repositoryCodexHomeGitignorePatterns",
      "gitlessPreDescentExcludePatterns",
      "pre-descent.exclude",
      "repository-root Codex runtime or cache state",
    ],
  ],
  [
    "scripts/repository/stable-file-snapshot.mjs",
    ["O_NOFOLLOW", "path binding change", "readStableRepositoryFile"],
  ],
  ["scripts/setup/check-prereqs.sh", [supportedCodexStartCommand]],
  [
    "scripts/setup/codex-launcher.test.mjs",
    ["FAKE_CODEX_UPDATE_STATUS", "CODEX_HOME", "Bash-3.2-compatible"],
  ],
  ["scripts/setup/setup-regression-fixtures.mjs", ["validPortableConfig", "temporaryRoot"]],
  [
    "scripts/context/context-maintenance.mjs",
    ["maintainContextIndex", "selectedModelRevisionDirectory"],
  ],
  ["scripts/context/context-maintenance-safety.mjs", ["refused hardlinked", "validateRemovalTree"]],
  [
    "scripts/context/context-worker-output.mjs",
    ["sanitizeMultilineForTerminal(output, repositoryRoot)", 'stdio: "pipe"'],
  ],
  [
    "scripts/context/refresh-context-index-on-stop.sh",
    ["CONTEXT_INDEX_SANITIZED_WORKER", "mise exec --locked", "failure_message"],
  ],
  [
    "scripts/context/refresh-context-index-on-stop.mjs",
    ["runAsSanitizedContextWorker", "ensureFreshIndex"],
  ],
  ["scripts/context/terminal-output.mjs", ["redactLocalPaths", "<local-path>"]],
  ["scripts/setup/start-codex.sh", ["codex update", 'CODEX_HOME="$root"']],
  [
    "scripts/goals/goal-publication-precondition.mjs",
    ["GIT_OPTIONAL_LOCKS", "@{upstream}", "HEAD...@{upstream}", "Cannot start a new goal"],
  ],
  [
    "scripts/setup/validate-codex-bootstrap.sh",
    ["required_codex_ignore_patterns", "runtime_probe_paths", "portable_probe_paths"],
  ],
  [
    "scripts/setup/validate-codex-config.mjs",
    ["repositoryCodexHomeGitignoreBehaviorFindings", "parseProjectHooks"],
  ],
  ["scripts/verify/format-project.mjs", ["listActiveFiles"]],
  ["scripts/verify/image-assets.mjs", ["listActiveFiles", "normalizedActiveFiles"]],
]);

const exactStartCommandFiles = new Set([
  ".codex/README.md",
  "AGENTS.md",
  "README.md",
  "docs/project.md",
  "instructions.md",
  "scripts/setup/check-prereqs.sh",
]);

export function portableContextContractFindings({ repositoryRoot }) {
  const findings = [];
  for (const relativePath of portableContextContractFiles) {
    const absolutePath = path.join(repositoryRoot, ...relativePath.split("/"));
    if (!existsSync(absolutePath)) {
      findings.push(`portable context contract is missing ${relativePath}`);
      continue;
    }
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      findings.push(`portable context contract requires a regular file: ${relativePath}`);
      continue;
    }
    const content = readFileSync(absolutePath, "utf8");
    if (exactStartCommandFiles.has(relativePath) && !content.includes(supportedCodexStartCommand)) {
      findings.push(
        `portable context contract requires ${relativePath} to include the exact supported Codex start command`,
      );
    }
    const normalizedContent = content.replace(/\s+/g, " ");
    for (const expected of requiredContent.get(relativePath) ?? []) {
      if (!normalizedContent.toLowerCase().includes(expected.replace(/\s+/g, " ").toLowerCase())) {
        findings.push(`portable context contract requires ${relativePath} to include ${expected}`);
      }
    }
  }
  const packagePath = path.join(repositoryRoot, "package.json");
  if (existsSync(packagePath) && lstatSync(packagePath).isFile()) {
    try {
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
      for (const [name, command] of [
        ["context:check", "node scripts/context/check-context-index.mjs"],
        ["context:clean", "node scripts/context/clean-context-index.mjs"],
        ["context:index", "node scripts/context/index-codebase.mjs"],
        ["context:search", "node scripts/context/search-context.mjs"],
        ["goal:new", "node scripts/goals/goal-publication-precondition.mjs"],
      ]) {
        if (packageJson.scripts?.[name] !== command) {
          findings.push(`portable context contract requires package.json script ${name}`);
        }
      }
    } catch {
      findings.push("portable context contract requires valid package.json JSON");
    }
  }
  const gitignorePath = path.join(repositoryRoot, ".gitignore");
  if (existsSync(gitignorePath) && lstatSync(gitignorePath).isFile()) {
    findings.push(
      ...repositoryCodexHomeGitignoreFindings(readFileSync(gitignorePath, "utf8")).map(
        (finding) => `portable context contract ${finding}`,
      ),
      ...repositoryCodexHomeGitignoreBehaviorFindings({ root: repositoryRoot }).map(
        (finding) => `portable context contract ${finding}`,
      ),
    );
  }
  return findings;
}

export function assertPortableContextContract(options) {
  const findings = portableContextContractFindings(options);
  if (findings.length > 0) {
    throw new Error(
      ["Portable context contract failed:", ...findings.map((item) => `- ${item}`)].join("\n"),
    );
  }
}
