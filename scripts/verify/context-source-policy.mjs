import { existsSync } from "node:fs";
import process from "node:process";
import { discoverSourceFiles, isActiveSourcePath, isIgnored } from "../context/source-policy.mjs";

const discovered = discoverSourceFiles();
const indexedPaths = new Set(discovered.files.map((file) => file.path));
const skippedPaths = new Set(discovered.skipped.map((file) => file.path));
const failures = [];

const requiredPaths = [
  "README.md",
  "mise.toml",
  "scripts/context/source-policy.mjs",
  ".agents/skills/context-retrieval/SKILL.md",
  ".agents/skills/security-review/SKILL.md",
];
if (existsSync(".github/workflows/ci.yml")) requiredPaths.push(".github/workflows/ci.yml");

for (const requiredPath of requiredPaths) {
  if (!indexedPaths.has(requiredPath)) {
    failures.push(`source policy must include ${requiredPath}`);
  }
}

for (const excludedPath of [
  "mise.lock",
  ".agents/skills/context-retrieval/agents/openai.yaml",
  ".codex/skills/.system/imagegen/SKILL.md",
]) {
  if (indexedPaths.has(excludedPath) || skippedPaths.has(excludedPath)) {
    failures.push(`source policy must exclude ${excludedPath}`);
  }
}

for (const backupPath of [
  "backup/example.md",
  "backups/example.md",
  "docs/backup/example.md",
  "docs/backups/example.md",
  "docs/example.bak.md",
  "scripts/example.bak.mjs",
  "scripts/example.mjs.bak",
]) {
  if (!isIgnored(backupPath)) {
    failures.push(`source policy must ignore backup path pattern: ${backupPath}`);
  }
  if (isActiveSourcePath(backupPath) && !isIgnored(backupPath)) {
    failures.push(`source policy must not treat backup path as active: ${backupPath}`);
  }
  if (indexedPaths.has(backupPath) || skippedPaths.has(backupPath)) {
    failures.push(`source policy must exclude backup path from discovery: ${backupPath}`);
  }
}

for (const processPath of [
  "docs/planning/current-goal.md",
  "docs/task-plan.md",
  "docs/tasks/implementation.md",
  "docs/reviews/final-audit.md",
  "docs/handoffs/session.md",
  "docs/archive/completed-context.md",
  "docs/history/session.md",
  "PROJECT_PLAN.md",
  "notes/reviews/final-audit.md",
]) {
  if (!isIgnored(processPath)) {
    failures.push(`context source policy must exclude repository process artifact: ${processPath}`);
  }
}

if (discovered.sourceMode === "git-tracked") {
  failures.push("source policy should include non-ignored untracked files by default");
}

if (failures.length > 0) {
  console.error("Context source policy verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Context source policy verification passed.");
