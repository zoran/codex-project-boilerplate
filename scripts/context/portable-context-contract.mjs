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
  "scripts/context/portable-context-contract.test.mjs",
  "scripts/context/refresh-context-index-on-stop.mjs",
  "scripts/context/refresh-context-index-on-stop.sh",
  "scripts/context/search-context.mjs",
  "scripts/context/source-policy.mjs",
  "scripts/context/terminal-output.mjs",
  "scripts/context/terminal-output.test.mjs",
  "scripts/goals/goal-publication-precondition.mjs",
  "scripts/goals/goal-publication-precondition.test.mjs",
  "scripts/repository/source-inventory.mjs",
  "scripts/repository/git-runtime-isolation.mjs",
  "scripts/repository/product-roots.mjs",
  "scripts/repository/sensitive-paths.mjs",
  "scripts/repository/source-inventory-git-environment.test.mjs",
  "scripts/repository/stable-file-snapshot.mjs",
  "scripts/repository/stable-file-snapshot.test.mjs",
  "scripts/repository/validate-transfer-source.mjs",
  "scripts/setup/check-prereqs.sh",
  "scripts/setup/codex-launcher.test.mjs",
  "scripts/setup/export-project.sh",
  "scripts/setup/setup-regression-fixtures.mjs",
  "scripts/setup/setup-regression.test.mjs",
  "scripts/setup/staged-project-validator.test.mjs",
  "scripts/setup/start-codex.sh",
  "scripts/setup/validate-staged-project.mjs",
  "scripts/setup/validate-codex-bootstrap.sh",
  "scripts/setup/validate-codex-config.mjs",
  "scripts/verify/format-project.mjs",
  "scripts/verify/adaptive-surfaces.mjs",
  "scripts/verify/adaptive-surfaces.test.mjs",
  "scripts/verify/image-assets.mjs",
  "scripts/verify/image-assets.test.mjs",
  "scripts/verify/path-hygiene.mjs",
  "scripts/verify/secret-content-scan.mjs",
  "scripts/verify/secret-patterns.mjs",
  "scripts/verify/secrets.mjs",
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
      "active repository-local Git exclude rule",
      "root-owned Git metadata",
      "hidden index flags",
      "fresh temporary index",
      "repository-local FSMonitor",
      "caller-selected stage path",
      "trusted project Stop hook refreshes changed sources",
      supportedCodexStartCommand,
    ],
  ],
  [
    "README.md",
    [
      supportedCodexStartCommand,
      "pnpm goal:new",
      "active repository-local Git exclude rule",
      "root-owned Git metadata",
      "fresh temporary index",
      "hidden index flags",
      "repository-local FSMonitor",
      "caller-selected stage path",
      "project-local Codex Stop hook refreshes changed indexed sources",
    ],
  ],
  [
    "docs/context-index.md",
    [
      "opportunistic maintenance",
      "strictly read-only",
      "source classifications",
      "project-local Codex Stop hook",
      "repair-safe incremental freshness path",
    ],
  ],
  [
    ".codex/README.md",
    [
      supportedCodexStartCommand,
      "repository-root Codex runtime",
      "mise-pinned Node.js runtime to refresh changed sources once per turn",
    ],
  ],
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
      "active repository-local Git exclude rule",
      "root-owned Git metadata",
      "hidden index flags",
      "fresh temporary index",
      "repository-local FSMonitor",
      "caller-selected stage path",
      "locally hash-trusted project Stop hook refreshes changed sources",
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
      "active repository-local Git exclude rule",
      "root-owned Git metadata",
      "hidden index flags",
      "fresh temporary index",
      "repository-local FSMonitor",
      "caller-selected stage path",
      "project Stop hook refreshes changed sources once per Codex turn",
      supportedCodexStartCommand,
    ],
  ],
  [
    ".agents/skills/context-retrieval/SKILL.md",
    [
      "broad orientation",
      "A failed `rg` search",
      "read every matched source",
      "Stop hook owns turn-boundary freshness",
    ],
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
      "project Stop hook maintains it at turn boundaries",
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
    [
      "whole-repository course check",
      "push the current branch",
      "pnpm goal:new",
      "active repository-local Git exclude rule",
      "root-owned Git metadata",
      "fresh temporary index",
      "hidden index flags",
    ],
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
      "--exclude-per-directory=.gitignore",
    ],
  ],
  [
    "scripts/repository/git-runtime-isolation.mjs",
    [
      "resolveOwnedGitMetadata",
      "GIT_OPTIONAL_LOCKS",
      "core.fsmonitor=false",
      "core.trustctime=true",
      "core.checkStat=default",
      "core.splitIndex=false",
      "core.sparseCheckout=false",
      "index.sparse=false",
      "core.untrackedCache=false",
      "bound Git directory and worktree",
    ],
  ],
  [
    "scripts/repository/source-inventory-git-environment.test.mjs",
    [
      "XDG_CONFIG_HOME",
      "ambient-hidden.ts",
      "local-hidden.ts",
      "core.fsmonitor",
      "core.worktree",
      "Git-less roots nested below another repository",
      "owned Git worktree gitfiles",
    ],
  ],
  [
    "scripts/repository/stable-file-snapshot.mjs",
    ["O_NOFOLLOW", "path binding change", "readStableRepositoryFile"],
  ],
  ["scripts/setup/check-prereqs.sh", [supportedCodexStartCommand]],
  ["scripts/setup/export-project.sh", ['node "$stage/scripts/setup/validate-staged-project.mjs"']],
  [
    "scripts/setup/codex-launcher.test.mjs",
    ["FAKE_CODEX_UPDATE_STATUS", "CODEX_HOME", "Bash-3.2-compatible"],
  ],
  ["scripts/setup/setup-regression-fixtures.mjs", ["validPortableConfig", "temporaryRoot"]],
  [
    "scripts/setup/staged-project-validator.test.mjs",
    ["caller-selected-stage", "validator-hardlink", "potential secret material"],
  ],
  [
    "scripts/setup/validate-staged-project.mjs",
    [
      "resolveOwnedStagedProjectRoot",
      "process.argv.length !== 2",
      "identity changed during validation",
      "scriptStats.nlink !== 1n",
    ],
  ],
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
  [
    "scripts/context/portable-context-contract.test.mjs",
    [
      "before bootstrap",
      "During normal verification",
      "After each tool call",
      "will never",
      "`.context-index/`",
      "never\\nupdated by the Stop hook",
    ],
  ],
  ["scripts/context/terminal-output.mjs", ["redactLocalPaths", "<local-path>"]],
  ["scripts/setup/start-codex.sh", ["codex update", 'CODEX_HOME="$root"']],
  [
    "scripts/goals/goal-publication-precondition.mjs",
    [
      "resolveOwnedGitMetadata",
      "GIT_INDEX_FILE",
      'read-tree", "HEAD',
      'ls-files", "-v", "-z',
      "skip-worktree and assume-unchanged",
      "@{upstream}",
      "HEAD...@{upstream}",
      "Cannot start a new goal",
    ],
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

const hookMutationContractFiles = new Set([
  ".agents/skills/context-retrieval/SKILL.md",
  ".agents/skills/project-implementation/SKILL.md",
  ".codex/README.md",
  "AGENTS.md",
  "README.md",
  "docs/context-index.md",
  "docs/project.md",
  "instructions.md",
]);

const leadingQualifiedHookScope =
  /(?:\b(?:before|until|prior to)\s+(?:the\s+)?(?:initial\s+)?bootstrap\b|\bpre-bootstrap\b|\bcontext:check\b|\bpre-push\b|\b(?:during|for)\s+(?:normal\s+|ordinary\s+)?verification\b|\bduring\s+pre-push\b|\bafter\s+(?:each|every|an?\s+individual|a\s+single)\s+tool\s+(?:call|invocation)\b)[\s,:-]*$/iu;
const trailingQualifiedHookScope =
  /^[\s,:-]*(?:(?:before|until|prior to)\s+(?:the\s+)?(?:initial\s+)?bootstrap|(?:during|for)\s+(?:normal\s+|ordinary\s+)?verification|during\s+pre-push|after\s+(?:each|every|an?\s+individual|a\s+single)\s+tool\s+(?:call|invocation))\b/iu;
const contradictoryHookIndexContracts = [
  /\b(?:the\s+)?(?:(?:project(?:-local)?|stop)\s+)?hooks?\s+(?:never|will\s+never|will\s+not|do\s+not|does\s+not|must\s+not|cannot)\s+(?:ever\s+)?(?:touch(?:es)?|modif(?:y|ies)|mutat(?:e|es)|write(?:s)?(?:\s+to)?|update(?:s)?|refresh(?:es)?|change(?:s)?)\s+(?:the\s+)?(?:(?:context\s+)?index|`?\.context-index\/?`?)(?![\p{L}\p{N}_])/giu,
  /\b(?:the\s+)?(?:(?:context\s+)?index|`?\.context-index\/?`?)(?![\p{L}\p{N}_])[^.;!?]{0,24}\b(?:never|not)\s+(?:be\s+)?(?:touched|modified|mutated|written(?:\s+to)?|updated|refreshed|changed)\s+by\s+(?:the\s+)?(?:(?:project(?:-local)?|stop)\s+)?hooks?\b/giu,
];

function claimHasQualifiedScope(clause, match) {
  const before = clause.slice(0, match.index);
  const after = clause.slice(match.index + match[0].length);
  return leadingQualifiedHookScope.test(before) || trailingQualifiedHookScope.test(after);
}

export function hasContradictoryStopHookIndexContract(content) {
  const clauses = content.replace(/\s+/g, " ").split(/[.!?;](?:\s+|$)|,?\s+(?:but|however)\s+/iu);
  for (const clause of clauses) {
    for (const pattern of contradictoryHookIndexContracts) {
      for (const match of clause.matchAll(pattern)) {
        if (!claimHasQualifiedScope(clause, match)) return true;
      }
    }
  }
  return false;
}

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
    if (
      hookMutationContractFiles.has(relativePath) &&
      hasContradictoryStopHookIndexContract(content)
    ) {
      findings.push(
        `portable context contract rejects a contradictory Stop-hook index contract in ${relativePath}`,
      );
    }
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
